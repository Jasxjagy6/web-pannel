/**
 * OtpService - Get OTP login-code scanner (Upgrade 3).
 *
 * Behaviour:
 *   - User selects N sessions, hits "Confirm".
 *   - We create an otp_jobs row + one otp_job_items row per session, set the
 *     job to "scanning" with a 5-minute window (configurable per request).
 *   - For every selected session we register a Telegram NewMessage handler
 *     looking for messages from the official Telegram service (id 777000 or
 *     username "Telegram"). When such a message arrives we extract the OTP
 *     using a robust regex, persist it, and emit otp:detected over WebSocket.
 *   - When the window expires the job is closed; sessions still scanning are
 *     marked "expired".
 *   - WebSocket events allow the frontend to update the history live without
 *     polling.
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const telegramService = require('./telegramService');
const { AppError } = require('../utils/errorHandler');

const DEFAULT_DURATION_SECONDS = 300; // 5 minutes
const TELEGRAM_SERVICE_USER_ID = '777000';

const OTP_REGEXES = [
  /\blogin code:?\s*([A-Z0-9]{4,8})\b/i,
  /\bcode:?\s*([A-Z0-9]{4,8})\b/i,
  /\b(\d{5,7})\b/,
];

function emit(userId, event, payload) {
  try {
    if (global.io) global.io.to(`user:${userId}`).emit(event, payload);
  } catch (err) {
    logger.debug(`emit ${event} failed: ${err.message}`);
  }
}

/**
 * Try to extract an OTP code from a Telegram service message body.
 * Returns null when nothing looks like a code.
 */
