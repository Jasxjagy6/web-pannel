/**
 * Instagram per-session risk score (Phase 3 / B16).
 *
 * The risk score is a single 0..1 number that summarises how likely a
 * session is to die in the next ~24 hours. It is computed from
 * `ig_detection_events` aggregates plus a few static features
 * (account age, proxy/locale coherence) and is persisted into
 * `sessions.platform_state.riskScore`.
 *
 * Formula (matches IG_ANTI_BAN_PROPOSAL §B16):
 *
 *   risk = 0.40 * checkpoint_count_last_7d
 *        + 0.25 * feedback_required_count_last_7d
 *        + 0.20 * action_blocked_count_last_7d
 *        + 0.10 * (1 / max(1, account_age_days / 30))
 *        + 0.05 * (1 if proxy_country != session locale hint else 0)
 *
 * Each event-count contributor is **clipped to [0, 1]** before being
 * multiplied by its weight (so 50 checkpoints isn't 50× — it's just 1
 * full unit of that contributor). The result is clamped to [0, 1].
 *
 * Callers:
 *   - `gateOnRisk(session)` is invoked at the top of
 *     scrape.createScrapeJob, messaging.sendBulk, and
 *     accountSettings.update — it throws a 403 with code='RISK_TOO_HIGH'
 *     if the score is above the configurable deny threshold (default
 *     0.7). The threshold is read from system_settings:
 *       risk.instagram.deny_threshold
 *   - `computeAndPersist(sessionId)` is exposed for an admin "recompute
 *     all" endpoint and for the daily cron the operator may add later.
 */

'use strict';

const { pool } = require('../../config/database');
const logger = require('../../utils/logger');
const detectionEvents = require('./detectionEvents');
const systemSettings = require('../../services/systemSettingsService');

const DEFAULT_DENY_THRESHOLD = 0.7;

// Per-event-kind weights. The contributor is min(count / divisor, 1) so
// a single event of a kind already meaningfully impacts the score
// (divisor=1 makes the kind binary; divisor=3 gives a softer ramp).
const KIND_WEIGHTS = [
  { kind: 'checkpoint',         weight: 0.40, divisor: 1 },
  { kind: 'feedback_required',  weight: 0.25, divisor: 2 },
  { kind: 'action_blocked',     weight: 0.20, divisor: 2 },
];

function _clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function _accountAgeDays(session) {
  if (!session || !session.created_at) return null;
  const t = new Date(session.created_at).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 86400000;
}

/**
 * Pure compute step. Takes the inputs (so it's easy to unit-test) and
 * returns { score, components: {...} }.
 *
 *   _computeFromInputs({
 *     counts: { checkpoint: 1, feedback_required: 0, action_blocked: 2 },
 *     accountAgeDays: 12,
 *     proxyCountry: 'IN',
 *     localeRegion:  'IN',
 *   })
 */
function _computeFromInputs({
  counts = {},
  accountAgeDays = null,
  proxyCountry = null,
  localeRegion = null,
} = {}) {
  const components = {};
  let score = 0;
  for (const { kind, weight, divisor } of KIND_WEIGHTS) {
    const n = Number(counts[kind] || 0);
    const contrib = _clamp01(n / divisor) * weight;
    components[kind] = { count: n, weight, contrib: Number(contrib.toFixed(4)) };
    score += contrib;
  }

  // Account age contributor. Younger accounts get a bigger penalty;
  // 30+ days asymptotes to ~0.10 weight × 1.0 = 0.10.
  const ageDays = Number.isFinite(accountAgeDays) ? Math.max(0, accountAgeDays) : 30;
  const ageContrib = (1 / Math.max(1, ageDays / 30)) * 0.10;
  components.account_age = {
    days: Number(ageDays.toFixed(1)),
    contrib: Number(_clamp01(ageContrib).toFixed(4)),
  };
  score += _clamp01(ageContrib);

  // Geo-mismatch contributor. We only fire it if both sides are known
  // AND they differ — unknown values (proxy without geo, session
  // without locale) shouldn't penalise the score.
  let geoMismatch = 0;
  if (proxyCountry && localeRegion) {
    const a = String(proxyCountry).toLowerCase();
    const b = String(localeRegion).toLowerCase();
    if (a && b && a !== b && !a.includes(b) && !b.includes(a)) {
      geoMismatch = 0.05;
    }
  }
  components.geo_mismatch = {
    proxy_country: proxyCountry || null,
    locale_region: localeRegion || null,
    contrib: geoMismatch,
  };
  score += geoMismatch;

  return { score: Number(_clamp01(score).toFixed(4)), components };
}

/**
 * Read the proxy country guess from the session's pinned locale or a
 * proxy-url heuristic. We don't make a network call — we rely on the
 * locale's `regionHint` (set at upload time by proxies.assignBestForSession)
 * and the proxy URL hostname for a ".in"/".us"/etc. fallback.
 */
