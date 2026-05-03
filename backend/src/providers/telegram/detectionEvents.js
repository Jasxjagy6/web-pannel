/**
 * tg_detection_events recorder + helpers.
 *
 * Mirrors `providers/instagram/detectionEvents.js` (Phase 3) so the
 * admin dashboard / observability layer has the same shape across both
 * providers.
 *
 * Why this matters (Anti-revoke §B15):
 *   When Telegram revokes a session there's currently no forensic trail
 *   in the panel. After-the-fact debugging requires grepping logs, and
 *   logs rotate. By appending every revocation, AUTH_KEY_* error,
 *   FloodWait>30s, geo jump, and DC migrate into `tg_detection_events`
 *   we keep a structured audit trail per session that survives restarts.
 *
 * Schema (see migration_v13_tg_anti_revoke.sql):
 *   id, session_id, user_id, event_type, severity, http_status,
 *   api_method, raw_excerpt, fingerprint (jsonb), occurred_at
 *
 * Helpers:
 *   record(payload)            — write an event
 *   classifyTelegramError(err) — map a Telegram error → {event_type, severity}
 *   sanitizeFingerprint(fp)    — strip PII / secrets before persisting
 *   list(filter)               — paginated query for the admin endpoint
 */

'use strict';

const { pool } = require('../../config/database');
const logger = require('../../utils/logger');

const KNOWN_EVENT_TYPES = new Set([
  'auth_key_unregistered',
  'auth_key_duplicated',
  'auth_key_invalid',
  'session_revoked',
  'session_expired',
  'user_deactivated',
  'flood_wait_long',     // FLOOD_WAIT > 30s
  'flood_wait_extreme',  // FLOOD_WAIT > 5min
  'peer_flood',
  'slow_mode',
  'phone_code_invalid_repeat',
  'password_hash_invalid',
  'password_required_unexpected',
  'authorization_terminated_externally',
  'geo_jump',
  'dc_migrate',
  'connection_failed',
  'login_failed',
]);

const SEVERITY = ['info', 'warning', 'critical'];

const MAX_EXCERPT = 2048;

const PII_KEYS = new Set([
  'password',
  'password_hash',
  'phone_number',
  'phoneNumber',
  'phone',
  'authorization',
  'cookie',
  'cookies',
  'set-cookie',
  'session',
  'session_string',
  'auth_key',
  'authkey',
  'api_hash',
  'apiHash',
  'token',
  'access_token',
  'bearer',
  'proxy_url',
  'srp_password',
  'g_b',
  'a',
]);

/**
 * Recursively strip PII/secret-looking keys from the fingerprint blob.
 */
function sanitizeFingerprint(fp) {
  if (fp === null || fp === undefined) return null;
  if (typeof fp !== 'object') return fp;
  if (Array.isArray(fp)) return fp.map(sanitizeFingerprint);
  const out = {};
  for (const [k, v] of Object.entries(fp)) {
    if (PII_KEYS.has(String(k).toLowerCase())) continue;
    out[k] = sanitizeFingerprint(v);
  }
  return out;
}

/**
 * Map a Telegram error (gramjs RPCError or plain Error) to an event_type
 * + severity. Used by the heartbeat / login flows so callers don't
 * duplicate this regex matrix.
 */
function classifyTelegramError(err) {
  if (!err) return null;
  const parts = [
    err.errorMessage,
    err.message,
    typeof err.code === 'string' ? err.code : null,
  ].filter(Boolean);
  if (parts.length === 0) parts.push(String(err));
  const haystack = parts.join(' ').toUpperCase();

  if (haystack.includes('AUTH_KEY_DUPLICATED')) return { event_type: 'auth_key_duplicated', severity: 'critical' };
  if (haystack.includes('AUTH_KEY_UNREGISTERED')) return { event_type: 'auth_key_unregistered', severity: 'critical' };
  if (haystack.includes('AUTH_KEY_INVALID')) return { event_type: 'auth_key_invalid', severity: 'critical' };
  if (haystack.includes('SESSION_REVOKED')) return { event_type: 'session_revoked', severity: 'critical' };
  if (haystack.includes('SESSION_EXPIRED')) return { event_type: 'session_expired', severity: 'critical' };
  if (haystack.includes('USER_DEACTIVATED')) return { event_type: 'user_deactivated', severity: 'critical' };
  if (haystack.includes('PEER_FLOOD')) return { event_type: 'peer_flood', severity: 'warning' };
  if (haystack.includes('SLOWMODE_WAIT')) return { event_type: 'slow_mode', severity: 'info' };

  // Flood wait — the seconds we should sleep are usually in `err.seconds`
  // (gramjs FLOOD_WAIT_X). We only record when it's >= 30s; below that
  // is normal anti-spam back-pressure.
  const m = haystack.match(/FLOOD_WAIT_(\d+)/) || (typeof err.seconds === 'number' ? [`FLOOD_WAIT_${err.seconds}`, String(err.seconds)] : null);
  if (m) {
    const secs = parseInt(m[1], 10);
    if (secs >= 300) return { event_type: 'flood_wait_extreme', severity: 'critical', seconds: secs };
    if (secs >= 30) return { event_type: 'flood_wait_long', severity: 'warning', seconds: secs };
    return null;
  }

  if (haystack.includes('PHONE_CODE_INVALID')) return { event_type: 'phone_code_invalid_repeat', severity: 'info' };
  if (haystack.includes('PASSWORD_HASH_INVALID')) return { event_type: 'password_hash_invalid', severity: 'warning' };
  if (haystack.includes('SESSION_PASSWORD_NEEDED')) return { event_type: 'password_required_unexpected', severity: 'info' };
  if (/(_MIGRATE_)/.test(haystack)) return { event_type: 'dc_migrate', severity: 'info' };
  if (haystack.includes('CONNECTION') || haystack.includes('TIMED OUT')) return { event_type: 'connection_failed', severity: 'info' };
  return null;
}

