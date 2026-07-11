/**
 * AiChatController — REST surface for the AI auto-responder.
 *
 * All endpoints are scoped to Telegram sessions and verify that the
 * caller owns the session before reading or writing AI settings/memory.
 */

const aiChatService = require('../services/aiChatService');
const cupidbotService = require('../services/cupidbotService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

function _toNumber(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new AppError(`Invalid ${field}`, 400, 'BAD_ID');
  }
  return n;
}

const aiChatController = {
  /**
   * GET /api/telegram/ai-chat/sessions/:id/ai-settings
   */
  getSessionSettings: asyncHandler(async (req, res) => {
    const sessionId = _toNumber(req.params.id, 'session id');
    const settings = await aiChatService.getSessionSettings(sessionId);
    res.json({ success: true, data: settings });
  }),

  /**
   * PATCH /api/telegram/ai-chat/sessions/:id/ai-settings
   *
   * Body: { enabled: boolean, config?: object }
   */
  updateSessionSettings: asyncHandler(async (req, res) => {
    const sessionId = _toNumber(req.params.id, 'session id');
    const userId = req.user.id;
    const { enabled, config } = req.body || {};
    if (typeof enabled !== 'boolean') {
      throw new AppError('enabled boolean is required', 400, 'MISSING_ENABLED');
    }
    const result = await aiChatService.setSessionEnabled(
      sessionId,
      userId,
      enabled,
      config || {}
    );
    logger.info(`AI session setting updated`, { sessionId, userId, enabled });
    res.json({ success: true, data: result });
  }),

  /**
   * GET /api/telegram/ai-chat/sessions/:id/ai-chats
   *
   * Query: ?limit=&offset=
   */
  listChatSettings: asyncHandler(async (req, res) => {
    const sessionId = _toNumber(req.params.id, 'session id');
    const userId = req.user.id;
    const rows = await aiChatService.listChatSettings(sessionId, userId, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, data: { rows, total: rows.length } });
  }),

  /**
   * PATCH /api/telegram/ai-chat/sessions/:id/ai-chats/:peerType/:peerId
   *
   * Body: { enabled: boolean, config?: object }
   */
  updateChatSettings: asyncHandler(async (req, res) => {
    const sessionId = _toNumber(req.params.id, 'session id');
    const userId = req.user.id;
    const peerType = String(req.params.peerType || '').toLowerCase();
    if (!['user', 'chat', 'channel'].includes(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    const peerId = _toNumber(req.params.peerId, 'peer id');
    const { enabled, config } = req.body || {};
    if (typeof enabled !== 'boolean') {
      throw new AppError('enabled boolean is required', 400, 'MISSING_ENABLED');
    }
    const result = await aiChatService.setChatEnabled(
      sessionId,
      userId,
      peerType,
      peerId,
      enabled,
      config || {}
    );
    logger.info(`AI chat setting updated`, { sessionId, peerType, peerId, enabled });
    res.json({ success: true, data: result });
  }),

  /**
   * POST /api/telegram/ai-chat/sessions/:id/ai-chats/:peerType/:peerId/seed
   *
   * Backfill AI memory from the recent Telegram message history for this peer.
   */
  seedChatMemory: asyncHandler(async (req, res) => {
    const sessionId = _toNumber(req.params.id, 'session id');
    const userId = req.user.id;
    const peerType = String(req.params.peerType || '').toLowerCase();
    if (!['user', 'chat', 'channel'].includes(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    const peerId = _toNumber(req.params.peerId, 'peer id');
    const result = await aiChatService.seedChatMemory(
      sessionId,
      userId,
      peerType,
      peerId,
      req.body || {}
    );
    logger.info(`AI chat memory seeded`, { sessionId, peerType, peerId, seeded: result.seeded });
    res.json({ success: true, data: result });
  }),

  /**
   * DELETE /api/telegram/ai-chat/sessions/:id/ai-chats/:peerType/:peerId/memory
   */
  clearChatMemory: asyncHandler(async (req, res) => {
    const sessionId = _toNumber(req.params.id, 'session id');
    const userId = req.user.id;
    const peerType = String(req.params.peerType || '').toLowerCase();
    if (!['user', 'chat', 'channel'].includes(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    const peerId = _toNumber(req.params.peerId, 'peer id');
    const result = await aiChatService.clearChatMemory(sessionId, userId, peerType, peerId);
    res.json({ success: true, data: result });
  }),

  /**
   * GET /api/telegram/ai-chat/sessions/:id/ai-logs
   *
   * Query: ?limit=&offset=
   */
  listLogs: asyncHandler(async (req, res) => {
    const sessionId = _toNumber(req.params.id, 'session id');
    const userId = req.user.id;
    const rows = await aiChatService.listLogs(sessionId, userId, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, data: { rows, total: rows.length } });
  }),

  /**
   * GET /api/telegram/ai-chat/cupidbot-key
   */
  getCupidbotKey: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const role = req.user && req.user.role;
    const isAdmin =
      userId === 1 || role === 'admin' || role === 'superadmin';
    let hasKey = false;
    let isValid = false;

    try {
      const result = await cupidbotService.getAccessToken(userId);
      hasKey = true;
      isValid = result.isValid;
    } catch {
      hasKey = false;
      isValid = false;
    }

    res.json({
      success: true,
      data: { hasKey, isValid, isAdmin, configuredInEnv: !!process.env.CUPIDBOT_ACCESS_TOKEN },
    });
  }),

  /**
   * POST /api/telegram/ai-chat/cupidbot-key
   */
  setCupidbotKey: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { apiKey } = req.body || {};
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new AppError('apiKey is required', 400, 'MISSING_API_KEY');
    }
    const result = await cupidbotService.setUserApiKey(userId, apiKey.trim());
    if (!result.isValid) {
      throw new AppError('Invalid CupidBot API key', 400, 'INVALID_CUPIDBOT_KEY');
    }
    logger.info(`CupidBot API key updated`, { userId });
    res.json({ success: true, data: result });
  }),

  /**
   * DELETE /api/telegram/ai-chat/cupidbot-key
   */
  deleteCupidbotKey: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    await cupidbotService.deleteUserApiKey(userId);
    logger.info(`CupidBot API key deleted`, { userId });
    res.json({ success: true, data: { deleted: true } });
  }),
};

module.exports = aiChatController;
