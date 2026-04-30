const path = require('path');
const fs = require('fs-extra');
const { pool } = require('../config/database');
const { uploadDir } = require('../middleware/upload');
const sessionService = require('../services/sessionService');
const sessionCreationService = require('../services/sessionCreationService');
const telegramService = require('../services/telegramService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const sessionController = {
  /**
   * Upload session files (bulk).
   *
   * Expects multipart/form-data with files under the "sessions" field name.
   * Optional query params: apiId, apiHash, autoLogin
   * Multer middleware populates req.files before this handler runs.
   */
  uploadSessions: asyncHandler(async (req, res) => {
    if (!req.files || req.files.length === 0) {
      throw new AppError('No session files provided', 400, 'NO_FILES');
    }

    const userId = req.user.id;
    const options = {
      apiId: req.query.apiId ? parseInt(req.query.apiId, 10) : undefined,
      apiHash: req.query.apiHash || undefined,
      autoLogin: req.query.autoLogin === 'true' || req.query.autoLogin === '1',
    };

    const result = await sessionService.uploadSessions(req.files, userId, options);

    // Log the upload activity
    await reportService.logActivity(
      userId,
      'session_upload',
      'session',
      result.results[0]?.sessionId || null,
      {
        totalFiles: result.total,
        successful: result.successful,
        failed: result.failed,
        durationMs: result.duration,
        autoLogin: options.autoLogin,
      }
    );

    logger.info(`Session files uploaded by user ${userId}`, {
      total: result.total,
      successful: result.successful,
      failed: result.failed,
    });

    return res.status(200).json({
      success: true,
      data: {
        total: result.total,
        successful: result.successful,
        failed: result.failed,
        results: result.results,
        duration: result.duration,
      },
    });
  }),

  /**
   * List sessions for the authenticated user with pagination and filtering.
   *
   * Query params: page, limit, sort, order, filter
   */
  listSessions: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const sort = req.query.sort || 'created_at';
    const order = req.query.order || 'DESC';
    const filter = req.query.filter || undefined;

    const { sessions, pagination } = await sessionService.listSessions(userId, {
      page,
      limit,
      sort,
      order,
      filter,
    });

    return res.status(200).json({
      success: true,
      data: {
        sessions,
        pagination,
      },
    });
  }),

  /**
   * Get detailed information for a single session.
   *
   * Session ID comes from req.params.id.
   */
  getSession: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;

    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }

    const session = await sessionService.getSessionById(sessionId, userId);

    return res.status(200).json({
      success: true,
      data: {
        session,
      },
    });
  }),

  /**
   * Login (activate) a session by connecting it to Telegram.
   *
   * Session ID comes from req.params.id.
   */
  loginSession: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;

    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }

    const result = await sessionService.loginSession(sessionId, userId);

    // Log the login activity
    await reportService.logActivity(
      userId,
      'session_login',
      'session',
      sessionId,
      {
        status: result.status,
        phone: result.accountInfo ? result.accountInfo.phone : null,
      }
    );

    logger.info(`Session logged in by user ${userId}`, {
      sessionId,
      status: result.status,
    });

    return res.status(200).json({
      success: true,
      data: {
        sessionId: result.sessionId,
        accountInfo: result.accountInfo,
        status: result.status,
      },
    });
  }),

  /**
   * Logout (deactivate) a session by disconnecting it from Telegram.
   *
   * Session ID comes from req.params.id.
   */
  logoutSession: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;

    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }

    const result = await sessionService.logoutSession(sessionId, userId);

    // Log the logout activity
    await reportService.logActivity(
      userId,
      'session_logout',
      'session',
      sessionId,
      {}
    );

    logger.info(`Session logged out by user ${userId}`, { sessionId });

    return res.status(200).json({
      success: true,
      data: {
        sessionId: result.sessionId,
      },
    });
  }),

  /**
   * Delete a single session.
   *
   * Session ID comes from req.params.id.
   */
  deleteSession: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;

    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }

    const result = await sessionService.deleteSession(sessionId, userId);

    // Log the delete activity
    await reportService.logActivity(
      userId,
      'session_delete',
      'session',
      sessionId,
      {
        fileDeleted: result.fileDeleted,
      }
    );

    logger.info(`Session deleted by user ${userId}`, {
      sessionId,
      fileDeleted: result.fileDeleted,
    });

    return res.status(200).json({
      success: true,
      data: {
        sessionId: result.sessionId,
        fileDeleted: result.fileDeleted,
      },
    });
  }),

  /**
   * Bulk delete multiple sessions at once.
   *
   * Expects req.body: { sessionIds: [number, ...] }
   */
  bulkDeleteSessions: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionIds } = req.body;

    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('sessionIds array is required and must not be empty', 400, 'MISSING_SESSION_IDS');
    }

    const result = await sessionService.bulkDeleteSessions(sessionIds, userId);

    // Log each deletion
    for (const item of result.results) {
      if (item.success) {
        await reportService.logActivity(
          userId,
          'session_delete',
          'session',
          item.sessionId,
          { bulkDelete: true }
        );
      }
    }

    logger.info(`Bulk session deletion by user ${userId}`, {
      total: result.total,
      successful: result.successful,
      failed: result.failed,
    });

    return res.status(200).json({
      success: true,
      data: {
        total: result.total,
        successful: result.successful,
        failed: result.failed,
        results: result.results,
      },
    });
  }),

  /**
   * Check the live status of a session (connected, disconnected, error).
   *
   * Session ID comes from req.params.id.
   */
  checkSessionStatus: asyncHandler(async (req, res) => {
    const sessionId = req.params.id;

    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }

    const status = await sessionService.getSessionStatus(sessionId);

    return res.status(200).json({
      success: true,
      data: {
        id: status.id,
        status: status.status,
        isLoggedIn: status.isLoggedIn,
        is2faEnabled: status.is2faEnabled,
        accountInfo: status.accountInfo,
        liveStatus: status.liveStatus,
        lastActive: status.lastActive,
        createdAt: status.createdAt,
        filePath: status.filePath,
        note: status.note || null,
      },
    });
  }),

  /**
   * Get aggregated session statistics for the authenticated user.
   */
  getSessionStats: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const stats = await sessionService.getSessionStats(userId);

    return res.status(200).json({
      success: true,
      data: stats,
    });
  }),

  // =========================================================================
  // Upgrade 5 — Create Session via panel (interactive sendCode → signIn flow)
  // =========================================================================

  createSessionStart: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { phone, apiId, apiHash } = req.body || {};
    const result = await sessionCreationService.start({
      userId,
      phone,
      apiId,
      apiHash,
    });
    return res.status(200).json({ success: true, data: result });
  }),

  createSessionVerify: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { tempId, code } = req.body || {};
    const result = await sessionCreationService.verify({ userId, tempId, code });
    return res.status(200).json({ success: true, data: result });
  }),

  createSessionPassword: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { tempId, password } = req.body || {};
    const result = await sessionCreationService.password({
      userId,
      tempId,
      password,
    });
    return res.status(200).json({ success: true, data: result });
  }),

  createSessionResend: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { tempId } = req.body || {};
    const result = await sessionCreationService.resend({ userId, tempId });
    return res.status(200).json({ success: true, data: result });
  }),

  createSessionCancel: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { tempId } = req.body || {};
    const result = await sessionCreationService.cancel({ userId, tempId });
    return res.status(200).json({ success: true, data: result });
  }),

  /**
   * Download the on-disk session file for a session the user owns.
   * The downloaded JSON contains the encrypted GramJS string session — i.e.
   * the same format the panel accepts via /upload, so it round-trips.
   */
  downloadSession: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;
    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }

    const r = await pool.query(
      `SELECT id, phone, session_file_path, account_info
         FROM sessions
        WHERE id = $1 AND user_id = $2`,
      [sessionId, userId]
    );
    const row = r.rows[0];
    if (!row) {
      throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
    }
    if (!row.session_file_path) {
      throw new AppError('Session has no file on disk', 404, 'SESSION_FILE_MISSING');
    }
    const fullPath = path.join(uploadDir, row.session_file_path);
    if (!(await fs.pathExists(fullPath))) {
      throw new AppError('Session file is missing on disk', 404, 'SESSION_FILE_MISSING');
    }

    const ext = path.extname(row.session_file_path) || '.json';
    const safePhone = (row.phone || `session-${row.id}`).replace(/[^A-Za-z0-9+_-]/g, '');
    const downloadName = `${safePhone}${ext}`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${downloadName}"`
    );
    return res.sendFile(fullPath);
  }),
};

module.exports = sessionController;
