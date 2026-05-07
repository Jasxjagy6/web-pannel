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
   * PATCH /sessions/:id/dialogs/:peerType/:peerId/messages/:messageId
   * Body: { text }
   */
  editMessage: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const messageId = parseInt(req.params.messageId, 10);
    if (!Number.isFinite(messageId)) {
      throw new AppError('messageId must be an integer', 400, 'BAD_MESSAGE_ID');
    }
    const data = await tcService.editMessage(req.params.id, req.user.id, peerType, peerId, {
      messageId,
      text: req.body?.text,
    });
    await reportService
      .logActivity(req.user.id, 'tg_client_edit_message', 'session', req.params.id, {
        platform: 'telegram',
        peerType,
        peerId: String(peerId),
        messageId,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * DELETE /sessions/:id/dialogs/:peerType/:peerId/messages
   * Body: { messageIds: [..], revoke?: bool }
   *
   * Single-id convenience: messageIds can also be passed as a number on
   * the URL (DELETE /messages/:id) — see the route definition.
   */
  deleteMessages: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    let messageIds;
    if (req.params.messageId) {
      const single = parseInt(req.params.messageId, 10);
      messageIds = Number.isFinite(single) ? [single] : [];
    } else {
      messageIds = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
    }
    const revoke = req.body?.revoke !== false && req.query?.revoke !== 'false';
    const data = await tcService.deleteMessages(req.params.id, req.user.id, peerType, peerId, {
      messageIds,
      revoke,
    });
    await reportService
      .logActivity(req.user.id, 'tg_client_delete_messages', 'session', req.params.id, {
        platform: 'telegram',
        peerType,
        peerId: String(peerId),
        count: messageIds.length,
        revoke,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * POST /sessions/clear-history
   *
   * Body: { sessionIds: (string|number)[], revoke?: bool }
   *
   * Bulk action triggered from the Telegram Login page. Wipes the chat
   * history of every dialog in every selected session in parallel and
   * returns per-session results so the UI can show a per-account
   * succeeded / failed breakdown.
   *
   * `revoke=true` translates to "delete from both sides" everywhere it
   * is allowed by Telegram (private chats / basic groups always; channels
   * only if the caller is an admin with delete_messages rights).
   */
  clearAllChatsHistory: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionIds = Array.isArray(req.body?.sessionIds)
      ? req.body.sessionIds
      : [];
    const revoke = req.body?.revoke === true || req.body?.revoke === 'true';

    if (sessionIds.length === 0) {
      throw new AppError('sessionIds is required', 400, 'SESSION_IDS_REQUIRED');
    }
    if (sessionIds.length > 50) {
      throw new AppError(
        'At most 50 sessions can be cleared at once',
        400,
        'TOO_MANY_SESSIONS',
      );
    }

    // De-dupe while preserving order so the response matches the UI's
    // expected ordering, and reject obviously bad ids early.
    const seen = new Set();
    const ids = [];
    for (const raw of sessionIds) {
      const id = String(raw || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (ids.length === 0) {
      throw new AppError('sessionIds is required', 400, 'SESSION_IDS_REQUIRED');
    }

    // Run per-session in parallel — each session has its own GramJS
    // client so they don't share rate limits. We always resolve so a
    // single bad session never poisons the response.
    const settled = await Promise.all(
      ids.map((sessionId) =>
        tcService
          .deleteAllChatsHistory(sessionId, userId, { revoke })
          .then((data) => ({ ok: true, sessionId, data }))
          .catch((err) => ({
            ok: false,
            sessionId,
            error: err?.message || 'Failed to clear chats',
            code: err?.code || err?.errorCode || null,
            status: err?.statusCode || err?.status || 500,
          })),
      ),
    );

    let totalSucceeded = 0;
    let totalFailed = 0;
    let totalDialogs = 0;
    for (const r of settled) {
      if (r.ok) {
        totalSucceeded += r.data.succeeded;
        totalFailed += r.data.failed;
        totalDialogs += r.data.total;
      }
    }

    await reportService
      .logActivity(userId, 'tg_client_clear_all_chats', 'session', null, {
        platform: 'telegram',
        sessionCount: ids.length,
        revoke,
        totalDialogs,
        totalSucceeded,
        totalFailed,
      })
      .catch((err) =>
        logger.debug(`logActivity tg_client_clear_all_chats failed: ${err.message}`),
      );

    res.json({
      success: true,
      data: {
        revoke,
        sessionCount: ids.length,
        totalDialogs,
        totalSucceeded,
        totalFailed,
        sessions: settled,
      },
    });
  }),

  /**
   * POST /sessions/:id/forward
   * Body: { fromPeerType, fromPeerId, toPeerType, toPeerId, messageIds, dropAuthor?, silent? }
   */
  forwardMessages: asyncHandler(async (req, res) => {
    const data = await tcService.forwardMessages(req.params.id, req.user.id, {
      fromPeerType: req.body?.fromPeerType,
      fromPeerId: req.body?.fromPeerId,
      toPeerType: req.body?.toPeerType,
      toPeerId: req.body?.toPeerId,
      messageIds: req.body?.messageIds,
      dropAuthor: !!req.body?.dropAuthor,
      silent: !!req.body?.silent,
    });
    await reportService
      .logActivity(req.user.id, 'tg_client_forward', 'session', req.params.id, {
        platform: 'telegram',
        from: `${req.body?.fromPeerType}:${req.body?.fromPeerId}`,
        to: `${req.body?.toPeerType}:${req.body?.toPeerId}`,
        count: Array.isArray(req.body?.messageIds) ? req.body.messageIds.length : 0,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * GET /sessions/:id/dialogs/:peerType/:peerId/messages/:messageId/media
   *
   * Query params:
   *   thumb=1     fetch the thumbnail-sized preview only (jpeg)
   *   download=1  send Content-Disposition: attachment for "Save as"
   *
   * Honors HTTP Range so HTML5 <video>/<audio> can stream out of the
   * cached buffer. 204 when there's no media or it couldn't be downloaded.
   *
   * Caches the buffer in the service-layer LRU so repeat Range hits and
   * a "thumb then full" sequence don't re-download from Telegram.
   */
  getMessageMedia: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const messageId = parseInt(req.params.messageId, 10);
    if (!Number.isFinite(messageId)) {
      throw new AppError('messageId must be an integer', 400, 'BAD_MESSAGE_ID');
    }
    const wantThumb = req.query.thumb === '1' || req.query.thumb === 'true';
    const wantDownload = req.query.download === '1' || req.query.download === 'true';

    const result = await tcService.downloadMessageMedia(
      req.params.id,
      req.user.id,
      peerType,
      peerId,
      messageId,
      { thumb: wantThumb }
    );
    if (!result) return res.status(204).end();

    const buf = result.buffer;
    const total = buf.length;
    const etag = `W/"tgmedia-${result.docId || messageId}-${wantThumb ? 't' : 'f'}-${total}"`;
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.status(304).end();
      return;
    }

    const filename = (result.fileName || 'media').replace(/"/g, '_');
    const dispoType = wantDownload ? 'attachment' : 'inline';

    // Telegram-side metadata for the player.
    if (result.kind) res.setHeader('X-Tg-Media-Kind', result.kind);
    if (result.width) res.setHeader('X-Tg-Media-Width', String(result.width));
    if (result.height) res.setHeader('X-Tg-Media-Height', String(result.height));
    if (result.duration) res.setHeader('X-Tg-Media-Duration', String(result.duration));
    if (result.isThumb) res.setHeader('X-Tg-Media-Is-Thumb', '1');

    res.setHeader('Content-Type', result.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${dispoType}; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag);
    res.setHeader('X-No-Compression', '1');

    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && start < total) {
        const clampedEnd = Math.min(end, total - 1);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${clampedEnd}/${total}`);
        res.setHeader('Content-Length', String(clampedEnd - start + 1));
        return res.end(buf.slice(start, clampedEnd + 1));
      }
      // Out of range
      res.status(416);
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.end();
    }

    res.setHeader('Content-Length', String(total));
    return res.end(buf);
  }),

  /**
   * GET /sessions/:id/profile/me
   */
  getSelfProfile: asyncHandler(async (req, res) => {
    const data = await tcService.getSelfProfile(req.params.id, req.user.id);
    res.json({ success: true, data });
  }),

  /**
   * PATCH /sessions/:id/profile/me
   * Body: { firstName?, lastName?, bio? }
   */
  updateSelfProfile: asyncHandler(async (req, res) => {
    const data = await tcService.updateSelfProfile(req.params.id, req.user.id, {
      firstName: req.body?.firstName,
      lastName: req.body?.lastName,
      bio: req.body?.bio,
    });
    await reportService
      .logActivity(req.user.id, 'tg_client_update_self_profile', 'session', req.params.id, {
        platform: 'telegram',
        fields: Object.keys(req.body || {}),
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * PATCH /sessions/:id/profile/me/username
   * Body: { username }
   */
  updateSelfUsername: asyncHandler(async (req, res) => {
    const data = await tcService.updateSelfUsername(
      req.params.id,
      req.user.id,
      req.body?.username,
    );
    await reportService
      .logActivity(req.user.id, 'tg_client_update_username', 'session', req.params.id, {
        platform: 'telegram',
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * GET /sessions/:id/profile/me/check-username?username=...
   */
  checkSelfUsername: asyncHandler(async (req, res) => {
    const data = await tcService.checkSelfUsername(
      req.params.id,
      req.user.id,
      String(req.query?.username || ''),
    );
    res.json({ success: true, data });
  }),

  /**
   * POST /sessions/:id/profile/me/photo  (multipart "photo")
   */
  updateSelfPhoto: asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw new AppError('photo file is required', 400, 'NO_FILE');
    const data = await tcService.updateSelfPhoto(req.params.id, req.user.id, {
      filePath: file.path,
      fileName: file.originalname,
    });
    await reportService
      .logActivity(req.user.id, 'tg_client_update_photo', 'session', req.params.id, {
        platform: 'telegram',
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * DELETE /sessions/:id/profile/me/photo
   */
  deleteSelfPhoto: asyncHandler(async (req, res) => {
    const data = await tcService.deleteSelfPhoto(req.params.id, req.user.id);
    await reportService
      .logActivity(req.user.id, 'tg_client_delete_photo', 'session', req.params.id, {
        platform: 'telegram',
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  // ---------------------------------------------------------------------
  // D6 — Peer profile (other user / chat / channel)
  // ---------------------------------------------------------------------

  /**
   * GET /sessions/:id/profile/:peerType/:peerId
   */
  getPeerProfile: asyncHandler(async (req, res) => {
    const { peerType, peerId } = req.params;
    const data = await tcService.getPeerProfile(req.params.id, req.user.id, peerType, peerId);
    res.json({ success: true, data });
  }),

  /**
   * PATCH /sessions/:id/profile/:peerType/:peerId/block
   * Body: { blocked: boolean }
   */
  setPeerBlocked: asyncHandler(async (req, res) => {
    const { peerType, peerId } = req.params;
    const blocked = req.body?.blocked === true;
    const data = await tcService.setPeerBlocked(req.params.id, req.user.id, peerType, peerId, blocked);
    await reportService
      .logActivity(req.user.id, blocked ? 'tg_client_block_peer' : 'tg_client_unblock_peer', 'session', req.params.id, {
        platform: 'telegram', peerType, peerId,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * PATCH /sessions/:id/profile/:peerType/:peerId/mute
   * Body: { muted: boolean, muteUntilSec?: number }
   */
  setPeerMuted: asyncHandler(async (req, res) => {
    const { peerType, peerId } = req.params;
    const muted = req.body?.muted === true;
    const muteUntilSec = req.body?.muteUntilSec;
    const data = await tcService.setPeerMuted(req.params.id, req.user.id, peerType, peerId, muted, muteUntilSec);
    await reportService
      .logActivity(req.user.id, muted ? 'tg_client_mute_peer' : 'tg_client_unmute_peer', 'session', req.params.id, {
        platform: 'telegram', peerType, peerId,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * GET /sessions/:id/profile/user/:peerId/common-chats?limit=100
   */
  getCommonChats: asyncHandler(async (req, res) => {
    const data = await tcService.getCommonChats(
      req.params.id,
      req.user.id,
      req.params.peerId,
      { limit: parseInt(req.query?.limit, 10) || 100 },
    );
    res.json({ success: true, data });
  }),

  // ---------------------------------------------------------------------
  // D10 — Group / channel info + admin
  // ---------------------------------------------------------------------

  /**
   * GET /sessions/:id/dialogs/:peerType/:peerId/members?filter=&search=&offset=&limit=
   */
  getChatMembers: asyncHandler(async (req, res) => {
    const { peerType, peerId } = req.params;
    const data = await tcService.getChatMembers(
      req.params.id,
      req.user.id,
      peerType,
      peerId,
      {
        filter: req.query?.filter,
        search: req.query?.search,
        offset: parseInt(req.query?.offset, 10) || 0,
        limit: parseInt(req.query?.limit, 10) || 200,
      },
    );
    res.json({ success: true, data });
  }),

  /**
   * POST /sessions/:id/dialogs/:peerType/:peerId/members
   * Body: { userId, fwdLimit? }
   */
  addChatMember: asyncHandler(async (req, res) => {
    const { peerType, peerId } = req.params;
    const data = await tcService.addChatMember(
      req.params.id,
      req.user.id,
      peerType,
      peerId,
      req.body?.userId,
      { fwdLimit: req.body?.fwdLimit },
    );
    await reportService
      .logActivity(req.user.id, 'tg_client_add_member', 'session', req.params.id, {
        platform: 'telegram', peerType, peerId, targetUserId: req.body?.userId,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * DELETE /sessions/:id/dialogs/:peerType/:peerId/members/:userId?ban=true&untilDate=...
   */
  kickChatMember: asyncHandler(async (req, res) => {
    const { peerType, peerId, userId: targetUserId } = req.params;
    const ban = String(req.query?.ban || req.body?.ban || '').toLowerCase() === 'true' || req.body?.ban === true;
    const untilDate = parseInt(req.query?.untilDate || req.body?.untilDate, 10) || 0;
    const data = await tcService.kickChatMember(
      req.params.id,
      req.user.id,
      peerType,
      peerId,
      targetUserId,
      { ban, untilDate },
    );
    await reportService
      .logActivity(req.user.id, ban ? 'tg_client_ban_member' : 'tg_client_kick_member', 'session', req.params.id, {
        platform: 'telegram', peerType, peerId, targetUserId,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * PATCH /sessions/:id/dialogs/:peerType/:peerId/members/:userId/admin
   * Body: { isAdmin, rights?, rank? }
   */
  setChatAdmin: asyncHandler(async (req, res) => {
    const { peerType, peerId, userId: targetUserId } = req.params;
    const data = await tcService.setChatAdmin(
      req.params.id,
      req.user.id,
      peerType,
      peerId,
      targetUserId,
      {
        isAdmin: req.body?.isAdmin === true,
        rights: req.body?.rights,
        rank: req.body?.rank,
      },
    );
    await reportService
      .logActivity(req.user.id, 'tg_client_set_admin', 'session', req.params.id, {
        platform: 'telegram', peerType, peerId, targetUserId, isAdmin: req.body?.isAdmin === true,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * PATCH /sessions/:id/dialogs/:peerType/:peerId/title
   * Body: { title }
   */
  editChatTitle: asyncHandler(async (req, res) => {
    const { peerType, peerId } = req.params;
    const data = await tcService.editChatTitle(req.params.id, req.user.id, peerType, peerId, req.body?.title);
    await reportService
      .logActivity(req.user.id, 'tg_client_edit_chat_title', 'session', req.params.id, {
        platform: 'telegram', peerType, peerId,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * PATCH /sessions/:id/dialogs/:peerType/:peerId/about
   * Body: { about }
   */
  editChatAbout: asyncHandler(async (req, res) => {
    const { peerType, peerId } = req.params;
    const data = await tcService.editChatAbout(req.params.id, req.user.id, peerType, peerId, req.body?.about);
    await reportService
      .logActivity(req.user.id, 'tg_client_edit_chat_about', 'session', req.params.id, {
        platform: 'telegram', peerType, peerId,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * POST /sessions/:id/dialogs/:peerType/:peerId/photo (multipart 'photo')
   */
  editChatPhoto: asyncHandler(async (req, res) => {
    const { peerType, peerId } = req.params;
    if (!req.file) throw new AppError('photo file is required', 400, 'NO_FILE');
    const data = await tcService.editChatPhoto(req.params.id, req.user.id, peerType, peerId, {
      filePath: req.file.path,
      fileName: req.file.originalname,
    });
    await reportService
      .logActivity(req.user.id, 'tg_client_edit_chat_photo', 'session', req.params.id, {
        platform: 'telegram', peerType, peerId,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  /**
   * POST /sessions/:id/dialogs/:peerType/:peerId/leave
   */
  leaveChat: asyncHandler(async (req, res) => {
    const { peerType, peerId } = req.params;
    const data = await tcService.leaveChat(req.params.id, req.user.id, peerType, peerId);
    await reportService
      .logActivity(req.user.id, 'tg_client_leave_chat', 'session', req.params.id, {
        platform: 'telegram', peerType, peerId,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  // ---------------------------------------------------------------------
  // D7 — Settings (notifications, privacy, language)
  // ---------------------------------------------------------------------

  getDefaultNotifySettings: asyncHandler(async (req, res) => {
    const data = await tcService.getDefaultNotifySettings(req.params.id, req.user.id);
    res.json({ success: true, data });
  }),

  setDefaultNotifySettings: asyncHandler(async (req, res) => {
    const data = await tcService.setDefaultNotifySettings(
      req.params.id,
      req.user.id,
      req.params.kind,
      req.body || {},
    );
    await reportService
      .logActivity(req.user.id, 'tg_client_update_notify', 'session', req.params.id, {
        platform: 'telegram', kind: req.params.kind,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  resetNotifySettings: asyncHandler(async (req, res) => {
    const data = await tcService.resetNotifySettings(req.params.id, req.user.id);
    await reportService
      .logActivity(req.user.id, 'tg_client_reset_notify', 'session', req.params.id, {
        platform: 'telegram',
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  getPrivacy: asyncHandler(async (req, res) => {
    const data = await tcService.getPrivacy(req.params.id, req.user.id, req.params.key);
    res.json({ success: true, data });
  }),

  setPrivacy: asyncHandler(async (req, res) => {
    const data = await tcService.setPrivacy(req.params.id, req.user.id, req.params.key, req.body || {});
    await reportService
      .logActivity(req.user.id, 'tg_client_set_privacy', 'session', req.params.id, {
        platform: 'telegram', key: req.params.key,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  getLanguage: asyncHandler(async (req, res) => {
    const data = await tcService.getLanguage(req.params.id, req.user.id);
    res.json({ success: true, data });
  }),

  listLanguages: asyncHandler(async (req, res) => {
    const data = await tcService.listLanguages(req.params.id, req.user.id);
    res.json({ success: true, data });
  }),

  // ---------------------------------------------------------------------
  // D8 — Security: 2FA + active sessions
  // ---------------------------------------------------------------------

  get2FAState: asyncHandler(async (req, res) => {
    const data = await tcService.get2FAState(req.params.id, req.user.id);
    res.json({ success: true, data });
  }),

  enable2FA: asyncHandler(async (req, res) => {
    const data = await tcService.enable2FA(req.params.id, req.user.id, req.body || {});
    await reportService
      .logActivity(req.user.id, 'tg_client_enable_2fa', 'session', req.params.id, {
        platform: 'telegram',
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  disable2FA: asyncHandler(async (req, res) => {
    const data = await tcService.disable2FA(req.params.id, req.user.id, req.body || {});
    await reportService
      .logActivity(req.user.id, 'tg_client_disable_2fa', 'session', req.params.id, {
        platform: 'telegram',
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  change2FA: asyncHandler(async (req, res) => {
    const data = await tcService.change2FA(req.params.id, req.user.id, req.body || {});
    await reportService
      .logActivity(req.user.id, 'tg_client_change_2fa', 'session', req.params.id, {
        platform: 'telegram',
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  listAuthorizations: asyncHandler(async (req, res) => {
    const data = await tcService.listAuthorizations(req.params.id, req.user.id);
    res.json({ success: true, data });
  }),

  resetAuthorization: asyncHandler(async (req, res) => {
    const data = await tcService.resetAuthorization(req.params.id, req.user.id, req.params.hash);
    await reportService
      .logActivity(req.user.id, 'tg_client_reset_authorization', 'session', req.params.id, {
        platform: 'telegram',
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  resetOtherAuthorizations: asyncHandler(async (req, res) => {
    const data = await tcService.resetOtherAuthorizations(req.params.id, req.user.id);
    await reportService
      .logActivity(req.user.id, 'tg_client_reset_other_authorizations', 'session', req.params.id, {
        platform: 'telegram',
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  setAuthorizationTtl: asyncHandler(async (req, res) => {
    const data = await tcService.setAuthorizationTtl(req.params.id, req.user.id, req.body?.days);
    res.json({ success: true, data });
  }),

  // ---------------------------------------------------------------------
  // D9 — Contacts
  // ---------------------------------------------------------------------

  listContacts: asyncHandler(async (req, res) => {
    const data = await tcService.listContacts(req.params.id, req.user.id, {
      search: req.query.search,
    });
    res.json({ success: true, data });
  }),

  searchContacts: asyncHandler(async (req, res) => {
    const data = await tcService.searchContacts(req.params.id, req.user.id, req.query.q, {
      limit: Number(req.query.limit) || 20,
    });
    res.json({ success: true, data });
  }),

  addContact: asyncHandler(async (req, res) => {
    const data = await tcService.addContact(req.params.id, req.user.id, req.body || {});
    await reportService
      .logActivity(req.user.id, 'tg_client_add_contact', 'session', req.params.id, {
        platform: 'telegram',
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  deleteContacts: asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const data = await tcService.deleteContacts(req.params.id, req.user.id, ids);
    await reportService
      .logActivity(req.user.id, 'tg_client_delete_contacts', 'session', req.params.id, {
        platform: 'telegram', count: ids.length,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  // ---------------------------------------------------------------------
  // D12 — Drafts
  // ---------------------------------------------------------------------

  saveDraft: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const data = await tcService.saveDraft(req.params.id, req.user.id, peerType, peerId, {
      text: req.body?.text,
      replyToMsgId: req.body?.replyToMsgId,
      noWebpage: req.body?.noWebpage,
    });
    res.json({ success: true, data });
  }),

  clearDraft: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const data = await tcService.clearDraft(req.params.id, req.user.id, peerType, peerId);
    res.json({ success: true, data });
  }),

  getAllDrafts: asyncHandler(async (req, res) => {
    const data = await tcService.getAllDrafts(req.params.id, req.user.id);
    res.json({ success: true, data });
  }),

  // ---------------------------------------------------------------------
  // D13 — Pinned messages
  // ---------------------------------------------------------------------

  pinMessage: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const data = await tcService.pinMessage(
      req.params.id, req.user.id, peerType, peerId, req.params.messageId, {
        silent: req.body?.silent,
        pmOneside: req.body?.pmOneside,
      },
    );
    await reportService
      .logActivity(req.user.id, 'tg_client_pin', 'session', req.params.id, {
        platform: 'telegram', peerType, peerId: String(peerId), messageId: req.params.messageId,
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  unpinMessage: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const data = await tcService.unpinMessage(
      req.params.id, req.user.id, peerType, peerId, req.params.messageId,
    );
    res.json({ success: true, data });
  }),

  unpinAllMessages: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const data = await tcService.unpinAllMessages(
      req.params.id, req.user.id, peerType, peerId,
    );
    await reportService
      .logActivity(req.user.id, 'tg_client_unpin_all', 'session', req.params.id, {
        platform: 'telegram', peerType, peerId: String(peerId),
      })
      .catch(() => {});
    res.json({ success: true, data });
  }),

  getPinnedMessages: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const data = await tcService.getPinnedMessages(
      req.params.id, req.user.id, peerType, peerId, {
        limit: req.query.limit,
        offsetId: req.query.offsetId,
      },
    );
    res.json({ success: true, data });
  }),

  // ---------------------------------------------------------------------
  // D4 — Search
  // ---------------------------------------------------------------------

  searchInChat: asyncHandler(async (req, res) => {
    const { peerType, peerId } = _parsePeer(req);
    const data = await tcService.searchInChat(
      req.params.id, req.user.id, peerType, peerId, req.query.q, {
        limit: req.query.limit,
        offsetId: req.query.offsetId,
        filter: req.query.filter,
        fromId: req.query.fromId,
      },
    );
    res.json({ success: true, data });
  }),

  searchGlobal: asyncHandler(async (req, res) => {
    const data = await tcService.searchGlobal(req.params.id, req.user.id, req.query.q, {
      limit: req.query.limit,
      offsetId: req.query.offsetId,
      offsetRate: req.query.offsetRate,
      filter: req.query.filter,
    });
    res.json({ success: true, data });
  }),

  // ---------------------------------------------------------------------
  // D11 — Stickers / GIFs
  // ---------------------------------------------------------------------

  getStickerSets: asyncHandler(async (req, res) => {
    const data = await tcService.getStickerSets(req.params.id, req.user.id);
    res.json({ success: true, data });
  }),

  getRecentStickers: asyncHandler(async (req, res) => {
    const data = await tcService.getRecentStickers(req.params.id, req.user.id);
    res.json({ success: true, data });
  }),

  getFavoriteStickers: asyncHandler(async (req, res) => {
    const data = await tcService.getFavoriteStickers(req.params.id, req.user.id);
    res.json({ success: true, data });
  }),

  searchStickers: asyncHandler(async (req, res) => {
    const data = await tcService.searchStickerSets(req.params.id, req.user.id, req.query.q);
    res.json({ success: true, data });
  }),

  getSavedGifs: asyncHandler(async (req, res) => {
    const data = await tcService.getSavedGifs(req.params.id, req.user.id);
    res.json({ success: true, data });
  }),

  searchGifs: asyncHandler(async (req, res) => {
    const data = await tcService.searchGifs(req.params.id, req.user.id, req.query.q, {
      offset: req.query.offset,
    });
    res.json({ success: true, data });
  }),

  // GET /sessions/:id/documents/:documentId/media?accessHash=&fileReference=
  getDocumentMedia: asyncHandler(async (req, res) => {
    const documentId = req.params.documentId;
    const accessHash = req.query.accessHash;
    const fileReference = req.query.fileReference;
    const wantThumb = req.query.thumb === '1' || req.query.thumb === 'true';

    const result = await tcService.downloadDocumentMedia(
      req.params.id,
      req.user.id,
      documentId,
      accessHash,
      fileReference,
      { thumb: wantThumb }
    );
    if (!result) return res.status(204).end();

    const buf = result.buffer;
    const total = buf.length;
    const etag = `W/"tgdoc-${result.docId}-${wantThumb ? 't' : 'f'}-${total}"`;
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', result.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag);
    if (result.isThumb) res.setHeader('X-Tg-Media-Is-Thumb', '1');

    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && start < total) {
        const clampedEnd = Math.min(end, total - 1);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${clampedEnd}/${total}`);
        res.setHeader('Content-Length', String(clampedEnd - start + 1));
        return res.end(buf.slice(start, clampedEnd + 1));
      }
      res.status(416);
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.end();
    }
    res.setHeader('Content-Length', String(total));
    return res.end(buf);
  }),
};

module.exports = telegramClientController;