function extractOtp(text) {
  if (!text) return null;
  for (const re of OTP_REGEXES) {
    const m = text.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

class OtpService {
  constructor() {
    /** active scans keyed by jobId, value = { unsubs: Map<sessionId, fn>, timer } */
    this._activeScans = new Map();
  }

  // -----------------------------------------------------------------------
  // Job lifecycle
  // -----------------------------------------------------------------------

  /**
   * Create a new OTP scan job.
   *
   * @param {{userId:number|string, sessionIds:number[], durationSeconds?:number}} params
   */
  async createJob({ userId, sessionIds, durationSeconds }) {
    if (!userId) throw new AppError('User id required', 400, 'MISSING_USER_ID');
    if (!Array.isArray(sessionIds) || sessionIds.length === 0)
      throw new AppError('Select at least one session', 400, 'NO_SESSIONS');

    const owned = await pool.query(
      `SELECT id, phone FROM sessions
       WHERE id = ANY($1::int[]) AND user_id = $2 AND is_logged_in = TRUE`,
      [sessionIds.map(Number), userId]
    );
    if (owned.rows.length === 0)
      throw new AppError(
        'No logged-in sessions selected',
        404,
        'NO_VALID_SESSIONS'
      );

    const duration = Math.max(60, Math.min(durationSeconds || DEFAULT_DURATION_SECONDS, 1800));
    const ids = owned.rows.map((r) => r.id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const insert = await client.query(
        `INSERT INTO otp_jobs (user_id, status, total_count, duration_seconds,
                               started_at, expires_at)
         VALUES ($1, 'scanning', $2, $3::int, NOW(),
                 NOW() + ($3::int || ' seconds')::interval)
         RETURNING id, created_at, started_at, expires_at`,
        [userId, ids.length, duration]
      );
      const job = insert.rows[0];
      for (const sid of ids) {
        await client.query(
          `INSERT INTO otp_job_items (job_id, session_id, status)
           VALUES ($1, $2, 'scanning')`,
          [job.id, sid]
        );
      }
      await client.query('COMMIT');

      logger.info(`OTP job ${job.id} created for user ${userId}`, {
        sessionCount: ids.length, duration,
      });

      // Register Telegram listeners.
      await this._startScan(job.id, userId, ids, duration);

      return {
        jobId: job.id,
        total: ids.length,
        durationSeconds: duration,
        startedAt: job.started_at,
        expiresAt: job.expires_at,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async _startScan(jobId, userId, sessionIds, durationSeconds) {
    const unsubs = new Map();
    for (const sid of sessionIds) {
      try {
        const off = await telegramService.addNewMessageHandler(String(sid), (event) =>
          this._onMessage(jobId, userId, sid, event.message || event)
        );
        unsubs.set(sid, off);
      } catch (err) {
        logger.warn(`OTP scan: cannot attach to session ${sid}: ${err.message}`);
        await pool.query(
          `UPDATE otp_job_items
           SET status = 'failed', raw_message = $1, detected_at = NOW()
           WHERE job_id = $2 AND session_id = $3`,
          [`attach error: ${err.message}`, jobId, sid]
        );
        emit(userId, 'otp:item:update', {
          jobId,
          sessionId: sid,
          status: 'failed',
          error: err.message,
        });
      }
    }

    const timer = setTimeout(
      () => this._finishJob(jobId, userId).catch((e) =>
        logger.error(`finishJob error for ${jobId}: ${e.message}`)
      ),
      durationSeconds * 1000
    );

    this._activeScans.set(jobId, { unsubs, timer, userId });
    emit(userId, 'otp:job:started', { jobId, total: sessionIds.length });
  }

  /**
   * Process an incoming Telegram message for one of our scanned sessions.
   */
  async _onMessage(jobId, userId, sessionId, message) {
    try {
      // Filter to messages from the Telegram service account.
      const senderId = String(
        message?.peerId?.userId || message?.fromId?.userId || message?.senderId || ''
      );
      const text = message?.message || message?.text || '';

      if (senderId && senderId !== TELEGRAM_SERVICE_USER_ID && !/telegram/i.test(text)) {
        return;
      }

      const otp = extractOtp(text);
      if (!otp) return;

      // Persist on first match per (job, session).
      const upd = await pool.query(
        `UPDATE otp_job_items
         SET otp_code = $1, raw_message = $2, status='detected', detected_at=NOW()
         WHERE job_id = $3 AND session_id = $4 AND otp_code IS NULL
         RETURNING id`,
        [otp, text.slice(0, 500), jobId, sessionId]
      );
      if (upd.rowCount === 0) return; // already reported

      await pool.query(
        `UPDATE otp_jobs SET detected_count = detected_count + 1 WHERE id = $1`,
        [jobId]
      );

      logger.info(`OTP detected on session ${sessionId} for job ${jobId}: ${otp}`);
      emit(userId, 'otp:detected', {
        jobId,
        sessionId,
        otp,
        message: text.slice(0, 500),
        detectedAt: new Date().toISOString(),
      });
      // Detach this session listener early — we have the OTP, no need to keep it.
      const ctx = this._activeScans.get(jobId);
      if (ctx) {
        const off = ctx.unsubs.get(sessionId);
        if (off) {
          try { off(); } catch { /* ignore */ }
          ctx.unsubs.delete(sessionId);
        }
        // If everyone has reported in, finish early.
        const remaining = (await pool.query(
          `SELECT COUNT(*)::int AS c FROM otp_job_items WHERE job_id = $1 AND status = 'scanning'`,
          [jobId]
        )).rows[0].c;
        if (remaining === 0) {
          clearTimeout(ctx.timer);
          await this._finishJob(jobId, userId);
        }
      }
    } catch (err) {
      logger.warn(`_onMessage error: ${err.message}`);
    }
  }

  async _finishJob(jobId, userId) {
    const ctx = this._activeScans.get(jobId);
    if (ctx) {
      try { clearTimeout(ctx.timer); } catch { /* ignore */ }
      for (const off of ctx.unsubs.values()) {
        try { off(); } catch { /* ignore */ }
      }
      this._activeScans.delete(jobId);
    }
    // Mark any still-scanning items as expired.
    await pool.query(
      `UPDATE otp_job_items SET status='expired', detected_at=NOW()
       WHERE job_id=$1 AND status='scanning'`,
      [jobId]
    );
    await pool.query(
      `UPDATE otp_jobs SET status='completed', completed_at=NOW() WHERE id=$1`,
      [jobId]
    );
    const summary = await this.getJob(jobId, userId).catch(() => null);
    emit(userId, 'otp:job:done', {
      jobId,
      detected: summary?.detected_count || 0,
      total: summary?.total_count || 0,
    });
    logger.info(`OTP job ${jobId} finished`);
  }

  /**
   * On startup, resume any scans that haven't expired yet (e.g. after a
   * container restart) so they continue listening for the rest of the window.
   */
  async resumeActiveScans() {
    try {
      const r = await pool.query(
        `SELECT j.id, j.user_id, j.expires_at,
                ARRAY_AGG(i.session_id) AS session_ids
           FROM otp_jobs j
           JOIN otp_job_items i ON i.job_id = j.id
          WHERE j.status = 'scanning' AND j.expires_at > NOW()
          GROUP BY j.id`
      );
      for (const row of r.rows) {
        const remaining = Math.max(
          1,
          Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 1000)
        );
        await this._startScan(row.id, row.user_id, row.session_ids, remaining);
      }
      // Anything past expiry that is still "scanning": close it.
      await pool.query(
        `UPDATE otp_jobs SET status='completed', completed_at=NOW()
         WHERE status='scanning' AND expires_at <= NOW()`
      );
      await pool.query(
        `UPDATE otp_job_items SET status='expired'
         WHERE status='scanning'
           AND job_id IN (SELECT id FROM otp_jobs WHERE status='completed')`
      );
    } catch (err) {
      logger.error(`resumeActiveScans failed: ${err.message}`);
    }
  }

  async listJobs(userId, { limit = 50 } = {}) {
    const r = await pool.query(
      `SELECT id, status, total_count, detected_count, duration_seconds,
              created_at, started_at, expires_at, completed_at
       FROM otp_jobs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)]
    );
    return r.rows;
  }

  async getJob(jobId, userId) {
    const job = (await pool.query(`SELECT * FROM otp_jobs WHERE id = $1`, [jobId])).rows[0];
    if (!job || job.user_id !== Number(userId))
      throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    const items = (await pool.query(
      `SELECT i.id, i.session_id, i.status, i.otp_code, i.raw_message,
              i.detected_at, i.created_at,
              s.phone, s.account_info
       FROM otp_job_items i
       LEFT JOIN sessions s ON s.id = i.session_id
       WHERE i.job_id = $1
       ORDER BY i.id ASC`,
      [jobId]
    )).rows;
    return { ...job, items };
  }
}

module.exports = new OtpService();
