/**
 * sessionCooldown — record + query per-session "this session is on cooldown"
 * markers driven by Telegram FloodWait / PEER_FLOOD responses.
 *
 * Two behaviours:
 *   1. `markFloodCooldown(sessionId, seconds, reason)` — set `cooldown_until`
 *      to `NOW() + seconds`. Long FLOOD_WAITs (≥30s) and PEER_FLOOD both call
 *      this; PEER_FLOOD passes the conservative account-level default (6h).
 *      Idempotent under contention: we always pick the LATER of the existing
 *      `cooldown_until` and the new one so a freshly-arrived 60s wait can
 *      never shorten a still-running 6h PEER_FLOOD lock.
 *   2. `isOnCooldown(sessionId)` / `filterEligibleSessionIds(sessionIds)` —
 *      consumers ask whether a session is currently job-eligible. Pages
 *      that legitimately need to operate on a cooldown session (privacy,
 *      2FA, login) just don't call these.
 *
 * Only writes columns introduced in `migration_v24_session_cooldown_*.sql`.
 * Failures are best-effort and never throw — a missing column on an
 * upgrading deploy must not break the worker mid-job.
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');

const DEFAULT_PEER_FLOOD_SECONDS = 6 * 60 * 60;
const MIN_RECORDED_FLOOD_SECONDS = 30;
const MAX_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

function clampSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PEER_FLOOD_SECONDS;
  if (n > MAX_COOLDOWN_SECONDS) return MAX_COOLDOWN_SECONDS;
  return Math.floor(n);
}

/**
 * Record a flood-wait or peer-flood cooldown on a session row.
 *
 * Always picks `GREATEST(existing cooldown_until, NOW() + seconds)` so a
 * shorter incoming lock can't override a longer one already in place.
 *
 * @param {number|string} sessionId
 * @param {number} seconds         seconds remaining until release
 * @param {string} [reason]        free-text marker, e.g. 'PEER_FLOOD' / 'FLOOD_WAIT_120'
 * @returns {Promise<void>}
 */
async function markFloodCooldown(sessionId, seconds, reason = null) {
  const sid = sessionId == null ? null : String(sessionId);
  if (!sid) return;
  const wait = clampSeconds(seconds);
  if (wait < MIN_RECORDED_FLOOD_SECONDS) return;
  try {
    await pool.query(
      `UPDATE sessions
          SET cooldown_until   = GREATEST(COALESCE(cooldown_until, NOW()), NOW() + ($2 || ' seconds')::interval),
              cooldown_reason  = COALESCE($3, cooldown_reason),
              cooldown_set_at  = NOW(),
              cooldown_seconds = $2
        WHERE id = $1`,
      [sid, wait, reason ? String(reason).slice(0, 200) : null]
    );
    logger.warn(`[cooldown] session ${sid} marked on cooldown for ${wait}s (${reason || 'flood'})`);
  } catch (err) {
    logger.warn(`[cooldown] failed to mark session ${sid}: ${err.message}`);
  }
}

/**
 * Convenience: record a PEER_FLOOD lock with the conservative default
 * 6h cooldown.
 */
async function markPeerFlood(sessionId, reason = 'PEER_FLOOD') {
  return markFloodCooldown(sessionId, DEFAULT_PEER_FLOOD_SECONDS, reason);
}

/**
 * Clear an active cooldown — used by tests, by admin recovery flows, and by
 * the cooldown self-expiry sweeper. Safe to call repeatedly.
 */
async function clearCooldown(sessionId) {
  const sid = sessionId == null ? null : String(sessionId);
  if (!sid) return;
  try {
    await pool.query(
      `UPDATE sessions
          SET cooldown_until   = NULL,
              cooldown_reason  = NULL,
              cooldown_set_at  = NULL,
              cooldown_seconds = NULL
        WHERE id = $1`,
      [sid]
    );
  } catch (err) {
    logger.warn(`[cooldown] failed to clear session ${sid}: ${err.message}`);
  }
}

/**
 * Returns the cooldown payload for a single session if it's still active,
 * else null. Cheap enough to call per RPC.
 */
async function getCooldown(sessionId) {
  const sid = sessionId == null ? null : String(sessionId);
  if (!sid) return null;
  try {
    const { rows } = await pool.query(
      `SELECT cooldown_until, cooldown_reason, cooldown_set_at, cooldown_seconds
         FROM sessions
        WHERE id = $1
          AND cooldown_until IS NOT NULL
          AND cooldown_until > NOW()`,
      [sid]
    );
    if (!rows.length) return null;
    return {
      cooldown_until: rows[0].cooldown_until,
      cooldown_reason: rows[0].cooldown_reason,
      cooldown_set_at: rows[0].cooldown_set_at,
      cooldown_seconds: rows[0].cooldown_seconds,
      remaining_seconds: Math.max(
        0,
        Math.ceil((new Date(rows[0].cooldown_until).getTime() - Date.now()) / 1000)
      ),
    };
  } catch {
    return null;
  }
}

/**
 * Quick boolean check.
 */
async function isOnCooldown(sessionId) {
  const cd = await getCooldown(sessionId);
  return Boolean(cd);
}

/**
 * Filter an array of session IDs down to the ones currently eligible to run
 * a JOB (i.e. `cooldown_until IS NULL OR cooldown_until <= NOW()`). Returns
 * the same shape so callers can do `sessionIds = await filter(sessionIds)`.
 *
 * The dropped IDs are returned alongside so the caller can record skip
 * reasons in the operation row.
 */
async function filterEligibleSessionIds(sessionIds) {
  const ids = (sessionIds || []).map((x) => String(x)).filter(Boolean);
  if (ids.length === 0) return { eligible: [], skipped: [] };
  try {
    const { rows } = await pool.query(
      `SELECT id::text AS id, cooldown_until
         FROM sessions
        WHERE id = ANY($1::int[])`,
      [ids]
    );
    const now = Date.now();
    const eligible = [];
    const skipped = [];
    const seen = new Set();
    for (const r of rows) {
      seen.add(String(r.id));
      const cd = r.cooldown_until ? new Date(r.cooldown_until).getTime() : 0;
      if (cd > now) {
        skipped.push({ sessionId: String(r.id), cooldown_until: r.cooldown_until });
      } else {
        eligible.push(String(r.id));
      }
    }
    // Pass through any IDs the lookup didn't return (validateSessionsOwnership
    // upstream is responsible for ownership errors, not us).
    for (const id of ids) {
      if (!seen.has(id)) eligible.push(id);
    }
    return { eligible, skipped };
  } catch (err) {
    logger.warn(`[cooldown] filterEligibleSessionIds failed: ${err.message}`);
    return { eligible: ids, skipped: [] };
  }
}

module.exports = {
  DEFAULT_PEER_FLOOD_SECONDS,
  MIN_RECORDED_FLOOD_SECONDS,
  markFloodCooldown,
  markPeerFlood,
  clearCooldown,
  getCooldown,
  isOnCooldown,
  filterEligibleSessionIds,
};
