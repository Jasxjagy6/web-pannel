/**
 * tgRiskScore — anti-revoke risk score per Telegram session.
 *
 * Mirrors `providers/instagram/riskScore.js` (Phase 3 §B16) so the gate
 * logic + admin dashboard share the same shape across providers.
 *
 * Inputs:
 *   - tg_detection_events for the last 7d (counts by severity/type)
 *   - sessions.auth_key_first_seen_at (age factor — newer = riskier)
 *   - tg_session_health (consecutive failed pings, dc migrate count,
 *     ip country jumps, last reauth_required)
 *
 * Output:  number in [0, 1]  (0 = pristine, 1 = reroll-the-account)
 *
 * Weights (sum to 1.0):
 *   0.30 — recent FloodWait severity (flood_wait_long×0.6 + extreme×1.0)
 *   0.20 — auth_key_age age_factor (saturates at 30d)
 *   0.15 — geo jumps (ip_country_jumps_24h, capped at 3)
 *   0.10 — DC migrate count (dc_migrate_count_24h, capped at 3)
 *   0.10 — consecutive_failed_pings (capped at 5)
 *   0.10 — time-since-last GetAuthorizations check (overdue → riskier)
 *   0.05 — last_reauth_required recency (within 24h → 1.0)
 */

'use strict';

const { pool } = require('../../config/database');
const logger = require('../../utils/logger');

const WEIGHTS = Object.freeze({
  flood: 0.30,
  ageFactor: 0.20,
  geoJump: 0.15,
  dcMigrate: 0.10,
  failedPings: 0.10,
  authProbeOverdue: 0.10,
  reauthRecency: 0.05,
});

const SEVEN_DAYS_AGO = () => new Date(Date.now() - 7 * 24 * 3600 * 1000);

