/**
 * TwoFAJobService - Long-running, queue-backed bulk 2FA password change jobs.
 *
 * Two flavours of job (matching Upgrade 2 in the prompt):
 *   - "bulk":       same old/new password applied to many sessions
 *   - "individual": per-session old/new pair
 *
 * For both flavours each session is processed independently. A failure on
 * one session does not stop the rest of the job. Final result is reported
 * with success/failed counts and per-item status, viewable in the history.
 *
 * Persistence: change_2fa_jobs / change_2fa_job_items.
 * Concurrency: dispatched through BullMQ, executed sequentially per-job to
 * avoid hammering Telegram (each Telegram account can rate-limit independently).
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const telegramService = require('./telegramService');
const { encrypt, decrypt } = require('../utils/crypto');
const { AppError } = require('../utils/errorHandler');

const PER_ITEM_DELAY_MS = 800;

function emit(userId, event, payload) {
  try {
    if (global.io) global.io.to(`user:${userId}`).emit(event, payload);
  } catch (err) {
    logger.debug(`emit ${event} failed: ${err.message}`);
  }
}

class TwoFAJobService {
  /**
   * Create a new bulk-mode change-2FA job.
   *
   * @param {{
   *   userId: number|string,
   *   sessionIds: number[],
   *   oldPassword: string,
   *   newPassword: string
   * }} params
   * @returns {Promise<{jobId:number,total:number}>}
   */
  async createBulkJob({ userId, sessionIds, oldPassword, newPassword }) {
    if (!userId) throw new AppError('User id required', 400, 'MISSING_USER_ID');
    if (!Array.isArray(sessionIds) || sessionIds.length === 0)
      throw new AppError('Select at least one session', 400, 'NO_SESSIONS');
    if (!oldPassword) throw new AppError('Old password required', 400, 'MISSING_OLD_PASSWORD');
    if (!newPassword) throw new AppError('New password required', 400, 'MISSING_NEW_PASSWORD');

    // Verify ownership.
    const owned = await pool.query(
      `SELECT id FROM sessions WHERE id = ANY($1::int[]) AND user_id = $2`,
      [sessionIds.map(Number), userId]
    );
    if (owned.rows.length === 0)
      throw new AppError('No accessible sessions', 404, 'NO_VALID_SESSIONS');

    const ids = owned.rows.map((r) => r.id);
    const oldEnc = encrypt(String(oldPassword));
    const newEnc = encrypt(String(newPassword));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const insert = await client.query(
        `INSERT INTO change_2fa_jobs (user_id, mode, status, total_count, options)
         VALUES ($1, 'bulk', 'pending', $2, $3) RETURNING id`,
        [userId, ids.length, JSON.stringify({ submittedSessionIds: ids })]
      );
      const jobId = insert.rows[0].id;
      for (const sid of ids) {
        await client.query(
          `INSERT INTO change_2fa_job_items
            (job_id, session_id, old_password_enc, new_password_enc)
           VALUES ($1,$2,$3,$4)`,
          [jobId, sid, oldEnc, newEnc]
        );
      }
      await client.query('COMMIT');
      logger.info(`Created bulk 2FA job ${jobId} for user ${userId} with ${ids.length} sessions`);
      // Defer queue add to break circular requires.
      const queue = require('../queues/twoFAQueue');
      await queue.addJob({ jobId, userId });
      return { jobId, total: ids.length };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Create a per-session change-2FA job.
   *
   * @param {{
   *   userId: number|string,
   *   items: Array<{sessionId:number, oldPassword:string, newPassword:string}>
   * }} params
   */
  async createIndividualJob({ userId, items }) {
    if (!userId) throw new AppError('User id required', 400, 'MISSING_USER_ID');
    if (!Array.isArray(items) || items.length === 0)
      throw new AppError('Add at least one session', 400, 'NO_ITEMS');
    for (const it of items) {
      if (!it.sessionId || !it.oldPassword || !it.newPassword) {
        throw new AppError(
          'Each item needs sessionId, oldPassword, newPassword',
          400,
          'BAD_ITEM'
        );
      }
    }

    const ids = items.map((it) => Number(it.sessionId));
    const owned = await pool.query(
      `SELECT id FROM sessions WHERE id = ANY($1::int[]) AND user_id = $2`,
      [ids, userId]
    );
    const ownedSet = new Set(owned.rows.map((r) => r.id));
    const filtered = items.filter((it) => ownedSet.has(Number(it.sessionId)));
    if (filtered.length === 0)
      throw new AppError('No accessible sessions', 404, 'NO_VALID_SESSIONS');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const insert = await client.query(
        `INSERT INTO change_2fa_jobs (user_id, mode, status, total_count)
         VALUES ($1, 'individual', 'pending', $2) RETURNING id`,
        [userId, filtered.length]
      );
      const jobId = insert.rows[0].id;
      for (const it of filtered) {
        await client.query(
          `INSERT INTO change_2fa_job_items
            (job_id, session_id, old_password_enc, new_password_enc)
           VALUES ($1,$2,$3,$4)`,
          [
            jobId,
            Number(it.sessionId),
            encrypt(String(it.oldPassword)),
            encrypt(String(it.newPassword)),
          ]
        );
      }
      await client.query('COMMIT');
      logger.info(
        `Created individual 2FA job ${jobId} for user ${userId} with ${filtered.length} items`
      );
      const queue = require('../queues/twoFAQueue');
      await queue.addJob({ jobId, userId });
      return { jobId, total: filtered.length };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Execute the job (called by the worker).
   * Walks through every item, calls Telegram, records per-item status, and
   * updates aggregate counters on the job row. Errors on individual sessions
   * are recorded but do NOT abort the job.
   */
  async runJob(jobId) {
    const job = await this._fetchJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status === 'completed') return job;

    await pool.query(
      `UPDATE change_2fa_jobs SET status='running', started_at=COALESCE(started_at, NOW()) WHERE id=$1`,
      [jobId]
    );
    emit(job.user_id, 'twofa:job:update', { jobId, status: 'running' });

    const items = (await pool.query(
      `SELECT id, session_id, old_password_enc, new_password_enc, status
       FROM change_2fa_job_items WHERE job_id = $1 ORDER BY id ASC`,
      [jobId]
    )).rows;

    let success = 0;
    let failed = 0;
    for (const item of items) {
      if (item.status === 'success') {
        success++;
        continue;
      }
      const oldPass = safeDecrypt(item.old_password_enc);
      const newPass = safeDecrypt(item.new_password_enc);

      let outcome = { ok: false, errorCode: 'UNKNOWN', errorMessage: 'Unknown error' };
      try {
        // Make sure the session is connected before attempting the change.
        await telegramService._ensureConnected(String(item.session_id));
        await telegramService.change2FA(String(item.session_id), oldPass, newPass);
        outcome = { ok: true };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        let code = 'CHANGE_2FA_FAILED';
        if (/PASSWORD_HASH_INVALID/i.test(message)) code = 'PASSWORD_HASH_INVALID';
        else if (/PASSWORD_REQUIRED/i.test(message)) code = 'PASSWORD_REQUIRED';
        else if (/FLOOD_WAIT/i.test(message)) code = 'FLOOD_WAIT';
        else if (/SESSION/i.test(message)) code = 'SESSION_INVALID';
        outcome = { ok: false, errorCode: code, errorMessage: message };
      }

      if (outcome.ok) {
        success++;
        await pool.query(
          `UPDATE change_2fa_job_items
              SET status='success', processed_at=NOW(), attempts=attempts+1,
                  error_code=NULL, error_message=NULL
            WHERE id=$1`,
          [item.id]
        );
      } else {
        failed++;
        await pool.query(
          `UPDATE change_2fa_job_items
              SET status='failed', processed_at=NOW(), attempts=attempts+1,
                  error_code=$1, error_message=$2
            WHERE id=$3`,
          [outcome.errorCode, outcome.errorMessage, item.id]
        );
      }

      // Live progress to the dashboard.
      await pool.query(
        `UPDATE change_2fa_jobs SET success_count=$1, failed_count=$2 WHERE id=$3`,
        [success, failed, jobId]
      );
      emit(job.user_id, 'twofa:job:progress', {
        jobId,
        sessionId: item.session_id,
        ok: outcome.ok,
        errorCode: outcome.errorCode,
        success,
        failed,
        total: items.length,
      });

      if (PER_ITEM_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, PER_ITEM_DELAY_MS));
      }
    }

    await pool.query(
      `UPDATE change_2fa_jobs SET status='completed', completed_at=NOW(),
              success_count=$1, failed_count=$2
       WHERE id=$3`,
      [success, failed, jobId]
    );
    emit(job.user_id, 'twofa:job:done', { jobId, success, failed, total: items.length });
    logger.info(`2FA job ${jobId} done: success=${success} failed=${failed}`);
    return { jobId, success, failed, total: items.length };
  }

  /**
   * Get list of jobs for a user with summary metadata.
   */
  async listJobs(userId, { limit = 50 } = {}) {
    const r = await pool.query(
      `SELECT id, mode, status, total_count, success_count, failed_count,
              created_at, started_at, completed_at, error_message
       FROM change_2fa_jobs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)]
    );
    return r.rows;
  }

  /**
   * Get full job detail including per-session items.
   *
   * Per-item credentials are decrypted from the at-rest cipher so the panel's
   * history view can show what was changed (old vs. new) for each task. Old
   * rows benefit automatically because the encrypted columns have always been
   * populated since the table was introduced.
   */
  async getJob(jobId, userId) {
    const job = await this._fetchJob(jobId);
    if (!job || job.user_id !== Number(userId))
      throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    const rows = (await pool.query(
      `SELECT i.id, i.session_id, i.status, i.error_code, i.error_message,
              i.attempts, i.created_at, i.processed_at,
              i.old_password_enc, i.new_password_enc,
              s.phone, s.account_info
       FROM change_2fa_job_items i
       LEFT JOIN sessions s ON s.id = i.session_id
       WHERE i.job_id = $1
       ORDER BY i.id ASC`,
      [jobId]
    )).rows;
    const items = rows.map((row) => {
      const { old_password_enc, new_password_enc, ...rest } = row;
      return {
        ...rest,
        old_password: tryDecrypt(old_password_enc),
        new_password: tryDecrypt(new_password_enc),
      };
    });
    return { ...job, items };
  }

  async _fetchJob(jobId) {
    const r = await pool.query(`SELECT * FROM change_2fa_jobs WHERE id = $1`, [jobId]);
    return r.rows[0] || null;
  }
}

function safeDecrypt(text) {
  try {
    return decrypt(text);
  } catch (err) {
    throw new AppError(`Stored credential could not be decrypted: ${err.message}`, 500, 'CRYPTO_FAILED');
  }
}

/**
 * Non-throwing decrypt used for surfacing history. Returns null when the
 * ciphertext is missing or unreadable (e.g. key rotation) so the panel can
 * still render the row without crashing the whole request.
 */
function tryDecrypt(text) {
  if (!text) return null;
  try {
    return decrypt(text);
  } catch (err) {
    logger.debug(`tryDecrypt failed: ${err.message}`);
    return null;
  }
}

module.exports = new TwoFAJobService();
