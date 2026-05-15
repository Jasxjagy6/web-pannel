/**
 * Lookup-watch CRUD service — PR #7.
 *
 * Backed by `lookup_watches` (created in v34). The worker
 * (`lookupWatchWorker`) polls this service for due rows once a minute.
 */

'use strict';

const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');
const lookupAudit = require('./lookupAuditService');

const DEFAULT_CADENCE_HOURS = 24;
const MIN_CADENCE_HOURS = 4;
const MAX_CADENCE_HOURS = 24 * 30;

function _nextRunAt(cadenceHours) {
  return new Date(Date.now() + cadenceHours * 60 * 60 * 1000);
}

async function create({ userId, username, cadenceHours }) {
  if (!userId) throw new AppError('userId required', 400, 'VALIDATION_ERROR');
  const cleaned = String(username || '').trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/i.test(cleaned)) {
    throw new AppError('invalid IG username', 400, 'VALIDATION_ERROR');
  }
  let cadence = parseInt(cadenceHours, 10);
  if (!Number.isFinite(cadence) || cadence < MIN_CADENCE_HOURS) cadence = DEFAULT_CADENCE_HOURS;
  if (cadence > MAX_CADENCE_HOURS) cadence = MAX_CADENCE_HOURS;
  const { rows } = await pool.query(
    `INSERT INTO lookup_watches (user_id, username, cadence_hours, active, next_run_at)
     VALUES ($1, $2, $3, TRUE, $4)
     ON CONFLICT DO NOTHING
     RETURNING id, user_id, username, cadence_hours, active, last_run_at, next_run_at, created_at`,
    [userId, cleaned, cadence, _nextRunAt(cadence)]
  );
  // Conflict (duplicate active row for same user/username) → return existing.
  if (!rows[0]) {
    const ex = await pool.query(
      `SELECT id, user_id, username, cadence_hours, active, last_run_at, next_run_at, created_at
         FROM lookup_watches
        WHERE user_id = $1 AND username = $2
        ORDER BY id DESC LIMIT 1`,
      [userId, cleaned]
    );
    if (ex.rows[0] && !ex.rows[0].active) {
      // Reactivate.
      const reAct = await pool.query(
        `UPDATE lookup_watches
            SET active = TRUE,
                cadence_hours = $2,
                next_run_at = $3
          WHERE id = $1
        RETURNING id, user_id, username, cadence_hours, active, last_run_at, next_run_at, created_at`,
        [ex.rows[0].id, cadence, _nextRunAt(cadence)]
      );
      lookupAudit.log({ userId, username: cleaned, action: 'watch_created', meta: { id: reAct.rows[0].id, reactivated: true } });
      return reAct.rows[0];
    }
    return ex.rows[0] || null;
  }
  lookupAudit.log({ userId, username: cleaned, action: 'watch_created', meta: { id: rows[0].id, cadence_hours: cadence } });
  return rows[0];
}

async function list({ userId, includeInactive = false }) {
  const params = [userId];
  let sql = `SELECT id, user_id, username, cadence_hours, active, last_run_at, next_run_at,
                    cooldown_until, consecutive_errors, last_diff_summary, last_findings_count,
                    created_at
               FROM lookup_watches
              WHERE user_id = $1`;
  if (!includeInactive) sql += ` AND active = TRUE`;
  sql += ` ORDER BY active DESC, COALESCE(next_run_at, created_at) ASC`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function get({ userId, id }) {
  const { rows } = await pool.query(
    `SELECT id, user_id, username, cadence_hours, active, last_run_at, next_run_at,
            cooldown_until, consecutive_errors, last_diff_summary, last_findings_count, created_at
       FROM lookup_watches
      WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

async function remove({ userId, id }) {
  const ex = await get({ userId, id });
  if (!ex) return { ok: false, error: 'not_found' };
  await pool.query(
    `UPDATE lookup_watches SET active = FALSE WHERE id = $1`,
    [id]
  );
  lookupAudit.log({ userId, username: ex.username, action: 'watch_deleted', meta: { id } });
  return { ok: true };
}

async function pickDueRows(limit = 25) {
  // Atomically claim due rows by bumping next_run_at far into the future
  // and returning. The worker then runs them and re-stamps next_run_at
  // based on cadence after each run.
  const { rows } = await pool.query(
    `WITH due AS (
       SELECT id FROM lookup_watches
        WHERE active = TRUE
          AND (next_run_at IS NULL OR next_run_at <= NOW())
          AND (cooldown_until IS NULL OR cooldown_until <= NOW())
        ORDER BY next_run_at ASC NULLS FIRST
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE lookup_watches w
        SET next_run_at = NOW() + INTERVAL '6 hours'
      FROM due
      WHERE w.id = due.id
     RETURNING w.id, w.user_id, w.username, w.cadence_hours, w.consecutive_errors`,
    [limit]
  );
  return rows;
}

async function markRunResult({ id, cadenceHours, error = null }) {
  if (error) {
    const consecutiveErrors = await pool.query(
      `UPDATE lookup_watches
          SET last_run_at        = NOW(),
              consecutive_errors = consecutive_errors + 1,
              cooldown_until     = CASE
                                     WHEN consecutive_errors + 1 >= 5
                                       THEN NOW() + INTERVAL '24 hours'
                                     WHEN consecutive_errors + 1 >= 3
                                       THEN NOW() + INTERVAL '6 hours'
                                     ELSE NULL
                                   END,
              next_run_at        = NOW() + ($2 || ' hours')::interval
        WHERE id = $1
        RETURNING consecutive_errors`,
      [id, String(Math.max(1, cadenceHours || DEFAULT_CADENCE_HOURS))]
    );
    return { consecutive_errors: consecutiveErrors.rows[0] && consecutiveErrors.rows[0].consecutive_errors };
  }
  await pool.query(
    `UPDATE lookup_watches
        SET last_run_at        = NOW(),
            consecutive_errors = 0,
            cooldown_until     = NULL,
            next_run_at        = NOW() + ($2 || ' hours')::interval
      WHERE id = $1`,
    [id, String(Math.max(1, cadenceHours || DEFAULT_CADENCE_HOURS))]
  );
  return { ok: true };
}

module.exports = {
  create,
  list,
  get,
  remove,
  pickDueRows,
  markRunResult,
  DEFAULT_CADENCE_HOURS,
  MIN_CADENCE_HOURS,
  MAX_CADENCE_HOURS,
};