/**
 * Persist an event. Best-effort: never throws.
 *
 * @param {object} payload
 * @param {number|string|null} payload.session_id
 * @param {number|string|null} payload.user_id
 * @param {string}             payload.event_type   one of KNOWN_EVENT_TYPES
 * @param {string}             [payload.severity]   info / warning / critical
 * @param {number|null}        [payload.http_status]
 * @param {string|null}        [payload.api_method]
 * @param {string|null}        [payload.raw_excerpt]
 * @param {object|null}        [payload.fingerprint]
 * @returns {Promise<{id:number}|null>}
 */
async function record(payload) {
  if (!payload || !payload.event_type) return null;
  const event_type = String(payload.event_type);
  if (!KNOWN_EVENT_TYPES.has(event_type)) {
    logger.debug(`tg detection: unknown event_type "${event_type}"; recording anyway`);
  }
  const severity = SEVERITY.includes(payload.severity) ? payload.severity : 'info';
  const raw_excerpt = payload.raw_excerpt
    ? String(payload.raw_excerpt).slice(0, MAX_EXCERPT)
    : null;
  const fp = sanitizeFingerprint(payload.fingerprint || null);
  try {
    const r = await pool.query(
      `INSERT INTO tg_detection_events
         (session_id, user_id, event_type, severity, http_status, api_method, raw_excerpt, fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING id`,
      [
        payload.session_id || null,
        payload.user_id || null,
        event_type,
        severity,
        payload.http_status || null,
        payload.api_method ? String(payload.api_method).slice(0, 128) : null,
        raw_excerpt,
        fp ? JSON.stringify(fp) : null,
      ]
    );
    return r.rows[0] ? { id: r.rows[0].id } : null;
  } catch (err) {
    logger.debug(`tg_detection_events insert failed: ${err.message}`);
    return null;
  }
}

/**
 * Convenience: classify and record in one shot.
 */
async function recordFromError(err, ctx = {}) {
  const cls = classifyTelegramError(err);
  if (!cls) return null;
  return record({
    session_id: ctx.session_id || null,
    user_id: ctx.user_id || null,
    event_type: cls.event_type,
    severity: cls.severity,
    api_method: ctx.api_method || null,
    raw_excerpt: err && err.message ? String(err.message) : String(err),
    fingerprint: {
      ...(ctx.fingerprint || {}),
      ...(typeof cls.seconds === 'number' ? { flood_wait_seconds: cls.seconds } : {}),
    },
  });
}

/**
 * Paginated query. Used by the admin endpoint.
 *
 * @param {object} filter
 * @param {string|null} [filter.since]      ISO timestamp lower bound (inclusive).
 * @param {number|null} [filter.session_id]
 * @param {number|null} [filter.user_id]
 * @param {string|null} [filter.event_type]
 * @param {string|null} [filter.severity]
 * @param {number}      [filter.limit=50]
 * @param {number}      [filter.offset=0]
 */
async function list(filter = {}) {
  const limit = Math.max(1, Math.min(500, Number(filter.limit) || 50));
  const offset = Math.max(0, Number(filter.offset) || 0);
  const where = [];
  const params = [];
  let p = 1;
  if (filter.since) { where.push(`occurred_at >= $${p++}`); params.push(filter.since); }
  if (filter.session_id) { where.push(`session_id = $${p++}`); params.push(filter.session_id); }
  if (filter.user_id) { where.push(`user_id = $${p++}`); params.push(filter.user_id); }
  if (filter.event_type) { where.push(`event_type = $${p++}`); params.push(filter.event_type); }
  if (filter.severity) { where.push(`severity = $${p++}`); params.push(filter.severity); }

  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = await pool.query(`SELECT COUNT(*)::int AS c FROM tg_detection_events ${w}`, params);
  const rows = await pool.query(
    `SELECT * FROM tg_detection_events ${w}
     ORDER BY occurred_at DESC, id DESC
     LIMIT $${p++} OFFSET $${p++}`,
    [...params, limit, offset]
  );
  // Per-event-type counts within the same filter window.
  const counts = await pool.query(
    `SELECT event_type, COUNT(*)::int AS c FROM tg_detection_events ${w}
     GROUP BY event_type ORDER BY c DESC`,
    params
  );
  return {
    total: totalRow.rows[0].c,
    events: rows.rows,
    counts: counts.rows,
    pagination: { limit, offset },
  };
}

module.exports = {
  KNOWN_EVENT_TYPES: Array.from(KNOWN_EVENT_TYPES),
  classifyTelegramError,
  sanitizeFingerprint,
  record,
  recordFromError,
  list,
};
