/**
 * Instagram detection-event recorder (Phase 3 / B15).
 *
 * Writes one row per "Instagram pushed back on us" signal to the
 * `ig_detection_events` table created by migration_v12_ig_anti_ban.sql.
 * Callers are:
 *   - igFetch.classifyError       — every non-2xx web-API response
 *   - client.js cookie-restore    — missing/malformed cookies, decrypt fail
 *   - sessionHealth.runHealthCheck — failed warm-up probes
 *   - scrape._executeScrapeJob    — checkpoint/login_required/action_blocked
 *                                    bubbling out of the worker
 *   - messaging._executeMessagingJob — feedback_required / action_blocked
 *                                       on DM sends
 *
 * Recording is best-effort:
 *   - all DB errors are swallowed (we never want detection logging to
 *     break the calling code path),
 *   - the `request_fingerprint` JSON is allow-listed — we never write
 *     full cookies, csrftoken, sessionid, or proxy URL with credentials,
 *   - the `response_body` is truncated to 2 KB so a hostile IG response
 *     can't bloat the table.
 *
 * The risk score (B16) reads aggregate counts from this table grouped
 * by event_kind in the last 7 days, so the schema is intentionally
 * simple (one row per event, no rollups).
 */

'use strict';

const { pool } = require('../../config/database');
const logger = require('../../utils/logger');

const RESPONSE_BODY_MAX = 2 * 1024;
// Allow-list of header fields we're willing to persist as part of the
// fingerprint snapshot. Anything else is dropped before insert so we
// never accidentally store cookies/csrftoken/sessionid in the audit
// table.
const SAFE_HEADER_KEYS = new Set([
  'user-agent',
  'sec-ch-ua',
  'sec-ch-ua-platform',
  'sec-ch-ua-mobile',
  'accept-language',
  'x-ig-app-id',
]);

const VALID_EVENT_KINDS = new Set([
  'checkpoint',
  'feedback_required',
  'action_blocked',
  'login_required',
  'rate_limited',
  'cookie_missing',
  'decrypt_failed',
  'network',
  'forbidden',
  'not_found',
]);

function _truncate(s, max = RESPONSE_BODY_MAX) {
  if (s == null) return null;
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  if (str.length <= max) return str;
  return str.slice(0, max);
}

function _safeFingerprint(fp) {
  if (!fp || typeof fp !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(fp)) {
    if (k === 'headers' && v && typeof v === 'object') {
      const h = {};
      for (const [hk, hv] of Object.entries(v)) {
        if (SAFE_HEADER_KEYS.has(String(hk).toLowerCase())) h[hk] = hv;
      }
      out.headers = h;
      continue;
    }
    // Never persist cookie / sessionid / proxy_url credentials.
    if (/cookie|sessionid|csrftoken|proxy_url|password|secret|token/i.test(k)) continue;
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
      continue;
    }
    if (typeof v === 'object') {
      try {
        out[k] = JSON.parse(JSON.stringify(v));
      } catch (_e) { /* drop unserializable */ }
    }
  }
  return out;
}

/**
 * Record one detection event.
 *
 *   await detectionEvents.record({
 *     sessionId, userId,
 *     eventKind: 'checkpoint',
 *     apiPath:   'https://www.instagram.com/api/v1/...',
 *     httpStatus: 401,
 *     responseBody: '...raw IG body...',
 *     requestFingerprint: { userAgent, accept_language, action_class,
 *                           hour_of_day_local, api_mode, app_version }
 *   })
 */
async function record({
  sessionId = null,
  userId = null,
  eventKind,
  apiPath = null,
  httpStatus = null,
  responseBody = null,
  requestFingerprint = null,
} = {}) {
  if (!eventKind) return;
  if (!VALID_EVENT_KINDS.has(eventKind)) {
    // Don't refuse — coerce to network so unknown kinds still leave a
    // breadcrumb. Surface a warn so the caller knows to add a kind.
    logger.warn(`IG.detectionEvents.record: unknown event_kind=${eventKind}, coerced to 'network'`);
    eventKind = 'network';
  }

  const safeFp = _safeFingerprint(requestFingerprint);
  const safeBody = _truncate(responseBody, RESPONSE_BODY_MAX);

  try {
    await pool.query(
      `INSERT INTO ig_detection_events
         (session_id, user_id, event_kind, api_path, http_status,
          response_body, request_fingerprint, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())`,
      [
        sessionId,
        userId,
        eventKind,
        apiPath ? String(apiPath).slice(0, 512) : null,
        Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null,
        safeBody,
        safeFp ? JSON.stringify(safeFp) : null,
      ]
    );
  } catch (err) {
    logger.warn(`IG.detectionEvents.record failed: ${err.message}`);
  }
}

