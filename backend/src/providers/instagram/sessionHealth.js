/**
 * Instagram session health + warm-up.
 *
 * Goal: keep cookie-uploaded sessions ALIVE indefinitely instead of
 * letting IG age them out or flag them as bots.
 *
 * Two pieces:
 *
 *   1. `runHealthCheck(sessionId, userId)` — single cheap probe through
 *      the session's bound proxy + browser-grade headers. Updates
 *      `sessions.warmup_state` (state machine), `last_warmup_at` and
 *      `behavior_log`.
 *
 *   2. `startWarmupScheduler()` — process-wide `setInterval` that
 *      every 60s picks one session whose `last_warmup_at` is older
 *      than the configured stale window (default 25-35 min, jittered)
 *      and runs a probe on it. One session at a time, no bursts.
 *
 * State machine stored in `warmup_state.state`:
 *   - `active`           — last probe succeeded; safe to scrape
 *   - `warming`          — probe currently in flight
 *   - `needs_attention`  — IG returned checkpoint / login_required.
 *                          Worker WILL NOT touch this session again
 *                          until the operator solves the challenge
 *                          on a trusted device and re-uploads.
 *   - `dead`             — repeated login_required across multiple
 *                          probes; cookies are gone.
 *
 * The state machine never auto-recovers from `needs_attention` /
 * `dead` — the operator must re-upload. Auto-recovery would just
 * keep hammering a flagged session and deepen the block.
 */

const logger = require('../../utils/logger');
const { pool } = require('../../config/database');
const { igFetch, sessionContext } = require('./igFetch');

const HEALTH_PROBE_URL =
  'https://www.instagram.com/api/v1/accounts/edit/web_form_data/';
const HEALTH_PROBE_FALLBACK_URL =
  'https://www.instagram.com/api/v1/accounts/current_user/?edit=true';

// Pick a session whose last warm-up was longer ago than this window.
// Jittered per-session so the cron doesn't fire all probes at the
// same minute mark.
const WARMUP_STALE_MIN_MS = 25 * 60 * 1000;
const WARMUP_STALE_MAX_MS = 35 * 60 * 1000;
// Outer scheduler tick — the per-session jitter window does the
// real spacing work, this just picks "is anything due now?".
const SCHEDULER_TICK_MS = 60 * 1000;

let _schedulerTimer = null;
let _schedulerRunning = false;

/**
 * Read the IG session row + decrypted blob in one shot. Returns null
 * if the session doesn't exist or isn't an IG session.
 */
async function _loadSession(sessionId) {
  const r = await pool.query(
    `SELECT id, user_id, platform, username, status, is_logged_in,
            proxy_url, session_data, platform_state,
            warmup_state, last_warmup_at
       FROM sessions
      WHERE id = $1 AND platform = 'instagram'`,
    [sessionId]
  );
  return r.rows[0] || null;
}

async function _saveWarmupState(sessionId, patch, opts = {}) {
  const cols = ['warmup_state = COALESCE(warmup_state, \'{}\'::jsonb) || $2::jsonb'];
  const params = [sessionId, JSON.stringify(patch)];
  let p = 3;
  if (opts.markWarmedNow) {
    cols.push(`last_warmup_at = NOW()`);
  }
  if (opts.flipLoggedIn !== undefined) {
    cols.push(`is_logged_in = $${p++}`);
    params.push(!!opts.flipLoggedIn);
  }
  if (opts.status) {
    cols.push(`status = $${p++}`);
    params.push(opts.status);
  }
  await pool.query(
    `UPDATE sessions SET ${cols.join(', ')}, updated_at = NOW()
      WHERE id = $1`,
    params
  );
}