function clamp01(n) {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Compute the risk score for a single session. Returns {score, breakdown}.
 *
 * @param {number|string} sessionId
 * @returns {Promise<{score:number, breakdown:object}>}
 */
async function compute(sessionId) {
  const breakdown = { sessionId };

  // 1. Recent FloodWait events (7d).
  let flood = 0;
  try {
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE event_type='flood_wait_long')::int AS long_count,
         COUNT(*) FILTER (WHERE event_type='flood_wait_extreme')::int AS extreme_count
       FROM tg_detection_events
       WHERE session_id = $1 AND occurred_at >= $2`,
      [sessionId, SEVEN_DAYS_AGO()]
    );
    const long = r.rows[0].long_count || 0;
    const extreme = r.rows[0].extreme_count || 0;
    flood = clamp01((long * 0.6 + extreme * 1.0) / 5); // 5 long-floods saturates
    breakdown.flood = { long, extreme, factor: flood };
  } catch (e) {
    breakdown.flood = { error: e.message, factor: 0 };
  }

  // 2. Auth key age (younger = riskier; 30d → 0).
  let ageFactor = 0.5; // unknown ages default to mid-risk
  try {
    const r = await pool.query(
      `SELECT auth_key_first_seen_at FROM sessions WHERE id = $1`,
      [sessionId]
    );
    const seen = r.rows[0] && r.rows[0].auth_key_first_seen_at;
    if (seen) {
      const ageDays = Math.max(0, (Date.now() - new Date(seen).getTime()) / 86400000);
      // Saturate at 30 days of clean operation.
      ageFactor = clamp01(1 - ageDays / 30);
    }
    breakdown.ageFactor = { factor: ageFactor };
  } catch (e) {
    breakdown.ageFactor = { error: e.message, factor: ageFactor };
  }

  // 3-6. tg_session_health columns.
  let geoJump = 0;
  let dcMigrate = 0;
  let failedPings = 0;
  let authProbeOverdue = 0;
  let reauthRecency = 0;
  try {
    const r = await pool.query(
      `SELECT ip_country_jumps_24h, dc_migrate_count_24h,
              consecutive_failed_pings, last_authorizations_check_at,
              last_reauth_required_at
         FROM tg_session_health WHERE session_id = $1`,
      [sessionId]
    );
    const row = r.rows[0] || {};
    geoJump = clamp01((row.ip_country_jumps_24h || 0) / 3);
    dcMigrate = clamp01((row.dc_migrate_count_24h || 0) / 3);
    failedPings = clamp01((row.consecutive_failed_pings || 0) / 5);

    if (row.last_authorizations_check_at) {
      const overdueMs = Date.now() - new Date(row.last_authorizations_check_at).getTime();
      // Overdue beyond 24h saturates.
      authProbeOverdue = clamp01(overdueMs / (24 * 3600 * 1000) - 0.2);
    } else {
      // Never probed → moderate risk.
      authProbeOverdue = 0.5;
    }

    if (row.last_reauth_required_at) {
      const recencyMs = Date.now() - new Date(row.last_reauth_required_at).getTime();
      // Within 24h → 1.0; decays linearly to 0 over 7d.
      reauthRecency = clamp01(1 - recencyMs / (7 * 86400000));
    }

    breakdown.geoJump = { factor: geoJump, count: row.ip_country_jumps_24h || 0 };
    breakdown.dcMigrate = { factor: dcMigrate, count: row.dc_migrate_count_24h || 0 };
    breakdown.failedPings = { factor: failedPings, count: row.consecutive_failed_pings || 0 };
    breakdown.authProbeOverdue = { factor: authProbeOverdue };
    breakdown.reauthRecency = { factor: reauthRecency };
  } catch (e) {
    breakdown.healthError = e.message;
  }

  const score = clamp01(
    flood * WEIGHTS.flood +
    ageFactor * WEIGHTS.ageFactor +
    geoJump * WEIGHTS.geoJump +
    dcMigrate * WEIGHTS.dcMigrate +
    failedPings * WEIGHTS.failedPings +
    authProbeOverdue * WEIGHTS.authProbeOverdue +
    reauthRecency * WEIGHTS.reauthRecency
  );

  // Best-effort persist into tg_session_health.risk_score for the admin UI.
  try {
    await pool.query(
      `INSERT INTO tg_session_health (session_id, risk_score, risk_score_updated_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         risk_score = EXCLUDED.risk_score,
         risk_score_updated_at = NOW(),
         updated_at = NOW()`,
      [sessionId, score]
    );
  } catch (err) {
    logger.debug(`riskScore persist failed for ${sessionId}: ${err.message}`);
  }

  return { score, breakdown, weights: WEIGHTS };
}

/**
 * Throw a 403 RISK_TOO_HIGH if the session's score exceeds threshold.
 * Used to gate heavy operations (scrape, bulk messaging, group joins).
 *
 * @param {number|string} sessionId
 * @param {number}        [threshold]
 */
async function gateOnRisk(sessionId, threshold) {
  const cfg = require('../../config/telegram');
  const lim = typeof threshold === 'number' ? threshold : (cfg.RISK_GATE_THRESHOLD || 0.65);
  if (!cfg.ANTI_REVOKE_PHASE_3_ENABLED) return { score: 0, gated: false };
  const { score, breakdown } = await compute(sessionId);
  if (score > lim) {
    const err = new Error(
      `Telegram session ${sessionId} blocked from heavy operations: ` +
        `risk score ${score.toFixed(3)} exceeds threshold ${lim.toFixed(3)}.`
    );
    err.code = 'RISK_TOO_HIGH';
    err.statusCode = 403;
    err.riskScore = score;
    err.riskBreakdown = breakdown;
    err.threshold = lim;
    throw err;
  }
  return { score, breakdown, gated: false };
}

/**
 * Aggregate the top-N highest-risk sessions for the admin dashboard.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.userId]
 * @param {number}  [opts.minScore=0.5]
 * @param {number}  [opts.limit=20]
 */
async function topRisky({ userId = null, minScore = 0.5, limit = 20 } = {}) {
  const params = [];
  let where = `tsh.risk_score >= $1`;
  params.push(minScore);
  if (userId) {
    where += ` AND s.user_id = $${params.length + 1}`;
    params.push(userId);
  }
  const r = await pool.query(
    `SELECT tsh.session_id, tsh.risk_score, tsh.risk_score_updated_at,
            tsh.consecutive_failed_pings, tsh.dc_migrate_count_24h,
            tsh.ip_country_jumps_24h, tsh.last_authorizations_check_at,
            s.user_id, s.phone, s.account_info, s.status, s.is_logged_in
     FROM tg_session_health tsh
     JOIN sessions s ON s.id = tsh.session_id
     WHERE ${where} AND s.platform = 'telegram'
     ORDER BY tsh.risk_score DESC, tsh.risk_score_updated_at DESC
     LIMIT $${params.length + 1}`,
    [...params, Math.max(1, Math.min(200, limit))]
  );
  return { count: r.rowCount, sessions: r.rows };
}

module.exports = {
  WEIGHTS,
  compute,
  gateOnRisk,
  topRisky,
};
