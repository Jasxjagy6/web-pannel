const path = require('path');
const fs = require('fs-extra');
const { pool } = require('../config/database');
const { uploadDir } = require('../middleware/upload');
const sessionService = require('../services/sessionService');
const sessionCreationService = require('../services/sessionCreationService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const { decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

const ENCRYPTED_SESSION_RE = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;

// ---------------------------------------------------------------------------
// Multi-platform dispatch helpers.
//
// Telegram and Instagram both expose `req.provider.sessions.<verb>` and
// `req.provider.create.<verb>`, but the legacy Telegram code path still
// calls the service singletons directly (no behaviour changes for TG users).
// Instagram dispatches into the IG provider, which writes/reads only
// `platform = 'instagram'` rows so the two panels are hard-isolated.
// ---------------------------------------------------------------------------
function _isInstagram(req) {
  return req && req.platform === 'instagram';
}

const sessionController = {
  /**
   * Upload session files (bulk).
   *
   * Expects multipart/form-data with files under the "sessions" field name.
   * Optional query params: apiId, apiHash, autoLogin
   * Multer middleware populates req.files before this handler runs.
   *
   * On `/api/instagram/sessions/upload`, the IG provider expects a JSON
   * file with one or more `{ username, sessionBlob, proxyUrl? }` records.
   */
  uploadSessions: asyncHandler(async (req, res) => {
    if (!req.files || req.files.length === 0) {
      throw new AppError('No session files provided', 400, 'NO_FILES');
    }

    const userId = req.user.id;

    if (_isInstagram(req)) {
      const provider = req.provider;
      const result = await provider.sessions.upload(req.files, userId, {});
      logger.info(`IG session upload by user ${userId}`, {
        total: result.total, successful: result.successful, failed: result.failed,
      });
      await reportService.logActivity(
        userId,
        'session_upload',
        'session',
        result.results[0]?.sessionId || null,
        { platform: 'instagram', total: result.total, successful: result.successful, failed: result.failed }
      );
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
    }

    // Telegram path (unchanged behaviour)
    const options = {
      apiId: req.query.apiId ? parseInt(req.query.apiId, 10) : undefined,
      apiHash: req.query.apiHash || undefined,
      autoLogin: req.query.autoLogin === 'true' || req.query.autoLogin === '1',
    };
    const result = await sessionService.uploadSessions(req.files, userId, options);
    await reportService.logActivity(
      userId,
      'session_upload',
      'session',
      result.results[0]?.sessionId || null,
      {
        platform: 'telegram',
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
   *
   * Hard-scoped to req.platform — `/api/instagram/sessions` returns only
   * IG rows, `/api/telegram/sessions` returns only TG rows.
   */
  listSessions: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const sort = req.query.sort || 'created_at';
    const order = req.query.order || 'DESC';
    const filter = req.query.filter || undefined;

    if (_isInstagram(req)) {
      const provider = req.provider;
      const igFilter = {};
      if (filter && filter !== 'all') igFilter.status = filter;
      if (req.query.search) igFilter.search = req.query.search;
      const out = await provider.sessions.listSessions(userId, {
        page, limit, sort, order, filter: igFilter,
      });
      return res.status(200).json({
        success: true,
        data: {
          sessions: out.sessions,
          pagination: {
            page: out.page,
            limit: out.limit,
            total: out.total,
            totalPages: Math.max(1, Math.ceil(out.total / Math.max(1, out.limit))),
          },
        },
      });
    }

    // Telegram path (unchanged) — also adds an explicit platform filter
    // as defense-in-depth so a stray /api/sessions request without an
    // X-Platform header can't bleed IG rows into the TG response.
    const { sessions, pagination } = await sessionService.listSessions(userId, {
      page,
      limit,
      sort,
      order,
      filter,
      platform: 'telegram',
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
   */
  getSession: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;

    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }

    if (_isInstagram(req)) {
      const provider = req.provider;
      const session = await provider.sessions.get(sessionId, userId);
      if (!session) throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
      return res.status(200).json({ success: true, data: { session } });
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
   * Login (activate) a session.
   *
   * On Telegram this connects the stored session string to a GramJS client.
   * On Instagram this re-attaches the stored cookies to instagram-private-api,
   * pings the user endpoint to confirm the cookies are still valid, and
   * marks `is_logged_in = TRUE`. If the cookies have expired the operator
   * is told to re-create the session from scratch (IG can't refresh tokens).
   */
  loginSession: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;

    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }

    if (_isInstagram(req)) {
      const provider = req.provider;
      const result = await provider.sessions.login(sessionId, userId);
      await reportService.logActivity(
        userId,
        'session_login',
        'session',
        sessionId,
        { platform: 'instagram', status: result.status }
      );
      return res.status(200).json({ success: true, data: result });
    }

    const result = await sessionService.loginSession(sessionId, userId);
    await reportService.logActivity(
      userId,
      'session_login',
      'session',
      sessionId,
      {
        platform: 'telegram',
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
   * Anti-revoke Phase 4 — recover a session that was marked
   * status='revoked'. Re-loads the encrypted session file (live first,
   * then falls back through the most recent session_backups rows), runs
   * getMe, and if Telegram still accepts the auth key, flips the row
   * back to status='active' / is_logged_in=TRUE so the heartbeat
   * resumes without forcing the operator to receive a new SMS.
   *
   * Returns 200 + recovery details on success; 200 + recovered=false +
   * reason on failure (so the UI can show a meaningful message).
   * Returns 503 if Phase 4 is disabled and 404 if the session doesn't
   * exist or doesn't belong to this user.
   */
  recoverSession: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;
    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }
    if (_isInstagram(req)) {
      throw new AppError(
        'Recovery is currently Telegram-only',
        400,
        'RECOVERY_NOT_SUPPORTED'
      );
    }
    const result = await sessionService.recoverSession(sessionId, userId);
    await reportService.logActivity(
      userId,
      'session_recover',
      'session',
      sessionId,
      {
        platform: 'telegram',
        recovered: !!result.recovered,
        reason: result.reason || null,
      }
    );
    logger.info(`Session recovery by user ${userId}`, {
      sessionId,
      recovered: !!result.recovered,
      reason: result.reason || null,
    });
    return res.status(200).json({
      success: true,
      data: {
        sessionId,
        recovered: !!result.recovered,
        status: result.status || null,
        accountInfo: result.accountInfo || null,
        reason: result.reason || null,
      },
    });
  }),

  /**
   * Logout (deactivate) a session.
   */
  logoutSession: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;

    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }

    if (_isInstagram(req)) {
      const provider = req.provider;
      const result = await provider.sessions.logoutSession(sessionId, userId);
      await reportService.logActivity(userId, 'session_logout', 'session', sessionId, { platform: 'instagram' });
      return res.status(200).json({ success: true, data: result });
    }

    const result = await sessionService.logoutSession(sessionId, userId);

    await reportService.logActivity(
      userId,
      'session_logout',
      'session',
      sessionId,
      { platform: 'telegram' }
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
   */
  deleteSession: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;

    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }

    if (_isInstagram(req)) {
      const provider = req.provider;
      const result = await provider.sessions.deleteSession(sessionId, userId);
      await reportService.logActivity(userId, 'session_delete', 'session', sessionId, { platform: 'instagram' });
      return res.status(200).json({ success: true, data: { sessionId: result.id, deleted: result.deleted } });
    }

    const result = await sessionService.deleteSession(sessionId, userId);

    await reportService.logActivity(
      userId,
      'session_delete',
      'session',
      sessionId,
      {
        platform: 'telegram',
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
   */
  bulkDeleteSessions: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionIds } = req.body;

    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('sessionIds array is required and must not be empty', 400, 'MISSING_SESSION_IDS');
    }

    if (_isInstagram(req)) {
      const provider = req.provider;
      const result = await provider.sessions.bulkDelete(sessionIds, userId);
      for (const item of result.results) {
        if (item.success) {
          await reportService.logActivity(
            userId, 'session_delete', 'session', item.sessionId, { platform: 'instagram', bulkDelete: true }
          );
        }
      }
      return res.status(200).json({ success: true, data: result });
    }

    const result = await sessionService.bulkDeleteSessions(sessionIds, userId);

    for (const item of result.results) {
      if (item.success) {
        await reportService.logActivity(
          userId,
          'session_delete',
          'session',
          item.sessionId,
          { platform: 'telegram', bulkDelete: true }
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
   */
  checkSessionStatus: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;

    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }

    if (_isInstagram(req)) {
      const provider = req.provider;
      const status = await provider.sessions.status(sessionId, userId);
      return res.status(200).json({ success: true, data: status });
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
   * Get aggregated session statistics for the authenticated user, scoped
   * to the active panel platform.
   */
  getSessionStats: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    if (_isInstagram(req)) {
      const provider = req.provider;
      const stats = await provider.sessions.getSessionStats(userId);
      return res.status(200).json({ success: true, data: stats });
    }

    const stats = await sessionService.getSessionStats(userId);

    return res.status(200).json({
      success: true,
      data: stats,
    });
  }),

  // =========================================================================
  // Create-Session flow
  //
  // Telegram: phone -> code -> (optional 2FA cloud password) -> session.
  // Instagram: username + password -> (optional 2FA TOTP/SMS) ->
  //            (optional checkpoint) -> session.
  //
  // The frontend hits the same endpoints on both platforms; the controller
  // dispatches via req.provider.create.<verb>. Both providers consume the
  // same request shape but the body fields differ:
  //
  //   TG /create/start  body: { phone, apiId, apiHash }
  //   IG /create/start  body: { username, password, proxyUrl? }
  //
  //   TG /create/verify body: { tempId, code }
  //   IG /create/verify body: { sessionToken, code }   (challenge step)
  //
  //   TG /create/password body: { tempId, password }
  //   IG /create/password body: { sessionToken, code } (2FA TOTP step)
  // =========================================================================

  createSessionStart: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    if (_isInstagram(req)) {
      const { username, password, proxyUrl, proxyId } = req.body || {};
      if (!username || !password) {
        throw new AppError('username and password are required', 400, 'MISSING_FIELDS');
      }
      // BYO Proxy (Phase 2): if the user picked a saved proxy, look it
      // up + materialise the proxy_url IG expects. We don't trust the
      // raw `proxyUrl` body field for BYO clients — it would let a user
      // hand-roll an admin-pool URL and bypass the entitlement gate.
      let resolvedProxyUrl = proxyUrl;
      if (proxyId) {
        const proxyService = require('../services/proxyService');
        const owned = await proxyService.getMyProxy(userId, Number(proxyId));
        if (!owned) {
          throw new AppError('Proxy not found', 404, 'PROXY_NOT_FOUND');
        }
        resolvedProxyUrl = (proxyService.buildProxyUrl
          ? proxyService.buildProxyUrl(owned)
          : null) || resolvedProxyUrl;
      }
      const provider = req.provider;
      const result = await provider.create.start({
        userId,
        username,
        password,
        proxyUrl: resolvedProxyUrl,
        proxyId: proxyId ? Number(proxyId) : undefined,
      });
      return res.status(200).json({ success: true, data: result });
    }

    const { phone, apiId, apiHash, country, platform, proxyId } = req.body || {};
    const result = await sessionCreationService.start({
      userId,
      phone,
      apiId,
      apiHash,
      country,
      platform,
      proxyId: proxyId ? Number(proxyId) : undefined,
      userRole: req.user && req.user.role,
    });
    return res.status(200).json({ success: true, data: result });
  }),

  createSessionVerify: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    if (_isInstagram(req)) {
      const { sessionToken, code } = req.body || {};
      if (!sessionToken || !code) {
        throw new AppError('sessionToken and code are required', 400, 'MISSING_FIELDS');
      }
      const provider = req.provider;
      const result = await provider.create.verify({ sessionToken, code });
      return res.status(200).json({ success: true, data: result });
    }

    const { tempId, code } = req.body || {};
    const result = await sessionCreationService.verify({ userId, tempId, code });
    return res.status(200).json({ success: true, data: result });
  }),

  createSessionPassword: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    if (_isInstagram(req)) {
      const { sessionToken, code } = req.body || {};
      if (!sessionToken || !code) {
        throw new AppError('sessionToken and code are required', 400, 'MISSING_FIELDS');
      }
      const provider = req.provider;
      const result = await provider.create.password({ sessionToken, code });
      return res.status(200).json({ success: true, data: result });
    }

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

    if (_isInstagram(req)) {
      const { sessionToken, method } = req.body || {};
      const provider = req.provider;
      const result = await provider.create.resend({ sessionToken, method });
      return res.status(200).json({ success: true, data: result });
    }

    const { tempId } = req.body || {};
    const result = await sessionCreationService.resend({ userId, tempId });
    return res.status(200).json({ success: true, data: result });
  }),

  createSessionCancel: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    if (_isInstagram(req)) {
      const { sessionToken } = req.body || {};
      const provider = req.provider;
      const result = await provider.create.cancel({ sessionToken });
      return res.status(200).json({ success: true, data: result });
    }

    const { tempId } = req.body || {};
    const result = await sessionCreationService.cancel({ userId, tempId });
    return res.status(200).json({ success: true, data: result });
  }),

  /**
   * Download the session file. For Telegram this returns the on-disk
   * GramJS string (decrypted). For Instagram it returns the encrypted
   * JSON cookie/device blob from `sessions.session_data`.
   */
  downloadSession: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;
    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }

    if (_isInstagram(req)) {
      const provider = req.provider;
      const out = await provider.sessions.download(sessionId, userId);
      const downloadName = `${(out.username || 'instagram-session').replace(/[^A-Za-z0-9_+-]/g, '')}.json`;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      return res.send(JSON.stringify({
        platform: 'instagram',
        username: out.username,
        sessionBlob: out.blob,
        exportedAt: new Date().toISOString(),
      }, null, 2));
    }

    const r = await pool.query(
      `SELECT id, phone, session_file_path, account_info
         FROM sessions
        WHERE id = $1 AND user_id = $2 AND platform = 'telegram'`,
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

    if (ext.toLowerCase() === '.json') {
      try {
        const raw = await fs.readFile(fullPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.session === 'string') {
          let plain = parsed.session;
          if (ENCRYPTED_SESSION_RE.test(plain)) {
            try {
              plain = decrypt(plain);
            } catch (err) {
              logger.warn(
                `downloadSession: decrypt failed for session ${row.id}: ${err.message}`
              );
            }
          }
          const body = {
            session: plain,
            createdAt:
              parsed.createdAt || parsed.uploadedAt || new Date().toISOString(),
            originalName: parsed.originalName || downloadName,
          };
          if (parsed.convertedFrom) body.convertedFrom = parsed.convertedFrom;
          if (parsed.createdVia) body.createdVia = parsed.createdVia;

          res.setHeader('Content-Type', 'application/json');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="${downloadName}"`
          );
          return res.send(JSON.stringify(body, null, 2));
        }
      } catch (err) {
        logger.warn(
          `downloadSession: failed to plaintext-serialize session ${row.id}: ${err.message}`
        );
      }
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${downloadName}"`
    );
    return res.sendFile(fullPath);
  }),

  /**
   * GET /api/instagram/sessions/:id/health
   * Returns the most recent warm-up state, last error, last successful
   * probe time and the last 10 behavior_log rows for an IG session.
   * Returns 404 for non-IG sessions.
   */
  getSessionHealth: asyncHandler(async (req, res) => {
    if (!_isInstagram(req)) {
      throw new AppError(
        'Session health is only tracked for Instagram sessions',
        404,
        'NOT_INSTAGRAM_SESSION'
      );
    }
    const userId = req.user.id;
    const sessionId = parseInt(req.params.id, 10);
    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }
    // eslint-disable-next-line global-require
    const sessionHealth = require('../providers/instagram/sessionHealth');
    const row = await sessionHealth.getSessionHealth(sessionId, userId);
    if (!row) {
      throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
    }
    res.json({ success: true, data: row });
  }),

  /**
   * POST /api/instagram/sessions/:id/health/check
   * Runs an on-demand health probe for an IG session through its
   * bound proxy. Returns the new state.
   */
  runSessionHealthCheck: asyncHandler(async (req, res) => {
    if (!_isInstagram(req)) {
      throw new AppError(
        'Session health is only tracked for Instagram sessions',
        404,
        'NOT_INSTAGRAM_SESSION'
      );
    }
    const userId = req.user.id;
    const sessionId = parseInt(req.params.id, 10);
    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }
    // Confirm the user owns this session before the probe (the
    // sessionHealth module is platform-scoped but doesn't take userId
    // on runHealthCheck so we authorize here).
    const owns = await pool.query(
      `SELECT 1 FROM sessions
        WHERE id = $1 AND user_id = $2 AND platform = 'instagram'`,
      [sessionId, userId]
    );
    if (owns.rowCount === 0) {
      throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
    }
    // eslint-disable-next-line global-require
    const sessionHealth = require('../providers/instagram/sessionHealth');
    const result = await sessionHealth.runHealthCheck(sessionId, { verbose: true });
    const fresh = await sessionHealth.getSessionHealth(sessionId, userId);
    res.json({
      success: result.ok,
      data: { result, session: fresh },
    });
  }),

  /**
   * PATCH /api/instagram/sessions/:id/proxy
   * Sets (or clears) the per-session proxy URL. Trims whitespace, treats
   * an empty string as "remove proxy". Validates URL shape so the worker
   * doesn't trip on bad input.
   */
  setSessionProxy: asyncHandler(async (req, res) => {
    if (!_isInstagram(req)) {
      throw new AppError(
        'Per-session proxy is only configurable for Instagram sessions',
        404,
        'NOT_INSTAGRAM_SESSION'
      );
    }
    const userId = req.user.id;
    const sessionId = parseInt(req.params.id, 10);
    if (!sessionId) {
      throw new AppError('Session ID is required', 400, 'MISSING_SESSION_ID');
    }
    let { proxyUrl } = req.body || {};
    if (typeof proxyUrl === 'string') proxyUrl = proxyUrl.trim();
    if (proxyUrl) {
      // Accept http(s)://, socks5://, socks4:// — the undici dispatcher
      // we use for HTTP proxies only handles http(s) directly, but we
      // allow socks here so a future provider switch is a one-line
      // change. Reject anything else early.
      if (!/^(https?|socks[45]?):\/\//i.test(proxyUrl)) {
        throw new AppError(
          'proxyUrl must start with http://, https://, socks5:// or socks4://',
          400,
          'INVALID_PROXY_URL'
        );
      }
    } else {
      proxyUrl = null;
    }
    const owns = await pool.query(
      `UPDATE sessions
          SET proxy_url = $3, updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND platform = 'instagram'
        RETURNING id, proxy_url`,
      [sessionId, userId, proxyUrl]
    );
    if (owns.rowCount === 0) {
      throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
    }
    // Drop the cached dispatcher so the next request rebuilds it
    // against the new proxy URL.
    // eslint-disable-next-line global-require
    const igFetch = require('../providers/instagram/igFetch');
    igFetch.invalidateProxy(owns.rows[0].proxy_url || null);
    res.json({ success: true, data: owns.rows[0] });
  }),
};

module.exports = sessionController;
