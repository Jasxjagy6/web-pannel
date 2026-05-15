/**
 * Lookup audit service — PR #8.
 *
 * Append-only log of operator actions on the lookup module. Every
 * job-creation, paid-API call, watch-create, budget warning, and
 * retention purge writes a row.
 *
 * Retention: 90 days default per row (`retained_until`), enforced by
 * `lookupRetentionWorker`.
 */

'use strict';

const { pool } = require('../config/database');
const logger = require('../utils/logger');

/**
 * @param {Object} entry
 * @param {number} entry.userId
 * @param {number} [entry.jobId]
 * @param {string} [entry.username]
 * @param {string} entry.action       — one of the recognised action codes
 * @param {string} [entry.method]
 * @param {string} [entry.statedPurpose]
 * @param {string} [entry.clientIp]
 * @param {Object} [entry.meta]
 * @param {number} [entry.costUsd]
 * @param {number} [entry.retentionDays]  — defaults to 90
 */
async function log(entry) {
  if (!entry || !entry.action) return;
  const retentionDays = Number.isFinite(entry.retentionDays) ? entry.retentionDays : 90;
  try {
    await pool.query(
      `INSERT INTO lookup_audit_log
         (user_id, job_id, username, action, method, stated_purpose, client_ip,
          meta, cost_usd, retained_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
               NOW() + ($10 || ' days')::interval)`,
      [
        entry.userId || null,
        entry.jobId || null,
        entry.username ? String(entry.username).slice(0, 64) : null,
        String(entry.action).slice(0, 40),
        entry.method ? String(entry.method).slice(0, 40) : null,
        entry.statedPurpose ? String(entry.statedPurpose).slice(0, 4000) : null,
        entry.clientIp ? String(entry.clientIp).slice(0, 64) : null,
        JSON.stringify(entry.meta || {}),
        Number(entry.costUsd) || 0,
        String(retentionDays),
      ]
    );
  } catch (err) {
    logger.warn(`lookupAudit.log failed (${entry.action}): ${err.message}`);
  }
}

async function list({ userId, jobId, action, page = 1, limit = 100 }) {
  const limitN = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const pageN  = Math.max(1, parseInt(page, 10) || 1);
  const offset = (pageN - 1) * limitN;
  const where  = [];
  const params = [];
  if (userId) { params.push(userId);  where.push(`user_id = $${params.length}`); }
  if (jobId)  { params.push(jobId);   where.push(`job_id  = $${params.length}`); }
  if (action) { params.push(action);  where.push(`action  = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limitN);
  params.push(offset);
  const { rows } = await pool.query(
    `SELECT id, user_id, job_id, username, action, method, stated_purpose,
            client_ip, meta, cost_usd, retained_until, created_at
       FROM lookup_audit_log
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

/**
 * Hard-delete audit rows whose `retained_until` is in the past. Called
 * by the retention worker. Returns the number of rows deleted.
 */
async function purgeExpired() {
  try {
    const res = await pool.query(
      `DELETE FROM lookup_audit_log WHERE retained_until < NOW()`
    );
    return res.rowCount || 0;
  } catch (err) {
    logger.warn(`lookupAudit.purgeExpired failed: ${err.message}`);
    return 0;
  }
}

module.exports = {
  log,
  list,
  purgeExpired,
};
