'use strict';

const { pool } = require('../config/database');
const telegramService = require('./telegramService');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');

function normalizeTarget(value) {
  let target = String(value || '').trim();
  if (!target) return null;
  target = target.replace(/[?#].*$/, '').replace(/\/$/, '');
  const publicLink = target.match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([^/]+)$/i);
  if (publicLink && !['joinchat', 'c'].includes(publicLink[1].toLowerCase())) {
    target = `@${publicLink[1]}`;
  }
  return target;
}

function normalizeTargets(values) {
  const targets = Array.from(new Set((values || []).map(normalizeTarget).filter(Boolean)));
  if (targets.length === 0) throw new AppError('Enter at least one group or channel', 400, 'NO_TARGETS');
  if (targets.length > 100) throw new AppError('A boost job supports at most 100 targets', 400, 'TOO_MANY_TARGETS');
  return targets;
}

function labelFor(row) {
  const info = row.account_info || {};
  if (row.username) return `@${row.username}`;
  if (info.username) return `@${info.username}`;
  return [info.firstName, info.lastName].filter(Boolean).join(' ') || row.phone || `Session #${row.id}`;
}

class BoostService {
  async listPremiumAccounts(userId, { refresh = false } = {}) {
    const { rows } = await pool.query(
      `SELECT id, phone, username, status, is_logged_in, account_info, last_active
         FROM sessions
        WHERE user_id = $1 AND platform = 'telegram' AND is_logged_in = TRUE
        ORDER BY id DESC`,
      [userId]
    );

    if (refresh) {
      let cursor = 0;
      const runners = Array.from({ length: Math.min(4, rows.length) }, async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++];
          try {
            const me = await telegramService.getMe(row.id);
            row.account_info = { ...(row.account_info || {}), ...me };
            row.username = me.username || row.username;
            await pool.query(
              `UPDATE sessions
                  SET account_info = COALESCE(account_info, '{}'::jsonb) || $2::jsonb,
                      username = COALESCE($3, username), phone = COALESCE($4, phone)
                WHERE id = $1 AND user_id = $5`,
              [row.id, JSON.stringify(me), me.username || null, me.phone || null, userId]
            );
          } catch (error) {
            row.refreshError = error.message;
          }
        }
      });
      await Promise.all(runners);
    }

    return rows
      .filter((row) => row.account_info?.isPremium === true)
      .map((row) => ({
        id: row.id,
        phone: row.phone,
        username: row.username || row.account_info?.username || null,
        firstName: row.account_info?.firstName || null,
        lastName: row.account_info?.lastName || null,
        label: labelFor(row),
        status: row.status,
        isLoggedIn: row.is_logged_in,
        isPremium: true,
        lastActive: row.last_active,
        refreshError: row.refreshError || null,
      }));
  }

  async inspectAccount(userId, sessionId) {
    const { rows } = await pool.query(
      `SELECT id, account_info FROM sessions
        WHERE id = $1 AND user_id = $2 AND platform = 'telegram' AND is_logged_in = TRUE`,
      [sessionId, userId]
    );
    if (!rows.length) throw new AppError('Premium account not found', 404, 'SESSION_NOT_FOUND');
    const me = await telegramService.getMe(sessionId);
    if (!me.isPremium) throw new AppError('This Telegram account is not Premium', 400, 'NOT_PREMIUM');
    return telegramService.getMyBoostSlots(sessionId);
  }

  async createJob({ sessionIds, targets }, userId) {
    const normalizedTargets = normalizeTargets(targets);
    const ids = Array.from(new Set(
      (sessionIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)
    ));
    if (!ids.length) throw new AppError('Select at least one Premium account', 400, 'NO_SESSIONS');
    if (ids.length > 500) throw new AppError('A boost job supports at most 500 accounts', 400, 'TOO_MANY_SESSIONS');

    const { rows } = await pool.query(
      `SELECT id, phone, username, status, is_logged_in, account_info
         FROM sessions
        WHERE id = ANY($1::int[]) AND user_id = $2 AND platform = 'telegram'`,
      [ids, userId]
    );
    if (rows.length !== ids.length) throw new AppError('One or more accounts are invalid', 400, 'INVALID_SESSIONS');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query(
        `INSERT INTO boost_jobs (user_id, targets, total_sessions)
         VALUES ($1, $2, $3) RETURNING id`,
        [userId, JSON.stringify(normalizedTargets), rows.length]
      );
      const jobId = created.rows[0].id;
      for (const row of rows) {
        let status = 'pending';
        let skipReason = null;
        if (!row.is_logged_in) {
          status = 'skipped';
          skipReason = 'not_connected';
        } else if (row.account_info?.isPremium !== true) {
          status = 'skipped';
          skipReason = 'not_premium';
        }
        const finishedAt = status === 'skipped' ? 'NOW()' : null;
        await client.query(
          `INSERT INTO boost_job_items (job_id, session_id, session_label, status, skip_reason, finished_at)
           VALUES ($1,$2,$3,$4,$5,${finishedAt})`,
          [jobId, row.id, labelFor(row), status, skipReason]
        );
      }
      const skipped = rows.filter((row) => !row.is_logged_in || row.account_info?.isPremium !== true).length;
      if (skipped) {
        await client.query(
          `UPDATE boost_jobs SET skipped_count = $2, processed_count = $2 WHERE id = $1`,
          [jobId, skipped]
        );
      }
      await client.query('COMMIT');
      return { jobId, totalAccounts: rows.length, eligibleAccounts: rows.length - skipped, skipped, targets: normalizedTargets };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listJobs(userId, { limit = 25 } = {}) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
    const { rows } = await pool.query(
      `SELECT * FROM boost_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, safeLimit]
    );
    return rows;
  }

  async getJob(jobId, userId) {
    const { rows } = await pool.query(`SELECT * FROM boost_jobs WHERE id = $1 AND user_id = $2`, [jobId, userId]);
    if (!rows.length) throw new AppError('Boost job not found', 404, 'BOOST_JOB_NOT_FOUND');
    const { rows: items } = await pool.query(`SELECT * FROM boost_job_items WHERE job_id = $1 ORDER BY id`, [jobId]);
    return { ...rows[0], items };
  }

  async cancelJob(jobId, userId) {
    const { rows } = await pool.query(
      `UPDATE boost_jobs SET cancel_requested = TRUE
        WHERE id = $1 AND user_id = $2 AND status IN ('pending','running') RETURNING id`,
      [jobId, userId]
    );
    if (!rows.length) throw new AppError('Active boost job not found', 404, 'BOOST_JOB_NOT_FOUND');
    return { cancelled: true };
  }
}

module.exports = new BoostService();
