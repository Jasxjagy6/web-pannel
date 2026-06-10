/**
 * loginMailController
 * --------------------------------------------------------------------
 * REST surface for the Login-Mail feature (set a login email on
 * Telegram sessions with automated IMAP-based OTP reading).
 *
 * Credential management:
 *   POST   /api/privacy/login-mail/credentials            → save creds
 *   GET    /api/privacy/login-mail/credentials             → list
 *   DELETE /api/privacy/login-mail/credentials/:id         → remove
 *   POST   /api/privacy/login-mail/credentials/:id/test   → test IMAP
 *   POST   /api/privacy/login-mail/credentials/detect     → auto-detect IMAP
 *
 * Job management:
 *   POST   /api/privacy/login-mail/jobs                   → create job
 *   GET    /api/privacy/login-mail/jobs                    → list jobs
 *   GET    /api/privacy/login-mail/jobs/:id                → single job
 *   GET    /api/privacy/login-mail/jobs/:id/items          → per-session
 *   POST   /api/privacy/login-mail/jobs/:id/cancel         → cancel
 *
 * Manual (non-automated) flow:
 *   POST   /api/privacy/login-mail/send-code              → send code
 *   POST   /api/privacy/login-mail/verify-code            → verify code
 */

const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const { encrypt } = require('../utils/crypto');
const loginMailService = require('../services/loginMailService');
const emailReaderService = require('../services/emailReaderService');
const reportService = require('../services/reportService');
const { resolveSessionIdsFromRequest } = require('../utils/resolveSessions');
const logger = require('../utils/logger');

