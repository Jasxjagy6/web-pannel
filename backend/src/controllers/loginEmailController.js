/**
 * loginEmailController
 * --------------------------------------------------------------------
 * REST surface for the Login Email feature.
 *
 *   POST  /api/privacy/login-email/send-code         → manual: send OTP to email
 *   POST  /api/privacy/login-email/verify-code        → manual: verify OTP code
 *   GET   /api/privacy/login-email/status/:sessionId  → check if session has login email
 *   POST  /api/privacy/login-email/test-imap          → test IMAP connection
 *   POST  /api/privacy/login-email/bulk/start         → start automated bulk job
 *   GET   /api/privacy/login-email/bulk/:jobId/status → poll job progress
 *   POST  /api/privacy/login-email/bulk/:jobId/cancel → cancel running job
 *   GET   /api/privacy/login-email/providers          → list well-known IMAP providers
 */

const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const loginEmailService = require('../services/loginEmailService');
const emailReaderService = require('../services/emailReaderService');
const loginEmailJobService = require('../services/loginEmailJobService');
const reportService = require('../services/reportService');
const { resolveSessionIdsFromRequest } = require('../utils/resolveSessions');
const logger = require('../utils/logger');

const loginEmailController = {
  /**
   * GET /providers
   * Returns the list of well-known IMAP providers with their
   * host/port presets so the frontend can render a dropdown.
   */
  providers: asyncHandler(async (_req, res) => {
    return res.json({
      success: true,
      data: { providers: emailReaderService.WELL_KNOWN_PROVIDERS },
    });
  }),

  /**
   * POST /send-code
   * Body: { sessionId, email }
   *
   * Triggers Telegram to send a verification code to the email
   * address for setting it as the login email on the session.
   */
  sendCode: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionId, email } = req.body || {};

    const sid = Number(sessionId);
    if (!sid || !Number.isInteger(sid) || sid <= 0) {
      throw new AppError('Invalid session id', 400, 'BAD_ID');
    }
    if (!loginEmailService.validateEmail(email)) {
      throw new AppError('Invalid email address', 400, 'INVALID_EMAIL');
    }

    // Verify ownership + session is usable
    const { rows } = await pool.query(
      `SELECT id FROM sessions
       WHERE id = $1 AND user_id = $2 AND is_logged_in = true
         AND status IN ('active','uploaded') AND platform = 'telegram'`,
      [sid, userId]
    );
    if (!rows[0]) {
      throw new AppError(
        'Session not found, not logged in, or not owned by you',
        404,
        'SESSION_NOT_FOUND'
      );
    }

    const result = await loginEmailService.sendCode(sid, email);

    reportService
      .logActivity(userId, 'login_email_code_sent', 'session', sid, { email })
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

  /**
   * POST /verify-code
   * Body: { sessionId, email, code }
   *
   * Verifies the code the user received via email, completing the
   * login-email setup for this session.
   */
  verifyCode: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionId, email, code } = req.body || {};

    const sid = Number(sessionId);
    if (!sid || !Number.isInteger(sid) || sid <= 0) {
      throw new AppError('Invalid session id', 400, 'BAD_ID');
    }
    if (!loginEmailService.validateEmail(email)) {
      throw new AppError('Invalid email address', 400, 'INVALID_EMAIL');
    }
    if (!code || typeof code !== 'string' || !code.trim()) {
      throw new AppError('Verification code is required', 400, 'CODE_REQUIRED');
    }

    const { rowCount } = await pool.query(
      `SELECT 1 FROM sessions
       WHERE id = $1 AND user_id = $2 AND is_logged_in = true
         AND status IN ('active','uploaded') AND platform = 'telegram'`,
      [sid, userId]
    );
    if (rowCount === 0) {
      throw new AppError(
        'Session not found, not logged in, or not owned by you',
        404,
        'SESSION_NOT_FOUND'
      );
    }

    await loginEmailService.verifyCode(sid, email, code);

    reportService
      .logActivity(userId, 'login_email_verified', 'session', sid, { email })
      .catch(() => {});

    return res.json({
      success: true,
      data: {
        sessionId: sid,
        email: email.trim(),
        verified: true,
      },
    });
  }),

  /**
   * GET /status/:sessionId
   * Returns whether the session has a login email configured.
   */
  getStatus: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sid = Number(req.params.sessionId);
    if (!sid) throw new AppError('Invalid session id', 400, 'BAD_ID');

    const { rowCount } = await pool.query(
      `SELECT 1 FROM sessions
       WHERE id = $1 AND user_id = $2 AND platform = 'telegram'`,
      [sid, userId]
    );
    if (rowCount === 0) {
      throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    const status = await loginEmailService.getLoginEmailStatus(sid);
    return res.json({ success: true, data: status });
  }),

  /**
   * POST /test-imap
   * Body: { email, password, provider?, host?, port?, secure? }
   *
   * Tests the IMAP connection to verify the credentials work.
   */
  testImap: asyncHandler(async (req, res) => {
    const imapConfig = req.body || {};
    if (!imapConfig.email || !imapConfig.password) {
      throw new AppError('Email and password are required', 400, 'MISSING_CREDENTIALS');
    }

    const result = await emailReaderService.testConnection(imapConfig);
    return res.json({ success: true, data: result });
  }),

  /**
   * POST /bulk/start
   * Body: {
   *   email,          // login email to set on all sessions
   *   sessionIds,     // array of session IDs
   *   imapConfig: { email, password, provider?, host?, port?, secure? },
   *   interSessionDelayMs?
   * }
   */
  bulkStart: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const body = req.body || {};
    const { email, imapConfig, interSessionDelayMs } = body;

    if (!email || !loginEmailService.validateEmail(email)) {
      throw new AppError('Valid login email address is required', 400, 'INVALID_EMAIL');
    }
    if (!imapConfig || !imapConfig.email || !imapConfig.password) {
      throw new AppError(
        'IMAP credentials (email + password) are required for automated mode',
        400,
        'MISSING_IMAP_CREDENTIALS'
      );
    }

    const rawIds = Array.isArray(body.sessionIds) ? body.sessionIds : [];
    const expanded = await resolveSessionIdsFromRequest(req, rawIds);
    const sessionIds = Array.from(
      new Set(expanded.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))
    );
    if (sessionIds.length === 0) {
      throw new AppError('Pick at least one session', 400, 'NO_SESSIONS');
    }

    // Restrict to owned, usable, Telegram sessions
    const { rows } = await pool.query(
      `SELECT id FROM sessions
       WHERE user_id = $1 AND id = ANY($2::int[])
         AND is_logged_in = true AND status IN ('active','uploaded')
         AND platform = 'telegram'`,
      [userId, sessionIds]
    );
    const ownedIds = rows.map((r) => r.id);
    if (ownedIds.length === 0) {
      throw new AppError(
        'None of the selected sessions are usable',
        400,
        'NO_OWNED_SESSIONS'
      );
    }

    const { jobId } = await loginEmailJobService.startAutomatedJob({
      userId,
      email: email.trim(),
      sessionIds: ownedIds,
      imapConfig,
      interSessionDelayMs,
    });

    reportService
      .logActivity(userId, 'login_email_bulk_started', 'login_email_job', null, {
        email,
        sessionCount: ownedIds.length,
        jobId,
      })
      .catch(() => {});

    logger.info(
      `Login email bulk job ${jobId} started by user ${userId} (${ownedIds.length} sessions)`
    );

    return res.status(202).json({
      success: true,
      data: {
        jobId,
        sessionCount: ownedIds.length,
        skipped: sessionIds.length - ownedIds.length,
      },
    });
  }),

  /**
   * GET /bulk/:jobId/status
   */
  bulkStatus: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const view = loginEmailJobService.getJobStatus(req.params.jobId, userId);
    if (!view) {
      throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    }
    return res.json({ success: true, data: view });
  }),

  /**
   * POST /bulk/:jobId/cancel
   */
  bulkCancel: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const ok = loginEmailJobService.cancelJob(req.params.jobId, userId);
    if (!ok) {
      throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    }
    return res.json({ success: true });
  }),
};

module.exports = loginEmailController;