function _proxyCountryFromSession(session) {
  if (!session) return null;
  const ps = session.platform_state || {};
  if (ps.proxy && ps.proxy.country) return String(ps.proxy.country).toLowerCase();
  if (ps.locale && ps.locale.proxy_country) {
    return String(ps.locale.proxy_country).toLowerCase();
  }
  if (session.proxy_url) {
    try {
      const u = new URL(session.proxy_url);
      const tld = (u.hostname || '').split('.').pop();
      if (tld && tld.length === 2) return tld.toLowerCase();
    } catch (_e) { /* invalid url, ignore */ }
  }
  return null;
}

function _localeRegionFromSession(session) {
  if (!session) return null;
  const ps = session.platform_state || {};
  const loc = ps.locale || null;
  if (!loc) return null;
  if (loc.regionHint) return String(loc.regionHint).toLowerCase();
  if (loc.language && /_/.test(String(loc.language))) {
    return String(loc.language).split('_').pop().toLowerCase();
  }
  return null;
}

async function _loadSession(sessionId) {
  const r = await pool.query(
    `SELECT id, user_id, username, proxy_url, platform_state, created_at
       FROM sessions
      WHERE id = $1 AND platform = 'instagram'`,
    [sessionId]
  );
  return r.rows[0] || null;
}

/**
 * Compute the risk score for a session. Reads detection-event counts
 * from the last 7 days plus the session row's static features.
 * Returns `{ score, components }` and does NOT persist.
 */
async function compute(sessionId) {
  const session = await _loadSession(sessionId);
  if (!session) {
    return { score: 0, components: { reason: 'session_not_found' } };
  }
  const counts = await detectionEvents.countByKindForSession(sessionId, 7);
  return _computeFromInputs({
    counts,
    accountAgeDays: _accountAgeDays(session),
    proxyCountry: _proxyCountryFromSession(session),
    localeRegion: _localeRegionFromSession(session),
  });
}

/**
 * Compute + persist into `sessions.platform_state.riskScore`. Returns
 * the new `{ score, components, computedAt }` snapshot.
 */
async function computeAndPersist(sessionId) {
  const out = await compute(sessionId);
  const snapshot = {
    score: out.score,
    components: out.components,
    computed_at: new Date().toISOString(),
  };
  try {
    await pool.query(
      `UPDATE sessions
          SET platform_state = COALESCE(platform_state, '{}'::jsonb)
                              || jsonb_build_object('riskScore', $2::jsonb),
              updated_at = NOW()
        WHERE id = $1 AND platform = 'instagram'`,
      [sessionId, JSON.stringify(snapshot)]
    );
  } catch (err) {
    logger.warn(`IG.riskScore.persist failed for session=${sessionId}: ${err.message}`);
  }
  return snapshot;
}

async function _denyThreshold() {
  try {
    const v = await systemSettings.getSetting('risk.instagram.deny_threshold');
    if (v == null) return DEFAULT_DENY_THRESHOLD;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_DENY_THRESHOLD;
  } catch (_e) {
    return DEFAULT_DENY_THRESHOLD;
  }
}

/**
 * Throws a 403 if the session's risk score exceeds the deny threshold.
 * Otherwise persists the freshly-computed score so the operator's UI
 * always shows a recent value.
 *
 * `session` may be a row with at least `id`. If less is provided we
 * load the row from the DB.
 */
async function gateOnRisk(session, opts = {}) {
  if (!session) return;
  const sessionId = typeof session === 'object' ? session.id : session;
  if (!sessionId) return;
  const snapshot = await computeAndPersist(sessionId);
  const threshold = opts.threshold || (await _denyThreshold());
  if (snapshot.score > threshold) {
    const e = new Error(
      `Instagram session ${sessionId} risk score ${snapshot.score.toFixed(2)} ` +
      `> deny threshold ${threshold}. Drivers: ${_topDrivers(snapshot.components)}. ` +
      `Resolve checkpoints / feedback_required errors before resuming jobs on ` +
      `this session, or lower risk.instagram.deny_threshold to override.`
    );
    e.statusCode = 403;
    e.code = 'RISK_TOO_HIGH';
    e.kind = 'forbidden';
    e.details = { score: snapshot.score, threshold, components: snapshot.components };
    throw e;
  }
  return snapshot;
}

function _topDrivers(components) {
  if (!components) return 'none';
  const entries = Object.entries(components)
    .map(([k, v]) => [k, Number(v && v.contrib) || 0])
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (entries.length === 0) return 'none';
  return entries.map(([k, c]) => `${k}=${c.toFixed(2)}`).join(', ');
}

module.exports = {
  compute,
  computeAndPersist,
  gateOnRisk,
  DEFAULT_DENY_THRESHOLD,
  // Exposed for unit tests.
  _computeFromInputs,
};
