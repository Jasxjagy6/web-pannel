/**
 * TelegramClientController — HTTP surface for the in-panel Telegram client.
 *
 * All endpoints are scoped to `parsePlatform('telegram')` and
 * `requireApproved`, so:
 *   - Instagram callers cannot reach them (the IG router never mounts this),
 *   - banned/un-approved users cannot reach them,
 *   - cross-user session access is rejected inside the service layer.
 */

const tcService = require('../services/telegramClientService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

/**
 * Parse + validate (peerType, peerId) from request params. peerId is
 * accepted as a signed integer string; the service layer narrows it to
 * a number where needed.
 */
function _parsePeer(req) {
  const peerType = String(req.params.peerType || '').toLowerCase();
  const peerId = req.params.peerId;
  if (!['user', 'chat', 'channel'].includes(peerType)) {
    throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
  }
  if (peerId == null || peerId === '') {
    throw new AppError('peerId is required', 400, 'PEER_ID_REQUIRED');
  }
  return { peerType, peerId };
}

const telegramClientController = {
  /**
   * GET /sessions
   *
   * Sessions the caller can launch the client for. Used by the "Login"
   * landing page in the panel.
   */
  listSessions: asyncHandler(async (req, res) => {
    const sessions = await tcService.listLoggableSessions(req.user.id);
    res.json({ success: true, data: { sessions, total: sessions.length } });
  }),

  /**
   * POST /sessions/:id/connect
   *
   * Idempotent. Drives sessionService.loginSession the first time so the
   * UI doesn't have to. Returns the resolved `me` snapshot.
   */
  connect: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;
    const result = await tcService.connect(sessionId, userId);
    await reportService
      .logActivity(userId, 'tg_client_connect', 'session', sessionId, {
        platform: 'telegram',
        ok: !!result.connected,
      })
      .catch((err) => logger.debug(`logActivity failed: ${err.message}`));
    res.json({ success: true, data: result });
  }),

  /**
   * GET /sessions/:id/me
   */
  getMe: asyncHandler(async (req, res) => {
    const me = await tcService.getMe(req.params.id, req.user.id);
    res.json({ success: true, data: { me } });
  }),

  /**
   * GET /sessions/:id/dialogs
   */
  getDialogs: asyncHandler(async (req, res) => {
    const data = await tcService.getDialogs(req.params.id, req.user.id, {
      limit: req.query.limit,
    });
    res.json({ success: true, data });
  }),

  /**
   * GET /sessions/:id/dialogs/:peerType/:peerId/messages
   */
  getMessages: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const data = await tcService.getMessages(
      req.params.id,
      req.user.id,
      peerType,
      peerId,
      { limit: req.query.limit, offsetId: req.query.offsetId }
    );
    res.json({ success: true, data });
  }),

  /**
   * POST /sessions/:id/dialogs/:peerType/:peerId/send
   */
  sendMessage: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const data = await tcService.sendMessage(
      req.params.id,
      req.user.id,
      peerType,
      peerId,
      {
        text: req.body?.text,
        replyToMsgId: req.body?.replyToMsgId,
        silent: !!req.body?.silent,
      }
    );
    await reportService
      .logActivity(req.user.id, 'tg_client_send', 'session', req.params.id, {
        platform: 'telegram',
        peerType,
        peerId: String(peerId),
        len: (req.body?.text || '').length,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * POST /sessions/:id/dialogs/:peerType/:peerId/read
   */
  markRead: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const maxId = req.body?.maxId;
    const data = await tcService.markRead(
      req.params.id,
      req.user.id,
      peerType,
      peerId,
      maxId
    );
    res.json({ success: true, data });
  }),

  /**
   * GET /sessions/:id/photo/:peerType/:peerId?large=1
   *
   * Streams the JPEG profile photo for the entity. 204 when the entity
   * has no photo (so the frontend can render initials instead).
   */
  getProfilePhoto: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const buf = await tcService.downloadProfilePhoto(
      req.params.id,
      req.user.id,
      peerType,
      peerId,
      { large: req.query.large === '1' || req.query.large === 'true' }
    );
    if (!buf) return res.status(204).end();
    res.setHeader('Content-Type', 'image/jpeg');
    // Profile photos rarely change inside a single session view; cache
    // briefly inside the user's browser. Using `private` because the
    // panel proxy is shared.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-No-Compression', '1');
    return res.end(buf);
  }),

  /**
   * POST /sessions/:id/dialogs/:peerType/:peerId/send-media
   *
   * multipart/form-data — file under field `file`, plus `kind`,
   * `caption`, `replyToMsgId`, `silent`, `clientMsgId`,
   * `duration`, `width`, `height`. Server emits per-upload
   * progress on `tg-client:uploadProgress` while GramJS streams
   * the upload to Telegram.
   */
  sendMedia: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const file = req.file;
    if (!file) {
      throw new AppError('file is required', 400, 'FILE_REQUIRED');
    }
    const data = await tcService.sendMedia(
      req.params.id,
      req.user.id,
      peerType,
      peerId,
      {
        kind: req.body?.kind || 'auto',
        filePath: file.path,
        fileName: file.originalname || undefined,
        mimeType: file.mimetype || undefined,
        caption: req.body?.caption,
        replyToMsgId: req.body?.replyToMsgId,
        silent: req.body?.silent === 'true' || req.body?.silent === true,
        clientMsgId: req.body?.clientMsgId,
        duration: req.body?.duration,
        width: req.body?.width,
        height: req.body?.height,
        waveform: req.body?.waveform,
      }
    );
    await reportService
      .logActivity(req.user.id, 'tg_client_send_media', 'session', req.params.id, {
        platform: 'telegram',
        peerType,
        peerId: String(peerId),
        kind: data.kind,
        size: file.size,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * POST /sessions/:id/dialogs/:peerType/:peerId/send-voice
   *
   * Same multipart shape as send-media but the file lives under
   * `voice` and is force-rendered as a voice note.
   */
  sendVoice: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const file = req.file;
    if (!file) {
      throw new AppError('voice is required', 400, 'VOICE_REQUIRED');
    }
    const data = await tcService.sendVoice(
      req.params.id,
      req.user.id,
      peerType,
      peerId,
      {
        filePath: file.path,
        fileName: file.originalname || 'voice.ogg',
        mimeType: file.mimetype || 'audio/ogg',
        replyToMsgId: req.body?.replyToMsgId,
        silent: req.body?.silent === 'true' || req.body?.silent === true,
        clientMsgId: req.body?.clientMsgId,
        duration: req.body?.duration,
        waveform: req.body?.waveform,
      }
    );
    res.json({ success: true, data });
  }),

  /**
   * POST /sessions/:id/dialogs/:peerType/:peerId/send-sticker
   *
   * Two modes:
   *   - JSON body { documentId, accessHash, fileReference } to re-send
   *     a sticker the user already has in their stickerset cache.
   *   - multipart with `file` to upload a one-off sticker (rare; used
   *     for custom stickers).
   */
  sendSticker: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const file = req.file;
    const data = await tcService.sendSticker(
      req.params.id,
      req.user.id,
      peerType,
      peerId,
      file
        ? {
            filePath: file.path,
            fileName: file.originalname || 'sticker.webp',
            mimeType: file.mimetype || 'image/webp',
            replyToMsgId: req.body?.replyToMsgId,
            silent: req.body?.silent === 'true' || req.body?.silent === true,
            clientMsgId: req.body?.clientMsgId,
          }
        : {
            documentId: req.body?.documentId,
            accessHash: req.body?.accessHash,
            fileReference: req.body?.fileReference,
            replyToMsgId: req.body?.replyToMsgId,
            silent: !!req.body?.silent,
            clientMsgId: req.body?.clientMsgId,
          }
    );
    res.json({ success: true, data });
  }),

  /**
   * GET /sessions/:id/dialogs/:peerType/:peerId/messages/:messageId/media
   *
   * Streams photo/document attached to the message. 204 when there's no
   * media or it couldn't be downloaded.
   */
  getMessageMedia: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const messageId = parseInt(req.params.messageId, 10);
    if (!Number.isFinite(messageId)) {
      throw new AppError('messageId must be an integer', 400, 'BAD_MESSAGE_ID');
    }
    const result = await tcService.downloadMessageMedia(
      req.params.id,
      req.user.id,
      peerType,
      peerId,
      messageId
    );
    if (!result) return res.status(204).end();
    res.setHeader('Content-Type', result.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${(result.fileName || 'media').replace(/"/g, '_')}"`
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-No-Compression', '1');
    return res.end(result.buffer);
  }),
};

module.exports = telegramClientController;
