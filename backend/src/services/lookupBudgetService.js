/**
 * Lookup paid-API budget service — PR #8.
 *
 * Per-(user, year-month) USD cap. The lookup pipeline calls
 * `assertCanSpend(userId, estCostUsd)` BEFORE any paid API call —
 * if the cap would be exceeded, the call short-circuits with a
 * `budget_exceeded` error so the operator sees exactly why a probe
 * returned nothing.
 *
 * Warning threshold: at 80% of cap, the service emits a Socket.IO
 * `lookup_budget_warn` event (best-effort) and writes an audit row.
 *
 * Default cap is taken from `LOOKUP_BUDGET_USD_CAP_DEFAULT` env (or 50).
 */

'use strict';

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const lookupAudit = require('./lookupAuditService');

function _currentYearMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function _defaultCap() {
  const v = Number(process.env.LOOKUP_BUDGET_USD_CAP_DEFAULT);
  return Number.isFinite(v) && v > 0 ? v : 50;
}

/**
 * Get or create the current month's budget row for a user.
 */
async function _getOrCreate(userId) {
  if (!userId) return null;
  const ym = _currentYearMonth();
  await pool.query(
    `INSERT INTO lookup_org_budgets (user_id, year_month, budget_cap_usd)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, year_month) DO NOTHING`,
    [userId, ym, _defaultCap()]
  );
  const { rows } = await pool.query(
    `SELECT id, user_id, year_month, budget_cap_usd, spent_usd,
            warn_at_pct, hard_block_at_pct, updated_at
       FROM lookup_org_budgets
      WHERE user_id = $1 AND year_month = $2`,
    [userId, ym]
  );
  return rows[0] || null;
}

async function getCurrent(userId) {
  return _getOrCreate(userId);
}

async function listAll() {
  const { rows } = await pool.query(
    `SELECT b.id, b.user_id, u.email, b.year_month, b.budget_cap_usd, b.spent_usd,
            b.warn_at_pct, b.hard_block_at_pct, b.updated_at
       FROM lookup_org_budgets b
       LEFT JOIN users u ON u.id = b.user_id
      ORDER BY b.year_month DESC, b.user_id ASC`
  );
  return rows;
}

async function setCap({ userId, capUsd, warnAtPct, hardBlockAtPct }) {
  if (!userId) throw new Error('userId required');
  const ym = _currentYearMonth();
  const cap = Math.max(0, Number(capUsd) || 0);
  await pool.query(
    `INSERT INTO lookup_org_budgets (user_id, year_month, budget_cap_usd, warn_at_pct, hard_block_at_pct)
     VALUES ($1, $2, $3, COALESCE($4, 80), COALESCE($5, 100))
     ON CONFLICT (user_id, year_month)
     DO UPDATE SET budget_cap_usd    = EXCLUDED.budget_cap_usd,
                   warn_at_pct       = COALESCE(EXCLUDED.warn_at_pct, lookup_org_budgets.warn_at_pct),
                   hard_block_at_pct = COALESCE(EXCLUDED.hard_block_at_pct, lookup_org_budgets.hard_block_at_pct),
                   updated_at        = NOW()`,
    [userId, ym, cap, warnAtPct || null, hardBlockAtPct || null]
  );
  return _getOrCreate(userId);
}

/**
 * Pre-spend check. Returns:
 *   { allowed: true,  warn?: 'pct', remaining }
 *   { allowed: false, reason: 'budget_exceeded', cap, spent }
 */
async function assertCanSpend(userId, estCostUsd) {
  if (!userId || !(estCostUsd > 0)) return { allowed: true, remaining: Infinity };
  const row = await _getOrCreate(userId);
  if (!row) return { allowed: true, remaining: Infinity };
  const cap = Number(row.budget_cap_usd) || 0;
  const spent = Number(row.spent_usd) || 0;
  const projected = spent + Number(estCostUsd);
  const hardPct = Number(row.hard_block_at_pct) || 100;
  const hardCap = cap * (hardPct / 100);
  if (cap > 0 && projected > hardCap) {
    return {
      allowed: false,
      reason: 'budget_exceeded',
      cap,
      spent,
      projected,
      pct: cap > 0 ? Math.round((spent / cap) * 100) : 0,
    };
  }
  const warnPct = Number(row.warn_at_pct) || 80;
  const warnCap = cap * (warnPct / 100);
  const willWarn = cap > 0 && projected > warnCap && spent <= warnCap;
  return {
    allowed: true,
    warn: willWarn ? warnPct : null,
    cap,
    spent,
    projected,
    remaining: Math.max(0, cap - projected),
  };
}

/**
 * Record a paid-API spend AFTER the call completes. Also emits the
 * 80%-warning Socket.IO event the first time the projected spend
 * crossed the threshold.
 */
async function recordSpend({ userId, provider, costUsd, jobId, method }) {
  if (!userId || !(costUsd > 0)) return;
  const row = await _getOrCreate(userId);
  if (!row) return;
  const before = Number(row.spent_usd) || 0;
  const cap = Number(row.budget_cap_usd) || 0;
  const warnPct = Number(row.warn_at_pct) || 80;
  await pool.query(
    `UPDATE lookup_org_budgets
        SET spent_usd  = spent_usd + $2,
            updated_at = NOW()
      WHERE id = $1`,
    [row.id, Number(costUsd)]
  );
  const after = before + Number(costUsd);
  if (cap > 0 && after > cap * (warnPct / 100) && before <= cap * (warnPct / 100)) {
    try {
      lookupAudit.log({
        userId,
        jobId: jobId || null,
        action: 'budget_warn',
        method: method || provider,
        meta: { provider, costUsd, cap, after, warnPct },
      });
    } catch (_e) { /* swallow */ }
    if (global.io) {
      try {
        global.io.to(`user:${userId}`).emit('lookup_budget_warn', {
          provider,
          costUsd,
          cap,
          spent: after,
          warnPct,
          jobId: jobId || null,
        });
      } catch (err) {
        logger.warn(`lookupBudget: socket emit failed: ${err.message}`);
      }
    }
  }
  return after;
}

module.exports = {
  getCurrent,
  listAll,
  setCap,
  assertCanSpend,
  recordSpend,
  _currentYearMonth,
};