async function _logBehavior(sessionId, action, succeeded, errorOrDetails) {
  try {
    let errorCode = null;
    let errorMessage = null;
    let details = null;
    if (succeeded) {
      details = errorOrDetails || null;
    } else if (errorOrDetails && typeof errorOrDetails === 'object') {
      errorCode = errorOrDetails.kind || errorOrDetails.code || null;
      errorMessage = errorOrDetails.message || String(errorOrDetails);
    }
    await pool.query(
      `INSERT INTO behavior_log
         (session_id, action, succeeded, error_code, error_message, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        sessionId,
        action,
        succeeded,
        errorCode ? errorCode.slice(0, 64) : null,
        errorMessage ? errorMessage.slice(0, 1000) : null,
        details ? JSON.stringify(details) : null,
      ]
    );
  } catch (err) {
    logger.warn(`IG.health: failed to write behavior_log row: ${err.message}`);
  }
}

/**
 * Run a single health probe against IG with the session's proxy +
 * cookies. Returns `{ ok: true, profile }` on success, otherwise
 * `{ ok: false, kind, error }`.
 *
 * Always updates the row's warmup_state + last_warmup_at — even on
 * error — so the operator can see the failure in the UI.
 */
async function runHealthCheck(sessionId, opts = {}) {
  const session = await _loadSession(sessionId);
  if (!session) {
    return { ok: false, kind: 'not_found', error: 'Session not found' };
  }

  await _saveWarmupState(sessionId, {
    state: 'warming',
    last_check_started_at: new Date().toISOString(),
  });

  let ctx;
  try {
    ctx = await sessionContext(session);
  } catch (err) {
    await _saveWarmupState(
      sessionId,
      {
        state: 'dead',
        last_error: err.message,
        last_error_kind: 'decrypt_failed',
        last_failed_at: new Date().toISOString(),
      },
      { flipLoggedIn: false, status: 'expired', markWarmedNow: true }
    );
    await _logBehavior(sessionId, 'health_check', false, err);
    return { ok: false, kind: 'decrypt_failed', error: err.message };
  }
  if (!ctx.cookieHeader) {
    await _saveWarmupState(
      sessionId,
      {
        state: 'dead',
        last_error: 'Session has no cookies',
        last_error_kind: 'login_required',
        last_failed_at: new Date().toISOString(),
      },
      { flipLoggedIn: false, status: 'expired', markWarmedNow: true }
    );
    await _logBehavior(sessionId, 'health_check', false, {
      kind: 'login_required',
      message: 'no cookies on row',
    });
    return { ok: false, kind: 'login_required', error: 'Session has no cookies' };
  }

  // Try web_form_data first (cheap, returns username). Fall back to
  // accounts/current_user if IG doesn't like the first endpoint —
  // this is what real browsers do during an account-settings page
  // load, so it looks innocuous.
  let json = null;
  let lastErr = null;
  for (const url of [HEALTH_PROBE_URL, HEALTH_PROBE_FALLBACK_URL]) {
    try {
      json = await igFetch(ctx, url, {
        referer: 'https://www.instagram.com/accounts/edit/',
        logErrors: false,
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      // login_required / checkpoint are terminal — don't try the
      // fallback, it'll just say the same thing.
      if (err.kind === 'login_required' || err.kind === 'checkpoint') break;
    }
  }

  if (!json) {
    const kind = (lastErr && lastErr.kind) || 'network';
    const isAttentionState =
      kind === 'checkpoint' || kind === 'login_required';
    const newState = isAttentionState
      ? (kind === 'login_required' ? 'dead' : 'needs_attention')
      : 'active'; // transient network error — don't flip state
    await _saveWarmupState(
      sessionId,
      {
        state: newState,
        last_error: lastErr ? lastErr.message : 'Unknown error',
        last_error_kind: kind,
        last_failed_at: new Date().toISOString(),
      },
      {
        markWarmedNow: true,
        ...(isAttentionState
          ? { flipLoggedIn: kind === 'login_required' ? false : undefined,
              status: kind === 'login_required' ? 'expired' : 'checkpoint' }
          : {}),
      }
    );
    await _logBehavior(sessionId, 'health_check', false, lastErr);
    // Phase 3.B15 — detection-event with the warm-up probe context
    // so the admin dashboard distinguishes "IG flagged this in a
    // probe" from "IG flagged this in a real job".
    try {
      // eslint-disable-next-line global-require
      const detectionEvents = require('./detectionEvents');
      detectionEvents.record({
        sessionId,
        userId: session.user_id || null,
        eventKind: kind,
        apiPath: 'health_check',
        httpStatus: lastErr && lastErr.statusCode ? lastErr.statusCode : null,
        responseBody: lastErr && lastErr.message,
        requestFingerprint: { action_class: 'read', source: 'sessionHealth' },
      }).catch(() => {});
    } catch (_recErr) { /* swallow */ }
    return { ok: false, kind, error: lastErr ? lastErr.message : 'Unknown error' };
  }

  // Successful probe. Pull the username from whichever endpoint
  // responded — both shapes are supported.
  const username =
    (json.form_data && json.form_data.username) ||
    (json.user && json.user.username) ||
    null;
  await _saveWarmupState(
    sessionId,
    {
      state: 'active',
      last_ok_at: new Date().toISOString(),
      last_ok_username: username,
      last_error: null,
      last_error_kind: null,
    },
    { markWarmedNow: true, flipLoggedIn: true, status: 'active' }
  );
  await _logBehavior(sessionId, 'health_check', true, { username });
  if (opts.verbose) {
    logger.info(`IG.health: session ${sessionId} OK (username=${username || '?'})`);
  }
  return { ok: true, username };
}

/**
 * Pick the next session due for a warm-up probe and run it. Skips
 * sessions whose warmup_state.state is `needs_attention` or `dead`
 * (those need operator intervention before we touch them again).
 *
 * One session per tick. Returns the session id we touched (or null).
 */
async function _runOneDueProbe() {
  // Per-session jitter: the SQL window is the smaller of the two,
  // and we additionally roll a random 0-WARMUP_STALE_MAX_MS-WARMUP_STALE_MIN_MS
  // for each candidate so two sessions don't always probe in the
  // exact same order.
  const r = await pool.query(
    `SELECT id, COALESCE(last_warmup_at, '1970-01-01') AS last_warmup_at,
            warmup_state
       FROM sessions
      WHERE platform = 'instagram'
        AND COALESCE(is_logged_in, FALSE) = TRUE
        AND COALESCE(warmup_state->>'state', 'active')
            NOT IN ('needs_attention', 'dead', 'warming')
        AND (last_warmup_at IS NULL
             OR last_warmup_at < NOW() - ($1 || ' milliseconds')::interval)
      ORDER BY last_warmup_at ASC NULLS FIRST
      LIMIT 5`,
    [WARMUP_STALE_MIN_MS]
  );
  if (r.rows.length === 0) return null;

  // Phase 2.B10 — load full platform_state for each candidate so we
  // can filter out sessions that are outside their active-hours window.
  // Probing a session at 03:00 local time is a textbook automation tell.
  // eslint-disable-next-line global-require
  const activeHours = require('./activeHours');
  // eslint-disable-next-line global-require
  const behaviorPacing = require('./behaviorPacing');
  const ids = r.rows.map((x) => x.id);
  const detailRows = await pool.query(
    `SELECT id, platform_state FROM sessions WHERE id = ANY($1::int[])`,
    [ids]
  );
  const detailById = new Map(detailRows.rows.map((d) => [d.id, d]));

  // Pick a random row from the small candidate set so we don't always
  // probe the oldest one first (more human-looking spread).
  const candidates = r.rows.filter((row) => {
    const since = Date.now() - new Date(row.last_warmup_at).getTime();
    const dueAfter =
      WARMUP_STALE_MIN_MS +
      Math.random() * (WARMUP_STALE_MAX_MS - WARMUP_STALE_MIN_MS);
    if (since < dueAfter) return false;

    const detail = detailById.get(row.id);
    if (detail) {
      if (!activeHours.isWithinActiveHours(detail)) return false;
      if (behaviorPacing.isInFeedbackCooldown(detail)) return false;
    }
    return true;
  });
  if (candidates.length === 0) return null;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  try {
    await runHealthCheck(pick.id, { verbose: true });
  } catch (err) {
    logger.warn(`IG.health: scheduler probe for ${pick.id} threw: ${err.message}`);
  }
  return pick.id;
}

function startWarmupScheduler() {
  if (_schedulerTimer) return;
  logger.info(
    `IG.health: warm-up scheduler armed (tick=${SCHEDULER_TICK_MS}ms, ` +
    `stale-window=${WARMUP_STALE_MIN_MS / 60000}-${WARMUP_STALE_MAX_MS / 60000}min)`
  );
  _schedulerTimer = setInterval(async () => {
    if (_schedulerRunning) return; // never overlap
    _schedulerRunning = true;
    try {
      await _runOneDueProbe();
    } finally {
      _schedulerRunning = false;
    }
  }, SCHEDULER_TICK_MS);
  if (_schedulerTimer.unref) _schedulerTimer.unref();
}

function stopWarmupScheduler() {
  if (_schedulerTimer) {
    clearInterval(_schedulerTimer);
    _schedulerTimer = null;
  }
}

/**
 * Read the most recent health snapshot for a session — used by the
 * GET /api/instagram/sessions/:id/health endpoint.
 */
async function getSessionHealth(sessionId, userId) {
  const r = await pool.query(
    `SELECT s.id, s.username, s.status, s.is_logged_in, s.proxy_url,
            s.last_warmup_at, s.warmup_state,
            (SELECT json_agg(t.* ORDER BY t.performed_at DESC)
               FROM (SELECT action, succeeded, error_code, error_message,
                            performed_at
                       FROM behavior_log
                      WHERE session_id = s.id
                      ORDER BY performed_at DESC
                      LIMIT 10) t) AS recent_log
       FROM sessions s
      WHERE s.id = $1
        AND s.user_id = $2
        AND s.platform = 'instagram'`,
    [sessionId, userId]
  );
  return r.rows[0] || null;
}

module.exports = {
  runHealthCheck,
  startWarmupScheduler,
  stopWarmupScheduler,
  getSessionHealth,
};
