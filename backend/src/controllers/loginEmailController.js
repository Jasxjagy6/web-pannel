/**
 * loginEmailController
 * --------------------------------------------------------------------
 * REST surface for Bulk Login Email Setup.
 */

const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const reportService = require('../services/reportService');
const { resolveSessionIdsFromRequest } = require('../utils/resolveSessions');
const logger = require('../utils/logger');
const loginEmailQueue = require('../queues/loginEmailQueue');

const loginEmailController = {
  /** POST /api/login-email/jobs */
  createJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { items, sessionIds } = req.body;
    // items is an array of { sessionId, email, imapPassword, imapHost, imapPort }
    // Or, if user selects sessions and provides a single catch-all/global setting
    // But let's assume the frontend sends `items` which maps sessionIds to email credentials.
    
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new AppError('Provide at least one session with email credentials', 400, 'NO_ITEMS');
    }

    const requestedIds = items.map(i => i.sessionId);
    
    // Restrict to active logged-in sessions owned by user
    const { rows: ownedRows } = await pool.query(
      `SELECT id FROM sessions
        WHERE user_id = $1
          AND id = ANY($2::int[])
          AND is_logged_in = true
          AND status IN ('active','uploaded')`,
      [userId, requestedIds]
    );
    const ownedIds = new Set(ownedRows.map((r) => r.id));
    
    const validItems = items.filter(i => ownedIds.has(i.sessionId));

    if (validItems.length === 0) {
      throw new AppError('None of the selected sessions are usable for this account', 400, 'NO_OWNED_SESSIONS');
    }

    const client = await pool.connect();
    let jobId;
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO login_email_jobs (user_id, status, total_sessions)
         VALUES ($1, 'pending', $2)
         RETURNING id`,
        [userId, validItems.length]
      );
      jobId = ins.rows[0].id;

      // Bulk-insert items
      const placeholders = validItems.map((_, i) => 
        `($1, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`
      ).join(', ');
      
      const values = [jobId];
      validItems.forEach(i => {
        values.push(i.sessionId, i.email, i.imapPassword, i.imapHost, i.imapPort);
      });

      await client.query(
        `INSERT INTO login_email_job_items (job_id, session_id, email, imap_password, imap_host, imap_port)
         VALUES ${placeholders}`,
        values
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    reportService
      .logActivity(userId, 'login_email_job_queued', 'login_email_job', jobId, {
        sessionCount: validItems.length,
      })
      .catch(() => {});

    logger.info(`login email job ${jobId} queued by user ${userId} (${validItems.length} sessions)`);
    
    // Add to BullMQ
    await loginEmailQueue.add('processLoginEmailJob', { jobId }, { jobId: String(jobId) });

    return res.status(201).json({
      success: true,
      data: {
        jobId,
        sessionCount: validItems.length,
        skipped: requestedIds.length - validItems.length,
      },
    });
  }),

  /** GET /api/login-email/jobs */
  listJobs: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const { rows } = await pool.query(
      `SELECT id, status, total_sessions, succeeded_count,
              failed_count, skipped_count, error_message, cancel_requested,
              created_at, started_at, finished_at
         FROM login_email_jobs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit]
    );
    return res.json({ success: true, data: { items: rows } });
  }),

  /** GET /api/login-email/jobs/:id/items */
  getJobItems: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = Number(req.params.id);
    if (!jobId) throw new AppError('Invalid job id', 400, 'BAD_ID');
    
    const owned = await pool.query(
      `SELECT 1 FROM login_email_jobs WHERE id = $1 AND user_id = $2`,
      [jobId, userId]
    );
    if (owned.rowCount === 0) {
      throw new AppError('Job not found', 404, 'NOT_FOUND');
    }
    
    const { rows } = await pool.query(
      `SELECT items.id, items.session_id, items.email, items.status,
              items.error_code, items.error_message, items.attempts,
              items.started_at, items.finished_at,
              s.phone AS phone,
              (s.account_info->>'firstName') AS first_name,
              (s.account_info->>'lastName')  AS last_name,
              (s.account_info->>'username')  AS username
         FROM login_email_job_items items
         JOIN sessions s ON s.id = items.session_id
        WHERE items.job_id = $1
        ORDER BY items.id ASC`,
      [jobId]
    );
    return res.json({ success: true, data: { items: rows } });
  }),

  /** POST /api/login-email/jobs/:id/cancel */
  cancelJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = Number(req.params.id);
    if (!jobId) throw new AppError('Invalid job id', 400, 'BAD_ID');
    const { rowCount } = await pool.query(
      `UPDATE login_email_jobs
          SET cancel_requested = TRUE
        WHERE id = $1 AND user_id = $2
          AND status IN ('pending','running')`,
      [jobId, userId]
    );
    if (rowCount === 0) {
      throw new AppError('Job not found or already finished', 404, 'NOT_CANCELLABLE');
    }
    reportService
      .logActivity(userId, 'login_email_job_cancel_requested', 'login_email_job', jobId, {})
      .catch(() => {});
    return res.json({ success: true });
  }),
};

module.exports = loginEmailController;