/**
 * Build a fingerprint snapshot suitable for `record(requestFingerprint)`
 * from an igFetch session-context. Pulls the allow-listed bits and
 * derives `hour_of_day_local` from the session's pinned tz so the
 * audit table can answer "was this session being touched at 03:00 in
 * its claimed timezone?" without storing PII.
 */
function fingerprintFromCtx(ctx, opts = {}) {
  if (!ctx) return _safeFingerprint(opts);
  const fp = ctx.webFingerprint || {};
  let hourOfDayLocal = null;
  try {
    const tz = (ctx.locale && ctx.locale.tz) ||
               (ctx.locale && ctx.locale.regionHint) || null;
    const date = new Date();
    if (tz) {
      const localStr = date.toLocaleTimeString('en-US', { hour12: false, timeZone: tz });
      const m = /^(\d{1,2})/.exec(localStr || '');
      if (m) hourOfDayLocal = Number(m[1]);
    } else {
      hourOfDayLocal = date.getUTCHours();
    }
  } catch (_e) { /* best-effort only */ }

  return _safeFingerprint({
    userAgent:        fp.userAgent || null,
    secChUaPlatform:  fp.secChUaPlatform || null,
    accept_language:  (ctx.locale && ctx.locale.language) || null,
    api_mode:         ctx.apiMode || null,
    app_version:      ctx.appVersion || null,
    proxy_country:    (ctx.locale && (ctx.locale.regionHint || ctx.locale.tz)) || null,
    action_class:     opts.action_class || null,
    hour_of_day_local: hourOfDayLocal,
  });
}

/**
 * Read recent detection events for the admin endpoint.
 *
 *   await listEvents({ sinceHours: 24, sessionId, eventKind, limit, offset })
 */
async function listEvents({
  sinceHours = 24,
  sessionId = null,
  userId = null,
  eventKind = null,
  limit = 200,
  offset = 0,
} = {}) {
  const conds = [`occurred_at > NOW() - ($1 || ' hours')::interval`];
  const params = [String(Math.max(1, Math.min(24 * 14, Number(sinceHours) || 24)))];
  let p = 2;
  if (sessionId != null) {
    conds.push(`session_id = $${p++}`);
    params.push(Number(sessionId));
  }
  if (userId != null) {
    conds.push(`user_id = $${p++}`);
    params.push(Number(userId));
  }
  if (eventKind) {
    conds.push(`event_kind = $${p++}`);
    params.push(String(eventKind));
  }
  params.push(Math.max(1, Math.min(1000, Number(limit) || 200)));
  params.push(Math.max(0, Number(offset) || 0));
  const r = await pool.query(
    `SELECT e.id, e.session_id, e.user_id, e.event_kind, e.api_path,
            e.http_status, e.response_body, e.request_fingerprint, e.occurred_at,
            s.username AS session_username
       FROM ig_detection_events e
       LEFT JOIN sessions s ON s.id = e.session_id
      WHERE ${conds.join(' AND ')}
      ORDER BY e.occurred_at DESC
      LIMIT $${p++} OFFSET $${p++}`,
    params
  );
  return r.rows;
}

/**
 * Aggregate counts per kind for a given session over the last N days.
 * Used by the risk-score computer (B16) and the admin per-session view.
 */
async function countByKindForSession(sessionId, sinceDays = 7) {
  const r = await pool.query(
    `SELECT event_kind, COUNT(*)::int AS n
       FROM ig_detection_events
      WHERE session_id = $1
        AND occurred_at > NOW() - ($2 || ' days')::interval
      GROUP BY event_kind`,
    [sessionId, String(Math.max(1, Math.min(60, Number(sinceDays) || 7)))]
  );
  const out = {};
  for (const row of r.rows) out[row.event_kind] = row.n;
  return out;
}

module.exports = {
  record,
  listEvents,
  countByKindForSession,
  fingerprintFromCtx,
  VALID_EVENT_KINDS,
};
