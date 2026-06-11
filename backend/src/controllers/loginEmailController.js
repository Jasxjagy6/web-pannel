/**
 * loginEmailController
 * --------------------------------------------------------------------
 * REST surface for Bulk Login Email Setup using Google OAuth.
 */

const { google } = require('googleapis');
const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const reportService = require('../services/reportService');
const logger = require('../utils/logger');
const loginEmailQueue = require('../queues/loginEmailQueue');

function getOAuthClient(redirectUri) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID || 'dummy-client-id',
    process.env.GOOGLE_CLIENT_SECRET || 'dummy-client-secret',
    redirectUri
  );
}

const loginEmailController = {
  /** GET /api/login-email/google-auth-url */
  getGoogleAuthUrl: asyncHandler(async (req, res) => {
    const { redirectUri } = req.query;
    if (!redirectUri) {
      throw new AppError('redirectUri is required', 400, 'BAD_REQUEST');
    }
    
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      throw new AppError('Google OAuth is not configured on the server. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', 500, 'NOT_CONFIGURED');
    }

    const oauth2Client = getOAuthClient(redirectUri);
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/userinfo.email'],
      prompt: 'consent' // force to get refresh token
    });

    return res.json({ success: true, data: { url } });
  }),

  /** POST /api/login-email/google-callback */
  googleCallback: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { code, redirectUri } = req.body;
    if (!code || !redirectUri) {
      throw new AppError('code and redirectUri are required', 400, 'BAD_REQUEST');
    }

    const oauth2Client = getOAuthClient(redirectUri);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user email
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    if (!email) {
      throw new AppError('Could not retrieve email from Google', 400, 'NO_EMAIL');
    }

    // Save to DB
    await pool.query(
      `INSERT INTO gmail_accounts (user_id, email, access_token, refresh_token, expiry_date)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, email) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           refresh_token = COALESCE(EXCLUDED.refresh_token, gmail_accounts.refresh_token),
           expiry_date = EXCLUDED.expiry_date`,
      [userId, email, tokens.access_token, tokens.refresh_token || null, tokens.expiry_date || null]
    );

    return res.json({ success: true, data: { email } });
  }),

  /** GET /api/login-email/gmail-accounts */
  listGmailAccounts: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { rows } = await pool.query(
      `SELECT id, email, created_at FROM gmail_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return res.json({ success: true, data: { items: rows } });
  }),

  /** DELETE /api/login-email/gmail-accounts/:id */
  deleteGmailAccount: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const accountId = Number(req.params.id);
    await pool.query(
      `DELETE FROM gmail_accounts WHERE id = $1 AND user_id = $2`,
      [accountId, userId]
    );
    return res.json({ success: true });
  }),

  /** POST /api/login-email/jobs */
  createJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionIds } = req.body;
    
    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('Provide at least one session', 400, 'NO_ITEMS');
    }

    // Restrict to active logged-in sessions owned by user
    const { rows: ownedRows } = await pool.query(
      `SELECT id FROM sessions
        WHERE user_id = $1
          AND id = ANY($2::int[])
          AND is_logged_in = true
          AND status IN ('active','uploaded')`,
      [userId, sessionIds]
    );
    const validSessionIds = ownedRows.map((r) => r.id);

    if (validSessionIds.length === 0) {
      throw new AppError('None of the selected sessions are usable for this account', 400, 'NO_OWNED_SESSIONS');
    }

    // Get available Gmail accounts (one per session)
    const { rows: gmailAccounts } = await pool.query(
      `SELECT id, email FROM gmail_accounts WHERE user_id = $1`,
      [userId]
    );

    if (gmailAccounts.length === 0) {
      throw new AppError('No Gmail accounts connected. Please connect at least one Gmail account first.', 400, 'NO_GMAIL');
    }

    // Assign round-robin or randomly
    const validItems = validSessionIds.map((sessionId, index) => {
      const gmail = gmailAccounts[index % gmailAccounts.length];
      return { sessionId, email: gmail.email, gmailAccountId: gmail.id };
    });

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
        `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`
      ).join(', ');
      
      const values = [jobId];
      validItems.forEach(i => {
        values.push(i.sessionId, i.email, i.gmailAccountId);
      });

      await client.query(
        `INSERT INTO login_email_job_items (job_id, session_id, email, gmail_account_id)
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
        skipped: sessionIds.length - validItems.length,
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