const loginMailController = {
  // ===================================================================
  // Credential management
  // ===================================================================

  /** POST /api/privacy/login-mail/credentials/detect */
  detectImapSettings: asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      throw new AppError('Provide a valid email address', 400, 'INVALID_EMAIL');
    }
    const detected = emailReaderService.autoDetectImapSettings(email.trim());
    return res.json({
      success: true,
      data: detected
        ? { detected: true, ...detected }
        : { detected: false },
    });
  }),

  /** POST /api/privacy/login-mail/credentials */
  saveCredentials: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const {
      email,
      imapHost,
      imapPort = 993,
      imapUser,
      imapPass,
      useTls = true,
      label,
    } = req.body || {};

    if (!loginMailService.validateEmail(email)) {
      throw new AppError('Invalid email address', 400, 'INVALID_EMAIL');
    }
    if (!imapHost || typeof imapHost !== 'string') {
      throw new AppError('IMAP host is required', 400, 'MISSING_HOST');
    }
    if (!imapPass || typeof imapPass !== 'string') {
      throw new AppError('IMAP password is required', 400, 'MISSING_PASS');
    }

    const encryptedPass = encrypt(imapPass);
    const user = imapUser || email;

    // Upsert: update if same email already saved, else insert.
    const { rows } = await pool.query(
      `INSERT INTO login_mail_credentials
         (user_id, email, imap_host, imap_port, imap_user, imap_pass_encrypted, use_tls, label, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (user_id, email) DO UPDATE SET
         imap_host = EXCLUDED.imap_host,
         imap_port = EXCLUDED.imap_port,
         imap_user = EXCLUDED.imap_user,
         imap_pass_encrypted = EXCLUDED.imap_pass_encrypted,
         use_tls = EXCLUDED.use_tls,
         label = EXCLUDED.label,
         updated_at = NOW()
       RETURNING id, email, imap_host, imap_port, imap_user, use_tls, label,
                 last_tested_at, last_test_ok, created_at, updated_at`,
      [
        userId,
        email.trim().toLowerCase(),
        imapHost.trim(),
        Number(imapPort) || 993,
        user.trim(),
        encryptedPass,
        useTls !== false,
        label || null,
      ]
    );

    logger.info(`Login-mail credential saved for user ${userId}: ${email}`);
    return res.status(201).json({ success: true, data: rows[0] });
  }),

  /** GET /api/privacy/login-mail/credentials */
  listCredentials: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { rows } = await pool.query(
      `SELECT id, email, imap_host, imap_port, imap_user, use_tls, label,
              last_tested_at, last_test_ok, created_at, updated_at
         FROM login_mail_credentials
        WHERE user_id = $1
        ORDER BY updated_at DESC`,
      [userId]
    );
    return res.json({ success: true, data: { items: rows } });
  }),

  /** DELETE /api/privacy/login-mail/credentials/:id */
  deleteCredentials: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = Number(req.params.id);
    if (!id) throw new AppError('Invalid id', 400, 'BAD_ID');

    const { rowCount } = await pool.query(
      `DELETE FROM login_mail_credentials WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (rowCount === 0) {
      throw new AppError('Credential not found', 404, 'NOT_FOUND');
    }
    return res.json({ success: true });
  }),

  /** POST /api/privacy/login-mail/credentials/:id/test */
  testCredentials: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = Number(req.params.id);
    if (!id) throw new AppError('Invalid id', 400, 'BAD_ID');

    const { rows } = await pool.query(
      `SELECT id, email, imap_host, imap_port, imap_user,
              imap_pass_encrypted, use_tls
         FROM login_mail_credentials
        WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (!rows[0]) throw new AppError('Credential not found', 404, 'NOT_FOUND');

    const { decrypt: dec } = require('../utils/crypto');
    const creds = {
      email: rows[0].email,
      imap_host: rows[0].imap_host,
      imap_port: rows[0].imap_port,
      imap_user: rows[0].imap_user,
      imap_pass: dec(rows[0].imap_pass_encrypted),
      use_tls: rows[0].use_tls,
    };

    const result = await emailReaderService.testConnection(creds);

    // Record test result.
    await pool.query(
      `UPDATE login_mail_credentials
          SET last_tested_at = NOW(),
              last_test_ok = $2
        WHERE id = $1`,
      [id, result.ok]
    );

    return res.json({
      success: true,
      data: {
        ok: result.ok,
        error: result.error || null,
      },
    });
  }),

  // ===================================================================
  // Job management
  // ===================================================================

  /** POST /api/privacy/login-mail/jobs */
  createJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { credentialId, sessionIds: rawIds } = req.body || {};

    // Validate credential.
    const cid = Number(credentialId);
    if (!cid) {
      throw new AppError('credentialId is required', 400, 'MISSING_CREDENTIAL');
    }
    const { rows: credRows } = await pool.query(
      `SELECT id, email FROM login_mail_credentials
        WHERE id = $1 AND user_id = $2`,
      [cid, userId]
    );
    if (!credRows[0]) {
      throw new AppError('Credential not found', 404, 'CREDENTIAL_NOT_FOUND');
    }
    const email = credRows[0].email;

    // Resolve sessions.
    const expanded = await resolveSessionIdsFromRequest(
      req,
      Array.isArray(rawIds) ? rawIds : []
    );
    const sessionIds = Array.from(
      new Set(
        expanded
          .map((x) => Number(x))
          .filter((x) => Number.isInteger(x) && x > 0)
      )
    );
    if (sessionIds.length === 0) {
      throw new AppError(
        'Pick at least one session',
        400,
        'NO_SESSIONS'
      );
    }

    // Restrict to owned, usable sessions.
    const { rows: ownedRows } = await pool.query(
      `SELECT id FROM sessions
        WHERE user_id = $1
          AND id = ANY($2::int[])
          AND is_logged_in = true
          AND status IN ('active','uploaded')`,
      [userId, sessionIds]
    );
    const ownedIds = ownedRows.map((r) => r.id);
    if (ownedIds.length === 0) {
      throw new AppError(
        'None of the selected sessions are usable',
        400,
        'NO_OWNED_SESSIONS'
      );
    }

    // Create job + items in one transaction.
    const client = await pool.connect();
    let jobId;
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO login_mail_jobs
           (user_id, credential_id, email, status, total_sessions)
         VALUES ($1, $2, $3, 'pending', $4)
         RETURNING id, created_at`,
        [userId, cid, email, ownedIds.length]
      );
      jobId = ins.rows[0].id;

      const placeholders = ownedIds
        .map((_, i) => `($1, $${i + 2})`)
        .join(', ');
      await client.query(
        `INSERT INTO login_mail_job_items (job_id, session_id)
         VALUES ${placeholders}`,
        [jobId, ...ownedIds]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    reportService
      .logActivity(userId, 'login_mail_job_queued', 'login_mail_job', jobId, {
        email,
        sessionCount: ownedIds.length,
      })
      .catch(() => {});

    logger.info(
      `login-mail job ${jobId} queued by user ${userId} ` +
      `(${ownedIds.length} sessions, email=${email})`
    );

    return res.status(201).json({
      success: true,
      data: {
        jobId,
        email,
        sessionCount: ownedIds.length,
        skipped: sessionIds.length - ownedIds.length,
      },
    });
  }),

  /** GET /api/privacy/login-mail/jobs */
  listJobs: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const { rows } = await pool.query(
      `SELECT id, email, credential_id, status, total_sessions,
              succeeded_count, failed_count, skipped_count,
              error_message, cancel_requested,
              created_at, started_at, finished_at
         FROM login_mail_jobs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit]
    );
    return res.json({ success: true, data: { items: rows } });
  }),

  /** GET /api/privacy/login-mail/jobs/:id */
  getJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = Number(req.params.id);
    if (!jobId) throw new AppError('Invalid job id', 400, 'BAD_ID');
    const { rows } = await pool.query(
      `SELECT * FROM login_mail_jobs WHERE id = $1 AND user_id = $2`,
      [jobId, userId]
    );
    if (!rows[0]) throw new AppError('Job not found', 404, 'NOT_FOUND');
    return res.json({ success: true, data: rows[0] });
  }),

  /** GET /api/privacy/login-mail/jobs/:id/items */
  getJobItems: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = Number(req.params.id);
    if (!jobId) throw new AppError('Invalid job id', 400, 'BAD_ID');

    const owned = await pool.query(
      `SELECT 1 FROM login_mail_jobs WHERE id = $1 AND user_id = $2`,
      [jobId, userId]
    );
    if (owned.rowCount === 0) {
      throw new AppError('Job not found', 404, 'NOT_FOUND');
    }

    const { rows } = await pool.query(
      `SELECT items.id, items.session_id, items.status,
              items.error_code, items.error_message, items.attempts,
              items.started_at, items.finished_at,
              s.phone AS phone,
              (s.account_info->>'firstName') AS first_name,
              (s.account_info->>'lastName')  AS last_name,
              (s.account_info->>'username')  AS username
         FROM login_mail_job_items items
         JOIN sessions s ON s.id = items.session_id
        WHERE items.job_id = $1
        ORDER BY items.id ASC`,
      [jobId]
    );
    return res.json({ success: true, data: { items: rows } });
  }),

  /** POST /api/privacy/login-mail/jobs/:id/cancel */
  cancelJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = Number(req.params.id);
    if (!jobId) throw new AppError('Invalid job id', 400, 'BAD_ID');
    const { rowCount } = await pool.query(
      `UPDATE login_mail_jobs
          SET cancel_requested = TRUE
        WHERE id = $1 AND user_id = $2
          AND status IN ('pending','running')`,
      [jobId, userId]
    );
    if (rowCount === 0) {
      throw new AppError(
        'Job not found or already finished',
        404,
        'NOT_CANCELLABLE'
      );
    }
    return res.json({ success: true });
  }),

  // ===================================================================
  // Manual (non-automated) single-session flow
  // ===================================================================

  /** POST /api/privacy/login-mail/send-code */
  sendCode: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionId, email } = req.body || {};

    const sid = Number(sessionId);
    if (!sid || !Number.isInteger(sid) || sid <= 0) {
      throw new AppError('Invalid session id', 400, 'BAD_ID');
    }
    if (!loginMailService.validateEmail(email)) {
      throw new AppError('Invalid email address', 400, 'INVALID_EMAIL');
    }

    const { rows } = await pool.query(
      `SELECT id FROM sessions
        WHERE id = $1 AND user_id = $2 AND is_logged_in = true
          AND status IN ('active','uploaded')`,
      [sid, userId]
    );
    if (!rows[0]) {
      throw new AppError(
        'Session not found, not logged in, or not owned by you',
        404,
        'SESSION_NOT_FOUND'
      );
    }

    const result = await loginMailService.sendLoginEmailCode(sid, email);

    reportService
      .logActivity(userId, 'login_mail_code_sent', 'session', sid, { email })
      .catch(() => {});

    return res.json({
      success: true,
      data: {
        sessionId: sid,
        email: email.trim(),
        awaitingCode: true,
        codeLength: result.codeLength,
      },
    });
  }),

  /** POST /api/privacy/login-mail/verify-code */
  verifyCode: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionId, code } = req.body || {};

    const sid = Number(sessionId);
    if (!sid || !Number.isInteger(sid) || sid <= 0) {
      throw new AppError('Invalid session id', 400, 'BAD_ID');
    }
    if (!code || typeof code !== 'string' || !code.trim()) {
      throw new AppError('Verification code is required', 400, 'CODE_REQUIRED');
    }

    const { rowCount } = await pool.query(
      `SELECT 1 FROM sessions
        WHERE id = $1 AND user_id = $2 AND is_logged_in = true
          AND status IN ('active','uploaded')`,
      [sid, userId]
    );
    if (rowCount === 0) {
      throw new AppError(
        'Session not found, not logged in, or not owned by you',
        404,
        'SESSION_NOT_FOUND'
      );
    }

    await loginMailService.verifyLoginEmailCode(sid, code);

    reportService
      .logActivity(userId, 'login_mail_verified', 'session', sid, {})
      .catch(() => {});

    return res.json({
      success: true,
      data: {
        sessionId: sid,
        verified: true,
      },
    });
  }),
};

module.exports = loginMailController;
