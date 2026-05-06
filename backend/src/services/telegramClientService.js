/**
 * TelegramClientService — facade that powers the in-panel Telegram client UI.
 *
 * The panel already maintains one live GramJS `TelegramClient` per session
 * (see `telegramService.js::clients`). This module is a thin, UI-shaped
 * facade over those clients: it speaks dialogs / messages / send / read /
 * profile photos and returns plain JSON shapes the React client renders
 * directly.
 *
 * It deliberately does NOT duplicate session lifecycle / proxy assignment /
 * encryption — those stay in `telegramService` and `sessionService`.
 *
 * All methods take a panel userId so the underlying session row can be
 * authorized against the calling user every call. The `clients` Map is
 * shared, so per-session multi-window isolation comes for free.
 */

const { Api } = require('telegram');
const { pool } = require('../config/database');
const tgService = require('./telegramService');
const sessionService = require('./sessionService');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const PEER_TYPES = new Set(['user', 'chat', 'channel']);
const DEFAULT_DIALOGS_LIMIT = 50;
const MAX_DIALOGS_LIMIT = 200;
const DEFAULT_MESSAGES_LIMIT = 50;
const MAX_MESSAGES_LIMIT = 100;

/**
 * Look up `{ id, user_id, status, is_logged_in, account_info, platform }`
 * for one session and authorize it against the caller. Throws AppError
 * (404) on miss, (403) on cross-user access.
 *
 * @param {string|number} sessionId
 * @param {string|number} userId
 */
async function _loadAndAuthSession(sessionId, userId) {
  const result = await pool.query(
    `SELECT id, user_id, status, is_logged_in, account_info, platform, phone
       FROM sessions WHERE id = $1 LIMIT 1`,
    [sessionId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(`Session not found: ${sessionId}`, 404, 'SESSION_NOT_FOUND');
  }
  if (String(row.user_id) !== String(userId)) {
    // 404 instead of 403 to avoid leaking session ownership.
    throw new AppError(`Session not found: ${sessionId}`, 404, 'SESSION_NOT_FOUND');
  }
  if (row.platform && row.platform !== 'telegram') {
    throw new AppError(
      'Telegram client is only available for Telegram sessions',
      400,
      'WRONG_PLATFORM'
    );
  }
  return row;
}

function _toIdNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  // GramJS returns BigInt-like objects with `.value`
  if (v && typeof v.toString === 'function') {
    const parsed = Number(v.toString());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function _toIsoDate(unixSeconds) {
  if (!unixSeconds && unixSeconds !== 0) return null;
  try {
    return new Date(Number(unixSeconds) * 1000).toISOString();
  } catch {
    return null;
  }
}

/**
 * Best-effort name for an entity (User / Chat / Channel).
 */
function _entityTitle(entity) {
  if (!entity) return null;
  if (entity.className === 'User') {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
    return name || entity.username || entity.phone || null;
  }
  return entity.title || entity.username || null;
}

/**
 * Determine the peerType ('user' | 'chat' | 'channel') from a GramJS entity
 * or peer object.
 */
function _peerTypeOf(entity) {
  if (!entity) return null;
  if (entity.className === 'User') return 'user';
  if (entity.className === 'Chat') return 'chat';
  if (entity.className === 'Channel') return 'channel';
  // Peer.* objects (UpdateNewMessage payloads etc.)
  if (entity.userId) return 'user';
  if (entity.chatId) return 'chat';
  if (entity.channelId) return 'channel';
  return null;
}

/**
 * Build a UI-friendly chat/dialog summary.
 */
function _normalizeDialog(dialog, ownId) {
  const entity = dialog.entity;
  if (!entity) return null;
  const peerType = _peerTypeOf(entity);
  if (!peerType) return null;

  const id = _toIdNum(entity.id);
  if (id == null) return null;

  const lastMsg = dialog.message || null;
  let lastMessage = null;
  if (lastMsg) {
    lastMessage = {
      id: _toIdNum(lastMsg.id),
      text: lastMsg.message || (lastMsg.media ? '[media]' : ''),
      out: !!lastMsg.out,
      fromId: _toIdNum(
        lastMsg.fromId?.userId ?? lastMsg.fromId?.channelId ?? lastMsg.fromId?.chatId ?? null
      ),
      date: _toIsoDate(lastMsg.date),
      hasMedia: !!lastMsg.media,
    };
  }

  return {
    peerType,
    peerId: id,
    accessHash: _toIdNum(entity.accessHash),
    title: _entityTitle(entity),
    username: entity.username || null,
    isSelf: peerType === 'user' && ownId != null && id === ownId,
    isBot: peerType === 'user' ? !!entity.bot : false,
    isVerified: !!entity.verified,
    isScam: !!entity.scam,
    isFake: !!entity.fake,
    isPremium: peerType === 'user' ? !!entity.premium : false,
    isBroadcast: peerType === 'channel' ? !!entity.broadcast : false,
    isMegagroup: peerType === 'channel' ? !!entity.megagroup : false,
    participantsCount: peerType === 'user' ? null : (entity.participantsCount ?? null),
    photoId: entity.photo?.photoId ? String(entity.photo.photoId) : null,
    hasPhoto: !!(entity.photo && (entity.photo.photoId || entity.photo.photoSmall)),
    unreadCount: dialog.unreadCount || 0,
    unreadMentionsCount: dialog.unreadMentionsCount || 0,
    pinned: !!dialog.pinned,
    folderId: dialog.folderId ?? null,
    lastMessage,
  };
}

/**
 * Best-effort sender shape attached to a normalized message.
 */
function _normalizeSender(sender) {
  if (!sender) return null;
  const peerType = _peerTypeOf(sender);
  if (!peerType) return null;
  const id = _toIdNum(sender.id);
  if (id == null) return null;
  return {
    peerType,
    peerId: id,
    title: _entityTitle(sender),
    username: sender.username || null,
    photoId: sender.photo?.photoId ? String(sender.photo.photoId) : null,
    hasPhoto: !!(sender.photo && (sender.photo.photoId || sender.photo.photoSmall)),
    isBot: peerType === 'user' ? !!sender.bot : false,
    isPremium: peerType === 'user' ? !!sender.premium : false,
  };
}

/**
 * Build a UI-friendly message shape from a GramJS Message object.
 *
 * The client doesn't need every flag — it needs: id, text, who sent it
 * (so we can render a name + avatar), when, whether it's outgoing,
 * whether it has media (so we can draw a thumbnail placeholder).
 */
function _normalizeMessage(msg, ownId, dialogPeer) {
  if (!msg) return null;
  const fromPeer = msg.fromId || msg.peerId || dialogPeer || null;
  const fromIdRaw =
    fromPeer?.userId ?? fromPeer?.channelId ?? fromPeer?.chatId ?? null;
  const out = !!msg.out;
  const fromId = _toIdNum(fromIdRaw);

  // Detect a few common media shapes so the UI can show "[photo]",
  // "[video]" placeholders. Full download is supported separately
  // via GET /media/:messageId.
  let mediaKind = null;
  if (msg.media) {
    const cn = msg.media.className || '';
    if (cn.includes('Photo')) mediaKind = 'photo';
    else if (cn.includes('Document')) {
      // Documents include videos, voice, files, stickers — best-effort.
      const attrs = msg.media.document?.attributes || [];
      const hasVideo = attrs.some((a) => a.className === 'DocumentAttributeVideo');
      const hasAudio = attrs.some((a) => a.className === 'DocumentAttributeAudio');
      const hasSticker = attrs.some((a) => a.className === 'DocumentAttributeSticker');
      if (hasSticker) mediaKind = 'sticker';
      else if (hasVideo) mediaKind = 'video';
      else if (hasAudio) mediaKind = 'audio';
      else mediaKind = 'document';
    } else if (cn.includes('WebPage')) mediaKind = 'webpage';
    else if (cn.includes('Geo') || cn.includes('Location')) mediaKind = 'geo';
    else if (cn.includes('Contact')) mediaKind = 'contact';
    else if (cn.includes('Poll')) mediaKind = 'poll';
    else mediaKind = 'other';
  }

  return {
    id: _toIdNum(msg.id),
    text: msg.message || '',
    out,
    fromId,
    isSelf: ownId != null && fromId === ownId,
    date: _toIsoDate(msg.date),
    editDate: _toIsoDate(msg.editDate),
    replyToMsgId: _toIdNum(msg.replyTo?.replyToMsgId ?? msg.replyToMsgId ?? null),
    fwdFrom: msg.fwdFrom
      ? {
          fromId: _toIdNum(
            msg.fwdFrom.fromId?.userId ?? msg.fwdFrom.fromId?.channelId ??
            msg.fwdFrom.fromId?.chatId ?? null
          ),
          fromName: msg.fwdFrom.fromName || null,
          date: _toIsoDate(msg.fwdFrom.date),
        }
      : null,
    pinned: !!msg.pinned,
    silent: !!msg.silent,
    views: msg.views ?? null,
    mediaKind,
    hasMedia: !!msg.media,
    isService: msg.className === 'MessageService',
    actionType: msg.action?.className || null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

class TelegramClientService {
  /**
   * Sessions the user can launch the client UI for.
   *
   * Returns the same fields as the existing /sessions list but with two
   * additions:
   *   - `isLoginReady`: true if status ∈ {active, uploaded} and the
   *     session string is intact (we don't run a Telegram round-trip
   *     here — connect() is what actually verifies that, lazily on
   *     first open).
   *   - `displayName`: the friendly account label the UI shows on the
   *     "Login" page (account_info.firstName + lastName, falls back to
   *     username, then phone).
   */
  async listLoggableSessions(userId) {
    const result = await pool.query(
      `SELECT id, phone, status, is_logged_in, account_info, last_active, created_at
         FROM sessions
        WHERE user_id = $1 AND platform = 'telegram'
        ORDER BY (status = 'active' AND is_logged_in = TRUE) DESC,
                 last_active DESC NULLS LAST,
                 created_at DESC`,
      [userId]
    );

    const out = [];
    for (const row of result.rows) {
      const info = sessionService._parseJsonField
        ? sessionService._parseJsonField(row.account_info)
        : (typeof row.account_info === 'string'
          ? safeParseJson(row.account_info)
          : (row.account_info || {}));
      const acct = info || {};
      const firstName = acct.firstName || acct.first_name || null;
      const lastName = acct.lastName || acct.last_name || null;
      const username = acct.username || null;
      const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
      const displayName =
        fullName || username || row.phone || `Session #${row.id}`;
      out.push({
        id: row.id,
        phone: row.phone,
        status: row.status,
        isLoggedIn: !!row.is_logged_in,
        displayName,
        firstName,
        lastName,
        username,
        telegramId: acct.telegramId || acct.id || null,
        isPremium: !!acct.isPremium,
        isVerified: !!acct.isVerified,
        isRestricted: !!acct.isRestricted,
        isLoginReady:
          row.status === 'active' || row.status === 'uploaded' || row.status === 'inactive',
        lastActive: row.last_active,
        createdAt: row.created_at,
      });
    }
    return out;
  }

  /**
   * Connect a session (idempotent). Will run the existing
   * sessionService.loginSession path the first time so a freshly-
   * uploaded session goes from `uploaded` → `active` without an extra
   * UI prompt.
   */
  async connect(sessionId, userId) {
    const row = await _loadAndAuthSession(sessionId, userId);

    if (!row.is_logged_in) {
      // Drive the panel's existing login flow, which handles proxy
      // assignment + identity application + flips is_logged_in=TRUE.
      try {
        await sessionService.loginSession(sessionId, userId);
      } catch (err) {
        if (err && err.code === 'SESSION_ALREADY_LOGGED_IN') {
          // race with another window — fine.
        } else {
          throw err;
        }
      }
    } else {
      // Already logged in — make sure the in-memory client is connected.
      await tgService._ensureConnected(sessionId);
    }

    const me = await tgService.getMe(sessionId);
    return {
      sessionId,
      connected: true,
      me,
    };
  }

  /**
   * Quick `getMe` — assumes the client is already connected (tg-client
   * UI calls /connect first).
   */
  async getMe(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    return tgService.getMe(sessionId);
  }

  /**
   * List dialogs (chats/groups/channels) for a session.
   *
   * @param {string|number} sessionId
   * @param {string|number} userId
   * @param {object} [opts]
   * @param {number} [opts.limit]
   */
  async getDialogs(sessionId, userId, opts = {}) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const limit = Math.min(
      Math.max(1, parseInt(opts.limit, 10) || DEFAULT_DIALOGS_LIMIT),
      MAX_DIALOGS_LIMIT
    );

    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const me = await tgService.getMe(sessionId).catch(() => null);
    const ownId = me ? _toIdNum(me.id) : null;

    let dialogs;
    try {
      dialogs = await entry.client.getDialogs({ limit });
    } catch (err) {
      logger.error(`getDialogs failed for session ${sessionId}: ${err.message}`);
      throw new AppError(`Failed to fetch dialogs: ${err.message}`, 502, 'DIALOGS_FETCH_FAILED');
    }

    const items = [];
    for (const d of dialogs || []) {
      const norm = _normalizeDialog(d, ownId);
      if (norm) items.push(norm);
    }

    return {
      total: items.length,
      ownId,
      dialogs: items,
    };
  }

  /**
   * Fetch message history for a (peerType, peerId) pair.
   *
   * @param {string|number} sessionId
   * @param {string|number} userId
   * @param {string} peerType 'user' | 'chat' | 'channel'
   * @param {string|number} peerId
   * @param {object} [opts]
   * @param {number} [opts.limit]
   * @param {number} [opts.offsetId]
   */
  async getMessages(sessionId, userId, peerType, peerId, opts = {}) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);

    const limit = Math.min(
      Math.max(1, parseInt(opts.limit, 10) || DEFAULT_MESSAGES_LIMIT),
      MAX_MESSAGES_LIMIT
    );
    const offsetId = parseInt(opts.offsetId, 10) || 0;

    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const me = await tgService.getMe(sessionId).catch(() => null);
    const ownId = me ? _toIdNum(me.id) : null;

    let entity;
    try {
      entity = await entry.client.getEntity(_buildPeerInput(peerType, peerId));
    } catch (err) {
      logger.warn(`getEntity failed for ${peerType}/${peerId}: ${err.message}`);
      throw new AppError(`Could not resolve peer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    let raw;
    try {
      raw = await entry.client.getMessages(entity, { limit, offsetId });
    } catch (err) {
      logger.error(`getMessages failed for session ${sessionId}: ${err.message}`);
      throw new AppError(`Failed to fetch messages: ${err.message}`, 502, 'MESSAGES_FETCH_FAILED');
    }

    const dialogPeer = entity.id != null
      ? { [peerType + 'Id']: entity.id }
      : null;

    const messages = (raw || [])
      .map((m) => _normalizeMessage(m, ownId, dialogPeer))
      .filter(Boolean);

    // Resolve the unique senders so the UI can render names/avatars
    // without an N+1 round-trip from the browser.
    const seen = new Map();
    for (const m of raw || []) {
      const sender = m.sender || m._sender || null;
      if (!sender) continue;
      const sn = _normalizeSender(sender);
      if (sn) seen.set(`${sn.peerType}:${sn.peerId}`, sn);
    }

    return {
      messages,
      senders: Array.from(seen.values()),
      ownId,
      peer: {
        peerType,
        peerId: _toIdNum(entity.id),
        title: _entityTitle(entity),
        username: entity.username || null,
      },
    };
  }

  /**
   * Send a text message on behalf of `sessionId`.
   *
   * @param {string|number} sessionId
   * @param {string|number} userId
   * @param {string} peerType
   * @param {string|number} peerId
   * @param {object} payload
   * @param {string} payload.text
   * @param {number} [payload.replyToMsgId]
   * @param {boolean} [payload.silent]
   */
  async sendMessage(sessionId, userId, peerType, peerId, payload = {}) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    const text = String(payload.text || '').slice(0, 4096);
    if (!text.trim()) {
      throw new AppError('Message text is required', 400, 'MESSAGE_TEXT_REQUIRED');
    }

    await _loadAndAuthSession(sessionId, userId);

    // Re-use the existing sendMessage path so flood retry, error mapping,
    // and proxy/identity binding all behave identically to the rest of
    // the panel.
    const result = await tgService.sendMessage(sessionId, _buildPeerInput(peerType, peerId), text, {
      replyTo: payload.replyToMsgId || undefined,
      silent: payload.silent === true,
    });

    const messageId = _toIdNum(result.messageId ?? result.id ?? null);
    const date = result.date || new Date().toISOString();
    const peerIdNum = _toIdNum(peerId);

    // Build the same UI-shaped message + chat summary the live-event
    // bridge would produce, then emit `tg-client:dialogUpdate` /
    // `tg-client:newMessage` directly. This matters in two ways:
    //   1. Other windows watching the same session immediately see
    //      the new outgoing message in their dialog list / chat pane
    //      (instead of only the sending window seeing the optimistic
    //      insert).
    //   2. We don't have to rely on GramJS's NewMessage event firing
    //      for the round-tripped outgoing — empirically that handler
    //      can race / drop on flaky proxies and the dialog preview
    //      would be stuck on the previous incoming message.
    const normalizedMessage = {
      id: messageId,
      text,
      out: true,
      fromId: null,
      senderPeerType: null,
      senderPeerId: null,
      date,
      replyToMsgId: payload.replyToMsgId || null,
      hasMedia: false,
      mediaKind: null,
      photoId: null,
      mediaThumb: null,
      mediaFileName: null,
      mediaSizeBytes: null,
      editDate: null,
      pinned: false,
      mentioned: false,
      silent: !!payload.silent,
      action: null,
      actionType: null,
      forwardFrom: null,
    };
    let chatSummary = null;
    let senderSummary = null;
    try {
      const meId = (await this.getMe(sessionId, userId).catch(() => null))?.id;
      if (meId != null) {
        normalizedMessage.fromId = Number(meId);
      }
    } catch (_) { /* ignore */ }
    try {
      const entry = tgService.clients.get(String(sessionId));
      if (entry) {
        const entity = await entry.client.getEntity(_buildPeerInput(peerType, peerIdNum));
        if (entity) {
          chatSummary = {
            peerType: _peerTypeOf(entity) || peerType,
            peerId: _toIdNum(entity.id) ?? peerIdNum,
            title: _entityTitle(entity),
            username: entity.username || null,
            photoId: entity.photo?.photoId ? String(entity.photo.photoId) : null,
            hasPhoto: !!(entity.photo && (entity.photo.photoId || entity.photo.photoSmall)),
          };
        }
        const me = await entry.client.getMe().catch(() => null);
        if (me) {
          senderSummary = {
            peerType: 'user',
            peerId: _toIdNum(me.id),
            title: _entityTitle(me),
            username: me.username || null,
            photoId: me.photo?.photoId ? String(me.photo.photoId) : null,
            hasPhoto: !!(me.photo && (me.photo.photoId || me.photo.photoSmall)),
          };
        }
      }
    } catch (_) { /* best-effort enrichment */ }
    if (!chatSummary) {
      chatSummary = { peerType, peerId: peerIdNum, title: null, username: null, photoId: null, hasPhoto: false };
    }

    const io = global.io;
    if (io) {
      const room = `tg-client:u${userId}:s${sessionId}`;
      try {
        io.to(room).emit('tg-client:newMessage', {
          sessionId: String(sessionId),
          chat: chatSummary,
          sender: senderSummary,
          message: normalizedMessage,
        });
        io.to(room).emit('tg-client:dialogUpdate', {
          sessionId: String(sessionId),
          chat: chatSummary,
          lastMessage: normalizedMessage,
          unreadDelta: 0,
        });
      } catch (err) {
        logger.debug(`tg-client send broadcast failed: ${err.message}`);
      }
    }

    return {
      messageId,
      date,
      peerType,
      peerId: peerIdNum,
      text,
      chat: chatSummary,
      sender: senderSummary,
      message: normalizedMessage,
    };
  }

  /**
   * Send media (photo, video, file, voice, sticker) on behalf of `sessionId`.
   *
   * `payload.filePath` is a path on the panel disk written by the multer
   * middleware. `kind` selects the GramJS attribute set so the receiver
   * sees the file as a "Photo", "Video", "Voice message", "Sticker" or
   * generic document. `progressCallback` is a per-upload reporter that
   * emits `tg-client:uploadProgress` over Socket.IO.
   *
   * @param {string|number} sessionId
   * @param {string|number} userId
   * @param {string} peerType
   * @param {string|number} peerId
   * @param {object} payload
   * @param {'photo'|'video'|'audio'|'voice'|'sticker'|'document'|'auto'} payload.kind
   * @param {string} payload.filePath  absolute path on disk
   * @param {string} [payload.fileName]
   * @param {string} [payload.mimeType]
   * @param {string} [payload.caption]
   * @param {number} [payload.replyToMsgId]
   * @param {boolean} [payload.silent]
   * @param {string} [payload.clientMsgId] caller-supplied id for progress eventing
   * @param {number} [payload.duration] seconds (voice/audio/video)
   * @param {number} [payload.width] pixels (photo/video)
   * @param {number} [payload.height] pixels (photo/video)
   * @param {string} [payload.waveform] base64 voice waveform
   */
  async sendMedia(sessionId, userId, peerType, peerId, payload = {}) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    const filePath = String(payload.filePath || '');
    if (!filePath) {
      throw new AppError('filePath is required', 400, 'FILE_REQUIRED');
    }
    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
      throw new AppError('Uploaded file is missing on disk', 500, 'FILE_NOT_ON_DISK');
    }

    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const peerIdNum = _toIdNum(peerId);
    const kind = String(payload.kind || 'auto').toLowerCase();
    const caption = payload.caption ? String(payload.caption).slice(0, 1024) : '';
    const fileName = payload.fileName || _basename(filePath);
    const mimeType = payload.mimeType || _guessMime(fileName, kind);
    const clientMsgId = payload.clientMsgId || null;
    const replyToMsgId = payload.replyToMsgId
      ? parseInt(payload.replyToMsgId, 10) || undefined
      : undefined;
    const silent = payload.silent === true;

    const sendOpts = {
      file: filePath,
      caption,
      replyTo: replyToMsgId,
      silent,
      forceDocument: kind === 'document',
      voiceNote: kind === 'voice',
      videoNote: kind === 'videonote',
    };

    // Build attribute hints for video/audio/voice/sticker so Telegram
    // renders the message as the correct kind.
    const attributes = _buildAttributes(kind, payload, fileName, mimeType);
    if (attributes.length > 0) sendOpts.attributes = attributes;

    if (kind !== 'photo') {
      sendOpts.fileName = fileName;
    }

    const io = global.io;
    const room = `tg-client:u${userId}:s${sessionId}`;
    const progressEmit = (progress) => {
      if (!io || !clientMsgId) return;
      try {
        io.to(room).emit('tg-client:uploadProgress', {
          sessionId: String(sessionId),
          clientMsgId,
          progress: Math.max(0, Math.min(1, progress || 0)),
          peerType,
          peerId: peerIdNum,
        });
      } catch (err) {
        logger.debug(`tg-client uploadProgress emit failed: ${err.message}`);
      }
    };

    sendOpts.progressCallback = (progress) => {
      // GramJS reports progress as a number in [0,1]. Throttle in caller.
      progressEmit(typeof progress === 'number' ? progress : 0);
    };

    let entity;
    try {
      entity = await entry.client.getEntity(_buildPeerInput(peerType, peerIdNum));
    } catch (err) {
      throw new AppError(`Could not resolve peer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    let sent;
    try {
      progressEmit(0);
      sent = await entry.client.sendFile(entity, sendOpts);
      progressEmit(1);
    } catch (err) {
      logger.warn(`sendFile failed for session ${sessionId}: ${err.message}`);
      throw new AppError(`Failed to send media: ${err.message}`, 502, 'SEND_MEDIA_FAILED');
    } finally {
      // Best-effort cleanup; don't crash the request on permission errors.
      try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    }

    const messageId = _toIdNum(sent?.id ?? null);
    const date = sent?.date ? _toIsoDate(sent.date) : new Date().toISOString();

    const ownId = (await tgService.getMe(sessionId).catch(() => null))?.id;
    const dialogPeer = entity.id != null ? { [`${peerType}Id`]: entity.id } : null;
    const normalized =
      _normalizeMessage(sent, ownId != null ? Number(ownId) : null, dialogPeer) || {
        id: messageId,
        text: caption,
        out: true,
        fromId: ownId != null ? Number(ownId) : null,
        date,
        hasMedia: true,
        mediaKind: kind === 'voice' ? 'voice' : (kind === 'sticker' ? 'sticker' : kind),
      };

    let chatSummary = {
      peerType: _peerTypeOf(entity) || peerType,
      peerId: _toIdNum(entity.id) ?? peerIdNum,
      title: _entityTitle(entity),
      username: entity.username || null,
      photoId: entity.photo?.photoId ? String(entity.photo.photoId) : null,
      hasPhoto: !!(entity.photo && (entity.photo.photoId || entity.photo.photoSmall)),
    };
    let senderSummary = null;
    try {
      const me = await entry.client.getMe();
      if (me) {
        senderSummary = {
          peerType: 'user',
          peerId: _toIdNum(me.id),
          title: _entityTitle(me),
          username: me.username || null,
          photoId: me.photo?.photoId ? String(me.photo.photoId) : null,
          hasPhoto: !!(me.photo && (me.photo.photoId || me.photo.photoSmall)),
        };
      }
    } catch (_) { /* best-effort */ }

    if (io) {
      try {
        io.to(room).emit('tg-client:newMessage', {
          sessionId: String(sessionId),
          chat: chatSummary,
          sender: senderSummary,
          message: normalized,
          clientMsgId,
        });
        io.to(room).emit('tg-client:dialogUpdate', {
          sessionId: String(sessionId),
          chat: chatSummary,
          lastMessage: normalized,
          unreadDelta: 0,
        });
      } catch (err) {
        logger.debug(`tg-client sendMedia broadcast failed: ${err.message}`);
      }
    }

    return {
      messageId,
      date,
      peerType,
      peerId: peerIdNum,
      kind,
      fileName,
      mimeType,
      caption,
      chat: chatSummary,
      sender: senderSummary,
      message: normalized,
      clientMsgId,
    };
  }

  /**
   * Send a voice message. Convenience wrapper around `sendMedia` that
   * pins kind=voice and sets the duration / waveform attributes
   * Telegram clients use to render the voice bubble.
   */
  async sendVoice(sessionId, userId, peerType, peerId, payload = {}) {
    return this.sendMedia(sessionId, userId, peerType, peerId, {
      ...payload,
      kind: 'voice',
      mimeType: payload.mimeType || 'audio/ogg',
    });
  }

  /**
   * Send an existing sticker (sticker set + document id) without
   * re-uploading. Two payload modes:
   *   - re-send a known InputDocument: payload.documentId + accessHash + fileReference
   *   - upload a fresh sticker file from disk: payload.filePath + kind
   */
  async sendSticker(sessionId, userId, peerType, peerId, payload = {}) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    if (payload.filePath) {
      return this.sendMedia(sessionId, userId, peerType, peerId, {
        ...payload,
        kind: 'sticker',
      });
    }

    const docId = payload.documentId;
    const accessHash = payload.accessHash;
    const fileReference = payload.fileReference;
    if (docId == null || accessHash == null || !fileReference) {
      throw new AppError(
        'documentId, accessHash and fileReference are required to re-send a sticker',
        400,
        'STICKER_REF_REQUIRED'
      );
    }

    const peerIdNum = _toIdNum(peerId);
    let entity;
    try {
      entity = await entry.client.getEntity(_buildPeerInput(peerType, peerIdNum));
    } catch (err) {
      throw new AppError(`Could not resolve peer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    let inputDoc;
    try {
      inputDoc = new Api.InputDocument({
        id: _toBigInt(docId),
        accessHash: _toBigInt(accessHash),
        fileReference: _decodeFileRef(fileReference),
      });
    } catch (err) {
      throw new AppError(`Invalid sticker reference: ${err.message}`, 400, 'STICKER_REF_INVALID');
    }

    let sent;
    try {
      sent = await entry.client.invoke(
        new Api.messages.SendMedia({
          peer: entity,
          media: new Api.InputMediaDocument({ id: inputDoc }),
          message: '',
          replyToMsgId: payload.replyToMsgId
            ? parseInt(payload.replyToMsgId, 10) || undefined
            : undefined,
          silent: payload.silent === true,
          randomId: _randomBigInt(),
        })
      );
    } catch (err) {
      logger.warn(`sendSticker invoke failed for session ${sessionId}: ${err.message}`);
      throw new AppError(`Failed to send sticker: ${err.message}`, 502, 'SEND_STICKER_FAILED');
    }

    const message = _extractFirstMessageFromUpdates(sent);
    const ownId = (await tgService.getMe(sessionId).catch(() => null))?.id;
    const dialogPeer = entity.id != null ? { [`${peerType}Id`]: entity.id } : null;
    const normalized = message
      ? _normalizeMessage(message, ownId != null ? Number(ownId) : null, dialogPeer)
      : null;

    const io = global.io;
    if (io && normalized) {
      const room = `tg-client:u${userId}:s${sessionId}`;
      try {
        io.to(room).emit('tg-client:newMessage', {
          sessionId: String(sessionId),
          chat: {
            peerType: _peerTypeOf(entity) || peerType,
            peerId: _toIdNum(entity.id) ?? peerIdNum,
            title: _entityTitle(entity),
            username: entity.username || null,
          },
          sender: null,
          message: normalized,
          clientMsgId: payload.clientMsgId || null,
        });
      } catch (err) {
        logger.debug(`tg-client sendSticker broadcast failed: ${err.message}`);
      }
    }

    return {
      messageId: normalized?.id ?? null,
      date: normalized?.date ?? new Date().toISOString(),
      peerType,
      peerId: peerIdNum,
      message: normalized,
      clientMsgId: payload.clientMsgId || null,
    };
  }

  /**
   * Mark messages up to `maxId` as read for the given peer.
   */
  async markRead(sessionId, userId, peerType, peerId, maxId) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let entity;
    try {
      entity = await entry.client.getEntity(_buildPeerInput(peerType, peerId));
    } catch (err) {
      throw new AppError(`Could not resolve peer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    try {
      await entry.client.markAsRead(entity, parseInt(maxId, 10) || 0, {
        clearMentions: true,
      });
    } catch (err) {
      logger.warn(`markAsRead failed for session ${sessionId}: ${err.message}`);
      // markAsRead failures are not fatal for the UI; surface the message
      // but don't 500.
      throw new AppError(`Failed to mark read: ${err.message}`, 502, 'MARK_READ_FAILED');
    }
    return { ok: true };
  }

  /**
   * Download the profile photo of an entity (user/chat/channel).
   * Returns a Buffer of JPEG bytes, or null when there's no photo.
   */
  async downloadProfilePhoto(sessionId, userId, peerType, peerId, opts = {}) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let entity;
    try {
      entity = await entry.client.getEntity(_buildPeerInput(peerType, peerId));
    } catch (err) {
      throw new AppError(`Could not resolve peer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    if (!entity.photo) return null;

    try {
      const buf = await entry.client.downloadProfilePhoto(entity, {
        isBig: opts.large === true,
      });
      if (!buf) return null;
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    } catch (err) {
      logger.warn(`downloadProfilePhoto failed for ${peerType}/${peerId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Download the media attached to a single message. Supports both the
   * full-resolution download and a thumbnail preview so the UI can lazy
   * load thumbs on scroll without paying for full-resolution fetches.
   *
   * Result is cached in-memory per (sessionId, peerType, peerId,
   * messageId, thumb) for `MEDIA_CACHE_TTL_MS` so the controller can
   * answer Range requests without re-downloading.
   *
   * @param {object} opts
   * @param {boolean} [opts.thumb=false] - when true, only fetch the
   *   smallest available thumbnail (PhotoStrippedSize / video preview).
   * @returns {Promise<null|{buffer, mimeType, fileName, kind, width, height, duration, isThumb}>}
   */
  async downloadMessageMedia(sessionId, userId, peerType, peerId, messageId, opts = {}) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    const thumb = opts.thumb === true;
    const cacheKey = `${sessionId}:${peerType}:${peerId}:${messageId}:${thumb ? 1 : 0}`;
    const cached = _MEDIA_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.t < MEDIA_CACHE_TTL_MS) {
      return cached.v;
    }

    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let entity;
    try {
      entity = await entry.client.getEntity(_buildPeerInput(peerType, peerId));
    } catch (err) {
      throw new AppError(`Could not resolve peer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    let messages;
    try {
      messages = await entry.client.getMessages(entity, {
        ids: [parseInt(messageId, 10)],
      });
    } catch (err) {
      throw new AppError(`Failed to load message: ${err.message}`, 502, 'MESSAGE_FETCH_FAILED');
    }
    const msg = messages && messages[0];
    if (!msg || !msg.media) return null;

    const meta = _extractMediaMeta(msg);
    let buf;
    try {
      if (thumb) {
        buf = await entry.client.downloadMedia(msg, { thumb: 0 });
      } else {
        buf = await entry.client.downloadMedia(msg, {});
      }
    } catch (err) {
      logger.warn(`downloadMedia failed for msg ${messageId} (thumb=${thumb}): ${err.message}`);
      // Fallback: when full download fails for documents, try the thumb
      // anyway so the UI still gets *something*.
      if (!thumb) {
        try { buf = await entry.client.downloadMedia(msg, { thumb: 0 }); } catch (_) { buf = null; }
        if (buf) {
          meta.isThumb = true;
        } else {
          return null;
        }
      } else {
        return null;
      }
    }
    if (!buf) return null;

    const value = {
      buffer: Buffer.isBuffer(buf) ? buf : Buffer.from(buf),
      mimeType: thumb ? 'image/jpeg' : meta.mimeType,
      fileName: meta.fileName,
      kind: meta.kind,
      width: meta.width,
      height: meta.height,
      duration: meta.duration,
      isThumb: thumb || meta.isThumb || false,
      // Used by ETag generation in the controller.
      docId: meta.docId,
    };
    _MEDIA_CACHE.set(cacheKey, { t: Date.now(), v: value });
    if (_MEDIA_CACHE.size > MEDIA_CACHE_MAX_ENTRIES) {
      // Drop the oldest 25% of entries (insertion order = age in v8 maps).
      const drop = Math.floor(MEDIA_CACHE_MAX_ENTRIES / 4);
      let n = 0;
      for (const k of _MEDIA_CACHE.keys()) {
        _MEDIA_CACHE.delete(k);
        n += 1;
        if (n >= drop) break;
      }
    }
    return value;
  }

  /**
   * Edit the text/caption of a message previously sent by `sessionId`.
   * Telegram only allows the sender to edit their own outgoing messages
   * within ~48 hours; on failure (FROZEN_USER_ID, MESSAGE_AUTHOR_REQUIRED,
   * MESSAGE_NOT_MODIFIED, etc.) we surface the GramJS error to the caller.
   *
   * Emits `tg-client:editMessage` on success so other windows / tabs
   * tracking the same session update in place.
   *
   * @param {object} payload
   * @param {number} payload.messageId
   * @param {string} payload.text  new text/caption (cannot be empty)
   */
  async editMessage(sessionId, userId, peerType, peerId, payload = {}) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    const messageId = parseInt(payload.messageId, 10);
    if (!Number.isFinite(messageId)) {
      throw new AppError('messageId is required', 400, 'BAD_MESSAGE_ID');
    }
    const text = (payload.text == null ? '' : String(payload.text));
    if (!text.trim() && payload.allowEmpty !== true) {
      throw new AppError('text cannot be empty', 400, 'EMPTY_TEXT');
    }
    const peerIdNum = _toIdNum(peerId);
    if (peerIdNum == null) {
      throw new AppError('peerId must be numeric', 400, 'BAD_PEER_ID');
    }

    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let entity;
    try {
      entity = await entry.client.getEntity(_buildPeerInput(peerType, peerIdNum));
    } catch (err) {
      throw new AppError(`Could not resolve peer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    let edited;
    try {
      edited = await entry.client.editMessage(entity, {
        message: messageId,
        text,
      });
    } catch (err) {
      throw new AppError(`Failed to edit message: ${err.message}`, 502, 'EDIT_FAILED');
    }

    const editDateRaw = edited?.editDate || edited?.date || Math.floor(Date.now() / 1000);
    const editDate = typeof editDateRaw === 'number'
      ? new Date(editDateRaw * 1000).toISOString()
      : new Date().toISOString();

    const io = global.io;
    if (io) {
      const room = `tg-client:u${userId}:s${sessionId}`;
      try {
        io.to(room).emit('tg-client:editMessage', {
          sessionId: String(sessionId),
          peerType,
          peerId: peerIdNum,
          messageId,
          text,
          editDate,
          message: {
            id: messageId,
            peerType,
            peerId: peerIdNum,
            text,
            editDate,
          },
        });
      } catch (err) {
        logger.debug(`tg-client edit broadcast failed: ${err.message}`);
      }
    }

    return {
      messageId,
      peerType,
      peerId: peerIdNum,
      text,
      editDate,
    };
  }

  /**
   * Delete one or more messages by id. `revoke=true` (default) tells
   * Telegram to also remove the messages on the recipient side where
   * possible.
   *
   * Emits `tg-client:deleteMessages` so other windows update their
   * local message list.
   *
   * @param {object} payload
   * @param {number[]} payload.messageIds
   * @param {boolean} [payload.revoke=true]
   */
  async deleteMessages(sessionId, userId, peerType, peerId, payload = {}) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    const ids = Array.isArray(payload.messageIds) ? payload.messageIds : [];
    const messageIds = ids
      .map((v) => parseInt(v, 10))
      .filter((v) => Number.isFinite(v));
    if (messageIds.length === 0) {
      throw new AppError('messageIds is required', 400, 'BAD_MESSAGE_IDS');
    }
    if (messageIds.length > 100) {
      throw new AppError('At most 100 messages may be deleted at once', 400, 'TOO_MANY_MESSAGES');
    }
    const revoke = payload.revoke !== false;
    const peerIdNum = _toIdNum(peerId);

    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let entity;
    try {
      entity = await entry.client.getEntity(_buildPeerInput(peerType, peerIdNum));
    } catch (err) {
      throw new AppError(`Could not resolve peer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    try {
      await entry.client.deleteMessages(entity, messageIds, { revoke });
    } catch (err) {
      throw new AppError(`Failed to delete messages: ${err.message}`, 502, 'DELETE_FAILED');
    }

    const io = global.io;
    if (io) {
      const room = `tg-client:u${userId}:s${sessionId}`;
      try {
        io.to(room).emit('tg-client:deleteMessages', {
          sessionId: String(sessionId),
          peerType,
          peerId: peerIdNum,
          messageIds,
          revoke,
        });
      } catch (err) {
        logger.debug(`tg-client delete broadcast failed: ${err.message}`);
      }
    }

    return {
      peerType,
      peerId: peerIdNum,
      messageIds,
      revoke,
    };
  }

  /**
   * Forward a list of message ids from one peer to another.
   *
   * Emits `tg-client:newMessage` and `tg-client:dialogUpdate` for the
   * destination peer so the destination window updates instantly.
   *
   * @param {object} payload
   * @param {string} payload.fromPeerType
   * @param {number|string} payload.fromPeerId
   * @param {string} payload.toPeerType
   * @param {number|string} payload.toPeerId
   * @param {number[]} payload.messageIds
   * @param {boolean} [payload.dropAuthor=false] hide the original author header
   * @param {boolean} [payload.silent=false]
   */
  async forwardMessages(sessionId, userId, payload = {}) {
    const ids = Array.isArray(payload.messageIds) ? payload.messageIds : [];
    const messageIds = ids
      .map((v) => parseInt(v, 10))
      .filter((v) => Number.isFinite(v));
    if (messageIds.length === 0) {
      throw new AppError('messageIds is required', 400, 'BAD_MESSAGE_IDS');
    }
    if (messageIds.length > 100) {
      throw new AppError('At most 100 messages may be forwarded at once', 400, 'TOO_MANY_MESSAGES');
    }
    const fromType = payload.fromPeerType;
    const toType = payload.toPeerType;
    if (!PEER_TYPES.has(fromType) || !PEER_TYPES.has(toType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    const fromIdNum = _toIdNum(payload.fromPeerId);
    const toIdNum = _toIdNum(payload.toPeerId);
    if (fromIdNum == null || toIdNum == null) {
      throw new AppError('Both fromPeerId and toPeerId are required', 400, 'BAD_PEER_ID');
    }

    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let fromEntity;
    let toEntity;
    try {
      fromEntity = await entry.client.getEntity(_buildPeerInput(fromType, fromIdNum));
    } catch (err) {
      throw new AppError(`Could not resolve fromPeer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }
    try {
      toEntity = await entry.client.getEntity(_buildPeerInput(toType, toIdNum));
    } catch (err) {
      throw new AppError(`Could not resolve toPeer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    let result;
    try {
      result = await entry.client.forwardMessages(toEntity, {
        messages: messageIds,
        fromPeer: fromEntity,
        silent: !!payload.silent,
        dropAuthor: !!payload.dropAuthor,
      });
    } catch (err) {
      throw new AppError(`Failed to forward messages: ${err.message}`, 502, 'FORWARD_FAILED');
    }

    const ownId = (await this.getMe(sessionId, userId).catch(() => null))?.id;
    const dialogPeer = { peerType: toType, peerId: toIdNum };
    const forwarded = Array.isArray(result) ? result : [];
    const normalized = forwarded
      .map((m) => _normalizeMessage(m, ownId != null ? Number(ownId) : null, dialogPeer))
      .filter(Boolean);

    let chatSummary = null;
    try {
      if (toEntity) {
        chatSummary = {
          peerType: _peerTypeOf(toEntity) || toType,
          peerId: _toIdNum(toEntity.id) ?? toIdNum,
          title: _entityTitle(toEntity),
          username: toEntity.username || null,
          photoId: toEntity.photo?.photoId ? String(toEntity.photo.photoId) : null,
          hasPhoto: !!(toEntity.photo && (toEntity.photo.photoId || toEntity.photo.photoSmall)),
        };
      }
    } catch (_) { /* ignore */ }
    if (!chatSummary) {
      chatSummary = { peerType: toType, peerId: toIdNum, title: null, username: null, photoId: null, hasPhoto: false };
    }

    const io = global.io;
    if (io && normalized.length > 0) {
      const room = `tg-client:u${userId}:s${sessionId}`;
      try {
        const last = normalized[normalized.length - 1];
        for (const m of normalized) {
          io.to(room).emit('tg-client:newMessage', {
            sessionId: String(sessionId),
            chat: chatSummary,
            sender: null,
            message: m,
          });
        }
        io.to(room).emit('tg-client:dialogUpdate', {
          sessionId: String(sessionId),
          chat: chatSummary,
          lastMessage: last,
          unreadDelta: 0,
        });
      } catch (err) {
        logger.debug(`tg-client forward broadcast failed: ${err.message}`);
      }
    }

    return {
      fromPeerType: fromType,
      fromPeerId: fromIdNum,
      toPeerType: toType,
      toPeerId: toIdNum,
      messageIds,
      messages: normalized,
    };
  }

  /**
   * D5 — Get the current account's full profile (firstName, lastName,
   * username, phone, bio/about, photoId, premium flag).
   *
   * The minimal `getMe` already exposes the cheap fields; we additionally
   * call users.getFullUser so we can return the bio + common chats count.
   */
  async getSelfProfile(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let me;
    try {
      me = await entry.client.getMe();
    } catch (err) {
      throw new AppError(`getMe failed: ${err.message}`, 502, 'GETME_FAILED');
    }
    if (!me) throw new AppError('Self entity not available', 500, 'NO_SELF');

    let full;
    try {
      full = await entry.client.invoke(new Api.users.GetFullUser({ id: 'me' }));
    } catch (err) {
      logger.debug(`tg-client getFullUser failed: ${err.message}`);
    }

    const fullUser = full?.fullUser || null;
    return {
      id: _toIdNum(me.id),
      firstName: me.firstName || '',
      lastName: me.lastName || '',
      username: me.username || null,
      usernames: Array.isArray(me.usernames) ? me.usernames.map((u) => ({
        username: u.username,
        active: !!u.active,
        editable: !!u.editable,
      })) : [],
      phone: me.phone || null,
      bio: fullUser?.about || '',
      isPremium: !!me.premium,
      isVerified: !!me.verified,
      isScam: !!me.scam,
      isFake: !!me.fake,
      photoId: me.photo?.photoId ? String(me.photo.photoId) : null,
      hasPhoto: !!(me.photo && (me.photo.photoId || me.photo.photoSmall)),
      commonChatsCount: fullUser?.commonChatsCount || 0,
      langCode: me.langCode || null,
    };
  }

  /**
   * D5 — Update the current account's name and/or bio (account.updateProfile).
   * All fields are optional; passing undefined keeps the current value.
   */
  async updateSelfProfile(sessionId, userId, { firstName, lastName, bio } = {}) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const params = {};
    if (typeof firstName === 'string') params.firstName = firstName.slice(0, 64);
    if (typeof lastName === 'string') params.lastName = lastName.slice(0, 64);
    if (typeof bio === 'string') params.about = bio.slice(0, 70);

    if (Object.keys(params).length === 0) {
      throw new AppError('At least one of firstName / lastName / bio is required', 400, 'NO_FIELDS');
    }

    try {
      await entry.client.invoke(new Api.account.UpdateProfile(params));
    } catch (err) {
      throw new AppError(`updateProfile failed: ${err.message}`, 502, 'UPDATE_PROFILE_FAILED');
    }

    const profile = await this.getSelfProfile(sessionId, userId);
    _broadcastProfileChanged(userId, sessionId, profile);
    return profile;
  }

  /**
   * D5 — Update the public username (account.updateUsername).
   * Pass an empty string to clear it.
   */
  async updateSelfUsername(sessionId, userId, username) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const value = typeof username === 'string' ? username.trim() : '';
    if (value && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)) {
      throw new AppError(
        'Username must be 5-32 chars: a-z, 0-9, _ and start with a letter',
        400,
        'BAD_USERNAME',
      );
    }
    try {
      await entry.client.invoke(new Api.account.UpdateUsername({ username: value }));
    } catch (err) {
      throw new AppError(`updateUsername failed: ${err.message}`, 502, 'UPDATE_USERNAME_FAILED');
    }
    const profile = await this.getSelfProfile(sessionId, userId);
    _broadcastProfileChanged(userId, sessionId, profile);
    return profile;
  }

  /**
   * D5 — Check whether a candidate username is free.
   * Returns { available: boolean }.
   */
  async checkSelfUsername(sessionId, userId, username) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const value = typeof username === 'string' ? username.trim() : '';
    if (!value) return { available: false, reason: 'EMPTY' };
    if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)) {
      return { available: false, reason: 'BAD_FORMAT' };
    }
    try {
      const ok = await entry.client.invoke(new Api.account.CheckUsername({ username: value }));
      return { available: !!ok };
    } catch (err) {
      const msg = (err && err.message) || '';
      if (/USERNAME_INVALID/i.test(msg)) return { available: false, reason: 'INVALID' };
      if (/USERNAME_OCCUPIED/i.test(msg)) return { available: false, reason: 'OCCUPIED' };
      if (/USERNAME_PURCHASE_AVAILABLE/i.test(msg)) return { available: false, reason: 'PURCHASE_ONLY' };
      throw new AppError(`checkUsername failed: ${msg}`, 502, 'CHECK_USERNAME_FAILED');
    }
  }

  /**
   * D5 — Upload a new profile photo (photos.uploadProfilePhoto).
   *
   * `filePath` is a path on the panel disk (multer middleware).
   * Returns the new self profile so the UI can refresh in one round-trip.
   */
  async updateSelfPhoto(sessionId, userId, { filePath, fileName } = {}) {
    if (!filePath) throw new AppError('file is required', 400, 'NO_FILE');
    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
      throw new AppError('Uploaded file is missing on disk', 500, 'FILE_NOT_ON_DISK');
    }
    const { CustomFile } = require('telegram/client/uploads');

    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let inputFile;
    try {
      const stat = fs.statSync(filePath);
      inputFile = await entry.client.uploadFile({
        file: new CustomFile(
          fileName || _basename(filePath) || `photo-${Date.now()}.jpg`,
          stat.size,
          filePath,
        ),
        workers: 4,
      });
    } catch (err) {
      try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
      throw new AppError(`Photo upload failed: ${err.message}`, 502, 'PHOTO_UPLOAD_FAILED');
    }

    try {
      await entry.client.invoke(new Api.photos.UploadProfilePhoto({ file: inputFile }));
    } catch (err) {
      try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
      throw new AppError(`UploadProfilePhoto failed: ${err.message}`, 502, 'UPDATE_PHOTO_FAILED');
    }
    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }

    const profile = await this.getSelfProfile(sessionId, userId);
    _broadcastProfileChanged(userId, sessionId, profile);
    return profile;
  }

  /**
   * D5 — Remove the current profile photo. Falls back to no-op if the
   * account has no photo set.
   */
  async deleteSelfPhoto(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let me;
    try { me = await entry.client.getMe(); } catch (_) { me = null; }
    if (!me?.photo?.photoId) {
      // Nothing to delete — return current profile.
      return this.getSelfProfile(sessionId, userId);
    }
    try {
      await entry.client.invoke(new Api.photos.DeletePhotos({
        id: [new Api.InputPhoto({
          id: me.photo.photoId,
          accessHash: me.photo.photoAccessHash || me.photo.dcId,
          fileReference: me.photo.fileReference || Buffer.alloc(0),
        })],
      }));
    } catch (err) {
      throw new AppError(`DeletePhotos failed: ${err.message}`, 502, 'DELETE_PHOTO_FAILED');
    }
    const profile = await this.getSelfProfile(sessionId, userId);
    _broadcastProfileChanged(userId, sessionId, profile);
    return profile;
  }

  /**
   * D6 — Profile of another user / chat / channel.
   *
   * Returns a normalized object covering the three peer kinds, so the
   * UI can render one drawer regardless of what the user clicked on.
   * Includes notification + block status (account.getNotifySettings,
   * contacts.getBlocked) when the underlying call is supported, since
   * the D6 spec requires "is muted / is blocked" pills next to the bio.
   */
  async getPeerProfile(sessionId, userId, peerType, peerId) {
    if (!['user', 'chat', 'channel'].includes(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const peerIdNum = _toIdNum(peerId);
    if (peerIdNum == null) {
      throw new AppError('Invalid peer id', 400, 'INVALID_PEER_ID');
    }

    let entity;
    try {
      entity = await entry.client.getEntity(_buildPeerInput(peerType, peerIdNum));
    } catch (err) {
      throw new AppError(`getEntity failed: ${err.message}`, 502, 'GETENTITY_FAILED');
    }
    if (!entity) throw new AppError('Peer not found', 404, 'PEER_NOT_FOUND');

    const out = {
      peerType,
      id: peerIdNum,
      title: '',
      firstName: '',
      lastName: '',
      username: null,
      usernames: [],
      phone: null,
      bio: '',
      photoId: null,
      hasPhoto: false,
      participantsCount: null,
      isContact: false,
      isMutualContact: false,
      isBlocked: false,
      isMuted: false,
      isVerified: false,
      isScam: false,
      isFake: false,
      isPremium: false,
      isBot: false,
      isBroadcast: false,
      isMegagroup: false,
      isGigagroup: false,
      isCreator: false,
      isAdmin: false,
      isLeft: false,
      isJoinToSend: false,
      isPublic: false,
      isVerifiedBot: false,
      botInfo: null,
      commonChatsCount: 0,
      langCode: null,
    };

    if (peerType === 'user') {
      out.firstName = entity.firstName || '';
      out.lastName = entity.lastName || '';
      out.title = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
      out.username = entity.username || null;
      out.usernames = Array.isArray(entity.usernames) ? entity.usernames.map((u) => ({
        username: u.username, active: !!u.active, editable: !!u.editable,
      })) : [];
      out.phone = entity.phone || null;
      out.isBot = !!entity.bot;
      out.isVerified = !!entity.verified;
      out.isScam = !!entity.scam;
      out.isFake = !!entity.fake;
      out.isPremium = !!entity.premium;
      out.isContact = !!entity.contact;
      out.isMutualContact = !!entity.mutualContact;
      out.langCode = entity.langCode || null;
      out.hasPhoto = !!(entity.photo && (entity.photo.photoId || entity.photo.photoSmall));
      out.photoId = entity.photo?.photoId ? String(entity.photo.photoId) : null;

      try {
        const full = await entry.client.invoke(new Api.users.GetFullUser({ id: _buildPeerInput('user', peerIdNum) }));
        const fu = full?.fullUser;
        if (fu) {
          out.bio = fu.about || '';
          out.commonChatsCount = fu.commonChatsCount || 0;
          out.isBlocked = !!fu.blocked;
          if (fu.notifySettings && fu.notifySettings.muteUntil) {
            out.isMuted = Number(fu.notifySettings.muteUntil) * 1000 > Date.now();
          }
          if (fu.botInfo) {
            out.botInfo = {
              description: fu.botInfo.description || '',
              commands: Array.isArray(fu.botInfo.commands)
                ? fu.botInfo.commands.map((c) => ({
                    command: c.command,
                    description: c.description,
                  }))
                : [],
            };
          }
        }
      } catch (err) {
        logger.debug(`tg-client GetFullUser failed for ${peerIdNum}: ${err.message}`);
      }
    } else if (peerType === 'chat') {
      out.title = entity.title || '';
      out.participantsCount = entity.participantsCount || 0;
      out.isCreator = !!entity.creator;
      out.isLeft = !!entity.left;
      out.hasPhoto = !!(entity.photo && (entity.photo.photoId || entity.photo.photoSmall));
      out.photoId = entity.photo?.photoId ? String(entity.photo.photoId) : null;
      try {
        const full = await entry.client.invoke(new Api.messages.GetFullChat({ chatId: peerIdNum }));
        const fc = full?.fullChat;
        if (fc) {
          out.bio = fc.about || '';
          out.participantsCount = (fc.participants?.participants?.length) || out.participantsCount;
          if (fc.notifySettings && fc.notifySettings.muteUntil) {
            out.isMuted = Number(fc.notifySettings.muteUntil) * 1000 > Date.now();
          }
        }
      } catch (err) {
        logger.debug(`tg-client GetFullChat failed for ${peerIdNum}: ${err.message}`);
      }
    } else if (peerType === 'channel') {
      out.title = entity.title || '';
      out.username = entity.username || null;
      out.usernames = Array.isArray(entity.usernames) ? entity.usernames.map((u) => ({
        username: u.username, active: !!u.active, editable: !!u.editable,
      })) : [];
      out.isBroadcast = !!entity.broadcast;
      out.isMegagroup = !!entity.megagroup;
      out.isGigagroup = !!entity.gigagroup;
      out.isCreator = !!entity.creator;
      out.isVerified = !!entity.verified;
      out.isScam = !!entity.scam;
      out.isFake = !!entity.fake;
      out.isLeft = !!entity.left;
      out.isJoinToSend = !!entity.joinToSend;
      out.isPublic = !!entity.username || (Array.isArray(entity.usernames) && entity.usernames.some((u) => u.active));
      out.participantsCount = entity.participantsCount || 0;
      out.hasPhoto = !!(entity.photo && (entity.photo.photoId || entity.photo.photoSmall));
      out.photoId = entity.photo?.photoId ? String(entity.photo.photoId) : null;
      try {
        const full = await entry.client.invoke(new Api.channels.GetFullChannel({ channel: _buildPeerInput('channel', peerIdNum) }));
        const fc = full?.fullChat;
        if (fc) {
          out.bio = fc.about || '';
          out.participantsCount = fc.participantsCount || out.participantsCount;
          out.linkedChatId = fc.linkedChatId ? _toIdNum(fc.linkedChatId) : null;
          out.canViewParticipants = !!fc.canViewParticipants;
          out.canSetUsername = !!fc.canSetUsername;
          out.canSetStickers = !!fc.canSetStickers;
          out.slowmodeSeconds = fc.slowmodeSeconds || 0;
          if (fc.notifySettings && fc.notifySettings.muteUntil) {
            out.isMuted = Number(fc.notifySettings.muteUntil) * 1000 > Date.now();
          }
        }
      } catch (err) {
        logger.debug(`tg-client GetFullChannel failed for ${peerIdNum}: ${err.message}`);
      }
    }

    return out;
  }

  /**
   * D6 — Block / unblock a user. The Telegram block list is a flat
   * scalar, so we expose a single setter that takes a boolean.
   */
  async setPeerBlocked(sessionId, userId, peerType, peerId, blocked) {
    if (peerType !== 'user') {
      throw new AppError('Only users can be blocked', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const peerIdNum = _toIdNum(peerId);
    const id = _buildPeerInput('user', peerIdNum);
    try {
      if (blocked) {
        await entry.client.invoke(new Api.contacts.Block({ id }));
      } else {
        await entry.client.invoke(new Api.contacts.Unblock({ id }));
      }
    } catch (err) {
      throw new AppError(`block/unblock failed: ${err.message}`, 502, 'BLOCK_FAILED');
    }
    const profile = await this.getPeerProfile(sessionId, userId, peerType, peerIdNum);
    _broadcastPeerProfileChanged(userId, sessionId, peerType, peerIdNum, profile);
    return profile;
  }

  /**
   * D6 — Mute / unmute a peer (account.updateNotifySettings).
   * `muteUntil` is in seconds; 0 = unmute, 0x7fffffff = mute forever.
   */
  async setPeerMuted(sessionId, userId, peerType, peerId, muted, muteUntilSec) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const peerIdNum = _toIdNum(peerId);
    const peerInput = _buildPeerInput(peerType, peerIdNum);
    let muteUntil = 0;
    if (muted) {
      muteUntil = Number.isFinite(Number(muteUntilSec)) && Number(muteUntilSec) > 0
        ? Math.floor(Number(muteUntilSec))
        : 0x7fffffff;
    }
    try {
      await entry.client.invoke(new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer: peerInput }),
        settings: new Api.InputPeerNotifySettings({
          muteUntil,
        }),
      }));
    } catch (err) {
      throw new AppError(`updateNotifySettings failed: ${err.message}`, 502, 'MUTE_FAILED');
    }
    const profile = await this.getPeerProfile(sessionId, userId, peerType, peerIdNum);
    _broadcastPeerProfileChanged(userId, sessionId, peerType, peerIdNum, profile);
    return profile;
  }

  /**
   * D6 — Common chats with this user (getCommonChats). Returns up to
   * 100 entries (Telegram's hard cap is 100 per page).
   */
  async getCommonChats(sessionId, userId, peerId, { limit = 100 } = {}) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const peerIdNum = _toIdNum(peerId);
    let res;
    try {
      res = await entry.client.invoke(new Api.messages.GetCommonChats({
        userId: _buildPeerInput('user', peerIdNum),
        maxId: 0,
        limit: Math.max(1, Math.min(Number(limit) || 100, 100)),
      }));
    } catch (err) {
      throw new AppError(`getCommonChats failed: ${err.message}`, 502, 'COMMON_CHATS_FAILED');
    }
    const chats = Array.isArray(res?.chats) ? res.chats.map((c) => {
      if (!c) return null;
      const peerType = c.className === 'Channel' || c.className === 'ChannelForbidden' ? 'channel' : 'chat';
      return {
        peerType,
        peerId: _toIdNum(c.id),
        title: c.title || '',
        username: c.username || null,
        participantsCount: c.participantsCount || 0,
        isBroadcast: !!c.broadcast,
        isMegagroup: !!c.megagroup,
        hasPhoto: !!(c.photo && (c.photo.photoId || c.photo.photoSmall)),
      };
    }).filter(Boolean) : [];
    return { chats };
  }

  // -----------------------------------------------------------------------
  // D10 — Group / channel info + admin
  // -----------------------------------------------------------------------

  /**
   * D10 — List participants of a group / channel.
   *
   * Supports filters (`all`, `admins`, `kicked`, `banned`, `bots`,
   * `recent`, `search`) and offset / limit for pagination.
   * Telegram caps `limit` at 200 in a single call.
   */
  async getChatMembers(sessionId, userId, peerType, peerId, opts = {}) {
    if (!['chat', 'channel'].includes(peerType)) {
      throw new AppError('Members are only available for chat / channel', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const peerIdNum = _toIdNum(peerId);
    const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 200));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const search = typeof opts.search === 'string' ? opts.search : '';
    const filterRaw = String(opts.filter || 'recent').toLowerCase();

    let members = [];
    let total = 0;

    if (peerType === 'chat') {
      // Basic groups don't have channels.GetParticipants — pull the
      // full chat and synthesize a participant list.
      try {
        const full = await entry.client.invoke(new Api.messages.GetFullChat({ chatId: peerIdNum }));
        const list = full?.fullChat?.participants?.participants || [];
        const users = full?.users || [];
        const userById = new Map(users.map((u) => [String(_toIdNum(u.id)), u]));
        const ownId = _toIdNum((await entry.client.getMe().catch(() => null))?.id);
        members = list.map((p) => _normalizeParticipantBasic(p, userById, ownId)).filter(Boolean);
        total = members.length;
        if (search) {
          const q = search.toLowerCase();
          members = members.filter((m) => {
            const t = `${m.firstName} ${m.lastName} ${m.username || ''}`.toLowerCase();
            return t.includes(q);
          });
        }
        if (filterRaw === 'admins') members = members.filter((m) => m.isAdmin || m.isCreator);
        if (filterRaw === 'bots') members = members.filter((m) => m.isBot);
        members = members.slice(offset, offset + limit);
      } catch (err) {
        throw new AppError(`GetFullChat failed: ${err.message}`, 502, 'GET_MEMBERS_FAILED');
      }
    } else {
      // Channel / supergroup.
      let filter;
      if (search) {
        filter = new Api.ChannelParticipantsSearch({ q: search });
      } else if (filterRaw === 'admins') {
        filter = new Api.ChannelParticipantsAdmins();
      } else if (filterRaw === 'kicked') {
        filter = new Api.ChannelParticipantsKicked({ q: '' });
      } else if (filterRaw === 'banned') {
        filter = new Api.ChannelParticipantsBanned({ q: '' });
      } else if (filterRaw === 'bots') {
        filter = new Api.ChannelParticipantsBots();
      } else {
        filter = new Api.ChannelParticipantsRecent();
      }

      let res;
      try {
        res = await entry.client.invoke(new Api.channels.GetParticipants({
          channel: _buildPeerInput('channel', peerIdNum),
          filter,
          offset,
          limit,
          hash: 0,
        }));
      } catch (err) {
        throw new AppError(`GetParticipants failed: ${err.message}`, 502, 'GET_MEMBERS_FAILED');
      }
      total = res?.count || 0;
      const users = res?.users || [];
      const userById = new Map(users.map((u) => [String(_toIdNum(u.id)), u]));
      const ownId = _toIdNum((await entry.client.getMe().catch(() => null))?.id);
      members = (res?.participants || []).map((p) => _normalizeChannelParticipant(p, userById, ownId)).filter(Boolean);
    }

    return { peerType, peerId: peerIdNum, total, offset, limit, members };
  }

  /**
   * D10 — Add a user to a chat / channel (messages.AddChatUser / channels.InviteToChannel).
   * `userId` is the Telegram user-id to add.
   */
  async addChatMember(sessionId, userId, peerType, peerId, targetUserId, { fwdLimit = 100 } = {}) {
    if (!['chat', 'channel'].includes(peerType)) {
      throw new AppError('Add member only valid for chat / channel', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const peerIdNum = _toIdNum(peerId);
    const targetIdNum = _toIdNum(targetUserId);
    const userInput = _buildPeerInput('user', targetIdNum);
    try {
      if (peerType === 'chat') {
        await entry.client.invoke(new Api.messages.AddChatUser({
          chatId: peerIdNum,
          userId: userInput,
          fwdLimit: Math.max(0, Math.min(Number(fwdLimit) || 100, 100)),
        }));
      } else {
        await entry.client.invoke(new Api.channels.InviteToChannel({
          channel: _buildPeerInput('channel', peerIdNum),
          users: [userInput],
        }));
      }
    } catch (err) {
      throw new AppError(`Add member failed: ${err.message}`, 502, 'ADD_MEMBER_FAILED');
    }
    _broadcastParticipantUpdate(userId, sessionId, peerType, peerIdNum, {
      action: 'add', userId: targetIdNum,
    });
    return { ok: true };
  }

  /**
   * D10 — Kick or ban a user. For basic chats we use messages.DeleteChatUser;
   * for channels we set ChatBannedRights with viewMessages=true (= banned)
   * or rights={} (= kicked / soft remove).
   */
  async kickChatMember(sessionId, userId, peerType, peerId, targetUserId, { ban = false, untilDate = 0 } = {}) {
    if (!['chat', 'channel'].includes(peerType)) {
      throw new AppError('Kick only valid for chat / channel', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const peerIdNum = _toIdNum(peerId);
    const targetIdNum = _toIdNum(targetUserId);
    const userInput = _buildPeerInput('user', targetIdNum);
    try {
      if (peerType === 'chat') {
        await entry.client.invoke(new Api.messages.DeleteChatUser({
          chatId: peerIdNum,
          userId: userInput,
          revokeHistory: !!ban,
        }));
      } else {
        const rights = new Api.ChatBannedRights({
          untilDate: Number(untilDate) || 0,
          viewMessages: !!ban,
          sendMessages: !!ban,
          sendMedia: !!ban,
          sendStickers: !!ban,
          sendGifs: !!ban,
          sendGames: !!ban,
          sendInline: !!ban,
          embedLinks: !!ban,
        });
        await entry.client.invoke(new Api.channels.EditBanned({
          channel: _buildPeerInput('channel', peerIdNum),
          participant: userInput,
          bannedRights: rights,
        }));
      }
    } catch (err) {
      throw new AppError(`Kick / ban failed: ${err.message}`, 502, 'KICK_FAILED');
    }
    _broadcastParticipantUpdate(userId, sessionId, peerType, peerIdNum, {
      action: ban ? 'ban' : 'kick', userId: targetIdNum,
    });
    return { ok: true };
  }

  /**
   * D10 — Promote / demote a user as admin in a channel / supergroup.
   * `rights` is an object of admin-right flags; pass an empty object to
   * demote. For basic chats we use messages.EditChatAdmin which is a
   * single-bit toggle.
   */
  async setChatAdmin(sessionId, userId, peerType, peerId, targetUserId, { isAdmin, rights, rank = '' } = {}) {
    if (!['chat', 'channel'].includes(peerType)) {
      throw new AppError('Admin set only valid for chat / channel', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const peerIdNum = _toIdNum(peerId);
    const targetIdNum = _toIdNum(targetUserId);
    const userInput = _buildPeerInput('user', targetIdNum);
    try {
      if (peerType === 'chat') {
        await entry.client.invoke(new Api.messages.EditChatAdmin({
          chatId: peerIdNum,
          userId: userInput,
          isAdmin: !!isAdmin,
        }));
      } else {
        const r = rights || {};
        const adminRights = new Api.ChatAdminRights({
          changeInfo:    !!r.changeInfo,
          postMessages:  !!r.postMessages,
          editMessages:  !!r.editMessages,
          deleteMessages:!!r.deleteMessages,
          banUsers:      !!r.banUsers,
          inviteUsers:   !!r.inviteUsers,
          pinMessages:   !!r.pinMessages,
          addAdmins:     !!r.addAdmins,
          anonymous:     !!r.anonymous,
          manageCall:    !!r.manageCall,
          other:         !!r.other,
          manageTopics:  !!r.manageTopics,
        });
        await entry.client.invoke(new Api.channels.EditAdmin({
          channel: _buildPeerInput('channel', peerIdNum),
          userId: userInput,
          adminRights: isAdmin === false ? new Api.ChatAdminRights({}) : adminRights,
          rank: String(rank || '').slice(0, 16),
        }));
      }
    } catch (err) {
      throw new AppError(`Admin update failed: ${err.message}`, 502, 'ADMIN_FAILED');
    }
    _broadcastParticipantUpdate(userId, sessionId, peerType, peerIdNum, {
      action: 'admin', userId: targetIdNum, isAdmin: !!isAdmin,
    });
    return { ok: true };
  }

  /**
   * D10 — Edit chat title.
   */
  async editChatTitle(sessionId, userId, peerType, peerId, title) {
    if (!['chat', 'channel'].includes(peerType)) {
      throw new AppError('Edit only valid for chat / channel', 400, 'INVALID_PEER_TYPE');
    }
    const t = String(title || '').trim();
    if (!t) throw new AppError('title is required', 400, 'NO_TITLE');

    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const peerIdNum = _toIdNum(peerId);
    try {
      if (peerType === 'chat') {
        await entry.client.invoke(new Api.messages.EditChatTitle({
          chatId: peerIdNum,
          title: t.slice(0, 128),
        }));
      } else {
        await entry.client.invoke(new Api.channels.EditTitle({
          channel: _buildPeerInput('channel', peerIdNum),
          title: t.slice(0, 128),
        }));
      }
    } catch (err) {
      throw new AppError(`Edit title failed: ${err.message}`, 502, 'EDIT_TITLE_FAILED');
    }
    const profile = await this.getPeerProfile(sessionId, userId, peerType, peerIdNum);
    _broadcastPeerProfileChanged(userId, sessionId, peerType, peerIdNum, profile);
    return profile;
  }

  /**
   * D10 — Edit chat description / about.
   */
  async editChatAbout(sessionId, userId, peerType, peerId, about) {
    if (peerType !== 'channel' && peerType !== 'chat') {
      throw new AppError('Edit only valid for chat / channel', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const peerIdNum = _toIdNum(peerId);
    const peerInput = _buildPeerInput(peerType, peerIdNum);
    try {
      await entry.client.invoke(new Api.messages.EditChatAbout({
        peer: peerInput,
        about: String(about || '').slice(0, 255),
      }));
    } catch (err) {
      throw new AppError(`Edit about failed: ${err.message}`, 502, 'EDIT_ABOUT_FAILED');
    }
    const profile = await this.getPeerProfile(sessionId, userId, peerType, peerIdNum);
    _broadcastPeerProfileChanged(userId, sessionId, peerType, peerIdNum, profile);
    return profile;
  }

  /**
   * D10 — Edit chat photo (group / channel). `filePath` is the panel
   * disk path produced by the photo multer middleware.
   */
  async editChatPhoto(sessionId, userId, peerType, peerId, { filePath, fileName } = {}) {
    if (!['chat', 'channel'].includes(peerType)) {
      throw new AppError('Edit only valid for chat / channel', 400, 'INVALID_PEER_TYPE');
    }
    if (!filePath) throw new AppError('file is required', 400, 'NO_FILE');
    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
      throw new AppError('Uploaded file is missing on disk', 500, 'FILE_NOT_ON_DISK');
    }
    const { CustomFile } = require('telegram/client/uploads');

    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const peerIdNum = _toIdNum(peerId);
    let inputFile;
    try {
      const stat = fs.statSync(filePath);
      inputFile = await entry.client.uploadFile({
        file: new CustomFile(
          fileName || _basename(filePath) || `photo-${Date.now()}.jpg`,
          stat.size,
          filePath,
        ),
        workers: 4,
      });
    } catch (err) {
      try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
      throw new AppError(`Photo upload failed: ${err.message}`, 502, 'PHOTO_UPLOAD_FAILED');
    }
    try {
      if (peerType === 'chat') {
        await entry.client.invoke(new Api.messages.EditChatPhoto({
          chatId: peerIdNum,
          photo: new Api.InputChatUploadedPhoto({ file: inputFile }),
        }));
      } else {
        await entry.client.invoke(new Api.channels.EditPhoto({
          channel: _buildPeerInput('channel', peerIdNum),
          photo: new Api.InputChatUploadedPhoto({ file: inputFile }),
        }));
      }
    } catch (err) {
      try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
      throw new AppError(`Edit photo failed: ${err.message}`, 502, 'EDIT_PHOTO_FAILED');
    }
    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }

    const profile = await this.getPeerProfile(sessionId, userId, peerType, peerIdNum);
    _broadcastPeerProfileChanged(userId, sessionId, peerType, peerIdNum, profile);
    return profile;
  }

  /**
   * D10 — Leave a chat / channel.
   */
  async leaveChat(sessionId, userId, peerType, peerId) {
    if (!['chat', 'channel'].includes(peerType)) {
      throw new AppError('Leave only valid for chat / channel', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const peerIdNum = _toIdNum(peerId);
    try {
      if (peerType === 'chat') {
        await entry.client.invoke(new Api.messages.DeleteChatUser({
          chatId: peerIdNum,
          userId: _buildPeerInput('user', _toIdNum((await entry.client.getMe()).id)),
          revokeHistory: false,
        }));
      } else {
        await entry.client.invoke(new Api.channels.LeaveChannel({
          channel: _buildPeerInput('channel', peerIdNum),
        }));
      }
    } catch (err) {
      throw new AppError(`Leave failed: ${err.message}`, 502, 'LEAVE_FAILED');
    }
    return { ok: true };
  }

  // -----------------------------------------------------------------------
  // D7 — Settings: notifications, privacy, language
  // -----------------------------------------------------------------------

  /**
   * D7 — Default notification settings for the three peer kinds plus
   * silent-content-types flag. Returns a normalized object the UI can
   * render directly.
   */
  async getDefaultNotifySettings(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const out = {};
    for (const kind of ['users', 'chats', 'broadcasts']) {
      try {
        const r = await entry.client.invoke(new Api.account.GetNotifySettings({
          peer: kind === 'users'
            ? new Api.InputNotifyUsers()
            : kind === 'chats'
            ? new Api.InputNotifyChats()
            : new Api.InputNotifyBroadcasts(),
        }));
        out[kind] = _normalizeNotifySettings(r);
      } catch (err) {
        logger.debug(`tg-client GetNotifySettings(${kind}) failed: ${err.message}`);
        out[kind] = { muteUntil: 0, silent: false, showPreviews: true, sound: null };
      }
    }
    return out;
  }

  /**
   * D7 — Update default notification settings for one peer kind.
   * Body: { muteUntilSec?, silent?, showPreviews?, sound?: '' or string }.
   * Telegram uses InputPeerNotifySettings — fields not passed are kept
   * unchanged.
   */
  async setDefaultNotifySettings(sessionId, userId, kind, payload = {}) {
    if (!['users', 'chats', 'broadcasts'].includes(kind)) {
      throw new AppError('Invalid kind', 400, 'INVALID_KIND');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const settings = {};
    if (typeof payload.silent === 'boolean') settings.silent = payload.silent;
    if (typeof payload.showPreviews === 'boolean') settings.showPreviews = payload.showPreviews;
    if (Number.isFinite(Number(payload.muteUntilSec))) {
      settings.muteUntil = Math.max(0, Math.floor(Number(payload.muteUntilSec)));
    }

    try {
      await entry.client.invoke(new Api.account.UpdateNotifySettings({
        peer: kind === 'users'
          ? new Api.InputNotifyUsers()
          : kind === 'chats'
          ? new Api.InputNotifyChats()
          : new Api.InputNotifyBroadcasts(),
        settings: new Api.InputPeerNotifySettings(settings),
      }));
    } catch (err) {
      throw new AppError(`UpdateNotifySettings failed: ${err.message}`, 502, 'NOTIFY_FAILED');
    }
    return this.getDefaultNotifySettings(sessionId, userId);
  }

  /**
   * D7 — Reset all custom per-peer notification overrides.
   * messages.account.ResetNotifySettings.
   */
  async resetNotifySettings(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    try {
      await entry.client.invoke(new Api.account.ResetNotifySettings());
    } catch (err) {
      throw new AppError(`ResetNotifySettings failed: ${err.message}`, 502, 'RESET_NOTIFY_FAILED');
    }
    return this.getDefaultNotifySettings(sessionId, userId);
  }

  /**
   * D7 — Privacy rules. `key` is one of statusTimestamp, chatInvite,
   * phoneCall, phoneP2P, forwards, profilePhoto, phoneNumber, addedByPhone,
   * voiceMessages. Returns the current rule list as a normalized array.
   */
  async getPrivacy(sessionId, userId, key) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const inputKey = _privacyInputKey(key);
    if (!inputKey) throw new AppError('Invalid privacy key', 400, 'INVALID_PRIVACY_KEY');
    let res;
    try {
      res = await entry.client.invoke(new Api.account.GetPrivacy({ key: inputKey }));
    } catch (err) {
      throw new AppError(`GetPrivacy failed: ${err.message}`, 502, 'GET_PRIVACY_FAILED');
    }
    return { key, rules: (res?.rules || []).map(_normalizePrivacyRule) };
  }

  /**
   * D7 — Update one privacy rule. `value` is the high-level option
   * the UI sends ('everybody' | 'contacts' | 'nobody') plus optional
   * 'allow' / 'disallow' user-id arrays.
   */
  async setPrivacy(sessionId, userId, key, payload = {}) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const inputKey = _privacyInputKey(key);
    if (!inputKey) throw new AppError('Invalid privacy key', 400, 'INVALID_PRIVACY_KEY');

    const rules = [];
    const value = String(payload.value || 'everybody').toLowerCase();
    if (value === 'everybody') rules.push(new Api.InputPrivacyValueAllowAll());
    else if (value === 'nobody') rules.push(new Api.InputPrivacyValueDisallowAll());
    else rules.push(new Api.InputPrivacyValueAllowContacts());

    if (Array.isArray(payload.allowUsers) && payload.allowUsers.length > 0) {
      const users = await Promise.all(payload.allowUsers.map(async (uid) => {
        try { return await entry.client.getInputEntity(_buildPeerInput('user', _toIdNum(uid))); }
        catch (_) { return null; }
      }));
      const valid = users.filter(Boolean);
      if (valid.length > 0) rules.push(new Api.InputPrivacyValueAllowUsers({ users: valid }));
    }
    if (Array.isArray(payload.disallowUsers) && payload.disallowUsers.length > 0) {
      const users = await Promise.all(payload.disallowUsers.map(async (uid) => {
        try { return await entry.client.getInputEntity(_buildPeerInput('user', _toIdNum(uid))); }
        catch (_) { return null; }
      }));
      const valid = users.filter(Boolean);
      if (valid.length > 0) rules.push(new Api.InputPrivacyValueDisallowUsers({ users: valid }));
    }

    let res;
    try {
      res = await entry.client.invoke(new Api.account.SetPrivacy({ key: inputKey, rules }));
    } catch (err) {
      throw new AppError(`SetPrivacy failed: ${err.message}`, 502, 'SET_PRIVACY_FAILED');
    }
    return { key, rules: (res?.rules || []).map(_normalizePrivacyRule) };
  }

  /**
   * D7 — Account language. Telegram stores the active lang per session
   * via the account API; account.UpdateLangPack lets us change it.
   * `langCode` is an ISO short code (e.g. 'en', 'de', 'pt-br').
   */
  async getLanguage(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    try {
      const me = await entry.client.getMe();
      return { langCode: me?.langCode || null };
    } catch (err) {
      throw new AppError(`getLanguage failed: ${err.message}`, 502, 'GET_LANG_FAILED');
    }
  }

  /**
   * D7 — List available languages from the official langpack.
   */
  async listLanguages(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    try {
      const r = await entry.client.invoke(new Api.langpack.GetLanguages({ langPack: 'android' }));
      return {
        languages: (r || []).map((l) => ({
          name: l.name,
          nativeName: l.nativeName,
          langCode: l.langCode,
          baseLangCode: l.baseLangCode || null,
          official: !!l.official,
          rtl: !!l.rtl,
          beta: !!l.beta,
          pluralCode: l.pluralCode || null,
          stringsCount: l.stringsCount || 0,
          translatedCount: l.translatedCount || 0,
          translationsUrl: l.translationsUrl || null,
        })),
      };
    } catch (err) {
      throw new AppError(`listLanguages failed: ${err.message}`, 502, 'LIST_LANG_FAILED');
    }
  }

  // -----------------------------------------------------------------------
  // D8 — Security: 2FA + active sessions
  // -----------------------------------------------------------------------

  /**
   * D8 — Current 2FA state. Returns whether a password is set, the
   * hint, recovery-email status, and (if password is set) the SRP
   * algo metadata the UI needs to skip re-asking for irrelevant fields.
   */
  async get2FAState(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let p;
    try {
      p = await entry.client.invoke(new Api.account.GetPassword());
    } catch (err) {
      throw new AppError(`GetPassword failed: ${err.message}`, 502, 'GET_PASSWORD_FAILED');
    }

    return {
      hasPassword: !!p.hasPassword,
      hint: p.hint || '',
      hasRecovery: !!p.hasRecovery,
      hasSecureValues: !!p.hasSecureValues,
      emailUnconfirmedPattern: p.emailUnconfirmedPattern || '',
      pendingResetDate: p.pendingResetDate || 0,
    };
  }

  /**
   * D8 — Enable 2FA: set a new password (when none was set before).
   * Body: { newPassword, hint?, email? }.
   */
  async enable2FA(sessionId, userId, { newPassword, hint = '', email = '' } = {}) {
    if (!newPassword || String(newPassword).length < 1) {
      throw new AppError('newPassword is required', 400, 'NO_PASSWORD');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const { computeDigest, computeCheck } = require('telegram/Password');

    let p;
    try {
      p = await entry.client.invoke(new Api.account.GetPassword());
    } catch (err) {
      throw new AppError(`GetPassword failed: ${err.message}`, 502, 'GET_PASSWORD_FAILED');
    }
    if (p.hasPassword) {
      throw new AppError('A password is already set; use change instead', 400, 'PASSWORD_ALREADY_SET');
    }
    let passwordHash;
    try {
      passwordHash = await computeDigest(p.newAlgo, String(newPassword));
    } catch (err) {
      throw new AppError(`Password hash failed: ${err.message}`, 500, 'HASH_FAILED');
    }
    const newSettings = new Api.account.PasswordInputSettings({
      newAlgo: p.newAlgo,
      newPasswordHash: passwordHash,
      hint: String(hint || '').slice(0, 128),
      email: String(email || ''),
    });
    try {
      await entry.client.invoke(new Api.account.UpdatePasswordSettings({
        password: await computeCheck(p, ''), // empty since hasPassword=false
        newSettings,
      }));
    } catch (err) {
      throw new AppError(`UpdatePasswordSettings failed: ${err.message}`, 502, 'UPDATE_PASSWORD_FAILED');
    }
    return this.get2FAState(sessionId, userId);
  }

  /**
   * D8 — Disable 2FA: requires current password.
   */
  async disable2FA(sessionId, userId, { currentPassword } = {}) {
    if (!currentPassword) throw new AppError('currentPassword is required', 400, 'NO_PASSWORD');
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const { computeCheck } = require('telegram/Password');
    let p;
    try {
      p = await entry.client.invoke(new Api.account.GetPassword());
    } catch (err) {
      throw new AppError(`GetPassword failed: ${err.message}`, 502, 'GET_PASSWORD_FAILED');
    }
    if (!p.hasPassword) {
      throw new AppError('No password is set', 400, 'NO_PASSWORD_SET');
    }
    let check;
    try {
      check = await computeCheck(p, String(currentPassword));
    } catch (err) {
      throw new AppError(`Password check failed: ${err.message}`, 500, 'CHECK_FAILED');
    }
    try {
      await entry.client.invoke(new Api.account.UpdatePasswordSettings({
        password: check,
        newSettings: new Api.account.PasswordInputSettings({
          newAlgo: new Api.PasswordKdfAlgoUnknown(),
          newPasswordHash: Buffer.alloc(0),
          hint: '',
          email: '',
        }),
      }));
    } catch (err) {
      const m = (err && err.message) || '';
      if (/PASSWORD_HASH_INVALID/i.test(m)) {
        throw new AppError('Current password is incorrect', 400, 'BAD_PASSWORD');
      }
      throw new AppError(`UpdatePasswordSettings failed: ${m}`, 502, 'UPDATE_PASSWORD_FAILED');
    }
    return this.get2FAState(sessionId, userId);
  }

  /**
   * D8 — Change 2FA password: current + new + optional new hint / email.
   */
  async change2FA(sessionId, userId, { currentPassword, newPassword, hint = '', email } = {}) {
    if (!currentPassword) throw new AppError('currentPassword is required', 400, 'NO_PASSWORD');
    if (!newPassword) throw new AppError('newPassword is required', 400, 'NO_NEW_PASSWORD');

    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const { computeCheck, computeDigest } = require('telegram/Password');
    let p;
    try {
      p = await entry.client.invoke(new Api.account.GetPassword());
    } catch (err) {
      throw new AppError(`GetPassword failed: ${err.message}`, 502, 'GET_PASSWORD_FAILED');
    }
    if (!p.hasPassword) throw new AppError('No password is set', 400, 'NO_PASSWORD_SET');

    let check;
    try {
      check = await computeCheck(p, String(currentPassword));
    } catch (err) {
      throw new AppError(`Password check failed: ${err.message}`, 500, 'CHECK_FAILED');
    }

    let newHash;
    try {
      newHash = await computeDigest(p.newAlgo, String(newPassword));
    } catch (err) {
      throw new AppError(`Password hash failed: ${err.message}`, 500, 'HASH_FAILED');
    }
    const settings = {
      newAlgo: p.newAlgo,
      newPasswordHash: newHash,
      hint: String(hint || '').slice(0, 128),
    };
    if (email !== undefined) settings.email = String(email || '');
    try {
      await entry.client.invoke(new Api.account.UpdatePasswordSettings({
        password: check,
        newSettings: new Api.account.PasswordInputSettings(settings),
      }));
    } catch (err) {
      const m = (err && err.message) || '';
      if (/PASSWORD_HASH_INVALID/i.test(m)) {
        throw new AppError('Current password is incorrect', 400, 'BAD_PASSWORD');
      }
      throw new AppError(`UpdatePasswordSettings failed: ${m}`, 502, 'UPDATE_PASSWORD_FAILED');
    }
    return this.get2FAState(sessionId, userId);
  }

  /**
   * D8 — List active authorizations (browser/device sessions).
   */
  async listAuthorizations(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let res;
    try {
      res = await entry.client.invoke(new Api.account.GetAuthorizations());
    } catch (err) {
      throw new AppError(`GetAuthorizations failed: ${err.message}`, 502, 'GET_AUTHS_FAILED');
    }
    return {
      authorizationTtlDays: res?.authorizationTtlDays || 365,
      authorizations: (res?.authorizations || []).map(_normalizeAuthorization),
    };
  }

  /**
   * D8 — Reset (terminate) a single authorization by hash.
   */
  async resetAuthorization(sessionId, userId, hash) {
    if (!hash) throw new AppError('hash is required', 400, 'NO_HASH');
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    try {
      await entry.client.invoke(new Api.account.ResetAuthorization({ hash: String(hash) }));
    } catch (err) {
      const m = (err && err.message) || '';
      if (/FRESH_RESET_AUTHORISATION_FORBIDDEN/i.test(m)) {
        throw new AppError(
          'You can only reset sessions older than 24 hours.',
          400, 'FRESH_RESET_FORBIDDEN',
        );
      }
      throw new AppError(`ResetAuthorization failed: ${m}`, 502, 'RESET_AUTH_FAILED');
    }
    return this.listAuthorizations(sessionId, userId);
  }

  /**
   * D8 — Terminate every other session (keeps the current one).
   */
  async resetOtherAuthorizations(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    try {
      await entry.client.invoke(new Api.auth.ResetAuthorizations());
    } catch (err) {
      throw new AppError(`ResetAuthorizations failed: ${err.message}`, 502, 'RESET_OTHERS_FAILED');
    }
    return this.listAuthorizations(sessionId, userId);
  }

  /**
   * D8 — Update the global authorization TTL (auto-terminate inactive
   * sessions after N days).
   */
  async setAuthorizationTtl(sessionId, userId, days) {
    const d = Math.max(30, Math.min(Number(days) || 365, 366));
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    try {
      await entry.client.invoke(new Api.account.SetAuthorizationTTL({ authorizationTtlDays: d }));
    } catch (err) {
      throw new AppError(`SetAuthorizationTTL failed: ${err.message}`, 502, 'SET_TTL_FAILED');
    }
    return this.listAuthorizations(sessionId, userId);
  }
}

function _normalizeAuthorization(a) {
  if (!a) return null;
  return {
    hash: String(a.hash),
    deviceModel: a.deviceModel || '',
    platform: a.platform || '',
    systemVersion: a.systemVersion || '',
    apiId: a.apiId || 0,
    appName: a.appName || '',
    appVersion: a.appVersion || '',
    dateCreated: a.dateCreated || 0,
    dateActive: a.dateActive || 0,
    ip: a.ip || '',
    country: a.country || '',
    region: a.region || '',
    isCurrent: !!a.current,
    isOfficialApp: !!a.officialApp,
    passwordPending: !!a.passwordPending,
    encryptedRequestsDisabled: !!a.encryptedRequestsDisabled,
    callRequestsDisabled: !!a.callRequestsDisabled,
  };
}

/**
 * Normalize an InputNotify response.
 */
function _normalizeNotifySettings(r) {
  if (!r) return { muteUntil: 0, silent: false, showPreviews: true, sound: null };
  return {
    muteUntil: r.muteUntil || 0,
    silent: !!r.silent,
    showPreviews: r.showPreviews !== false,
    sound: r.sound?.title || r.sound?.fileReference ? '(custom)' : null,
  };
}

function _privacyInputKey(key) {
  switch (key) {
    case 'statusTimestamp': return new Api.InputPrivacyKeyStatusTimestamp();
    case 'chatInvite':      return new Api.InputPrivacyKeyChatInvite();
    case 'phoneCall':       return new Api.InputPrivacyKeyPhoneCall();
    case 'phoneP2P':        return new Api.InputPrivacyKeyPhoneP2P();
    case 'forwards':        return new Api.InputPrivacyKeyForwards();
    case 'profilePhoto':    return new Api.InputPrivacyKeyProfilePhoto();
    case 'phoneNumber':     return new Api.InputPrivacyKeyPhoneNumber();
    case 'addedByPhone':    return new Api.InputPrivacyKeyAddedByPhone();
    case 'voiceMessages':   return new Api.InputPrivacyKeyVoiceMessages();
    default: return null;
  }
}

function _normalizePrivacyRule(r) {
  if (!r) return null;
  return {
    type: r.className,
    users: Array.isArray(r.users) ? r.users.map((u) => _toIdNum(u)).filter((v) => v != null) : undefined,
    chats: Array.isArray(r.chats) ? r.chats.map((c) => _toIdNum(c)).filter((v) => v != null) : undefined,
  };
}

/**
 * Normalize a basic-chat ChatParticipant* type into our wire format.
 */
function _normalizeParticipantBasic(p, userById, ownId) {
  if (!p) return null;
  const uidNum = _toIdNum(p.userId);
  const u = userById.get(String(uidNum));
  const role = p.className === 'ChatParticipantCreator' ? 'creator'
    : p.className === 'ChatParticipantAdmin' ? 'admin'
    : 'member';
  return {
    userId: uidNum,
    role,
    isCreator: role === 'creator',
    isAdmin: role !== 'member',
    isSelf: ownId != null && uidNum === ownId,
    firstName: u?.firstName || '',
    lastName: u?.lastName || '',
    username: u?.username || null,
    isBot: !!u?.bot,
    isPremium: !!u?.premium,
    isVerified: !!u?.verified,
    isDeleted: !!u?.deleted,
    photoId: u?.photo?.photoId ? String(u.photo.photoId) : null,
    hasPhoto: !!(u?.photo && (u.photo.photoId || u.photo.photoSmall)),
    rank: '',
    inviterId: _toIdNum(p.inviterId),
    date: p.date || 0,
    bannedRights: null,
    adminRights: null,
  };
}

/**
 * Normalize a channel participant variant (creator / admin / member /
 * banned / left) into the same wire format as basic chat participants.
 */
function _normalizeChannelParticipant(p, userById, ownId) {
  if (!p) return null;
  const uidNum = _toIdNum(p.userId);
  const u = userById.get(String(uidNum));
  let role = 'member';
  if (p.className === 'ChannelParticipantCreator') role = 'creator';
  else if (p.className === 'ChannelParticipantAdmin') role = 'admin';
  else if (p.className === 'ChannelParticipantBanned') role = 'banned';
  else if (p.className === 'ChannelParticipantLeft') role = 'left';
  return {
    userId: uidNum,
    role,
    isCreator: role === 'creator',
    isAdmin: role === 'admin' || role === 'creator',
    isBanned: role === 'banned',
    isLeft: role === 'left',
    isSelf: ownId != null && uidNum === ownId,
    firstName: u?.firstName || '',
    lastName: u?.lastName || '',
    username: u?.username || null,
    isBot: !!u?.bot,
    isPremium: !!u?.premium,
    isVerified: !!u?.verified,
    isDeleted: !!u?.deleted,
    photoId: u?.photo?.photoId ? String(u.photo.photoId) : null,
    hasPhoto: !!(u?.photo && (u.photo.photoId || u.photo.photoSmall)),
    rank: p.rank || '',
    inviterId: _toIdNum(p.inviterId),
    promotedById: _toIdNum(p.promotedBy),
    kickedById: _toIdNum(p.kickedBy),
    date: p.date || 0,
    adminRights: p.adminRights ? _serializeAdminRights(p.adminRights) : null,
    bannedRights: p.bannedRights ? _serializeBannedRights(p.bannedRights) : null,
  };
}

function _serializeAdminRights(r) {
  if (!r) return null;
  return {
    changeInfo: !!r.changeInfo,
    postMessages: !!r.postMessages,
    editMessages: !!r.editMessages,
    deleteMessages: !!r.deleteMessages,
    banUsers: !!r.banUsers,
    inviteUsers: !!r.inviteUsers,
    pinMessages: !!r.pinMessages,
    addAdmins: !!r.addAdmins,
    anonymous: !!r.anonymous,
    manageCall: !!r.manageCall,
    other: !!r.other,
    manageTopics: !!r.manageTopics,
  };
}

function _serializeBannedRights(r) {
  if (!r) return null;
  return {
    untilDate: r.untilDate || 0,
    viewMessages: !!r.viewMessages,
    sendMessages: !!r.sendMessages,
    sendMedia: !!r.sendMedia,
    sendStickers: !!r.sendStickers,
    sendGifs: !!r.sendGifs,
    sendGames: !!r.sendGames,
    sendInline: !!r.sendInline,
    embedLinks: !!r.embedLinks,
  };
}

/**
 * Broadcast a participant change so the open members panel can refresh.
 */
function _broadcastParticipantUpdate(userId, sessionId, peerType, peerId, payload) {
  try {
    const io = global.io;
    if (!io) return;
    io.to(`tg-client:u${userId}:s${sessionId}`).emit('tg-client:participantUpdate', {
      sessionId: String(sessionId),
      peerType,
      peerId,
      ...payload,
    });
  } catch (err) {
    logger.debug(`tg-client participant broadcast failed: ${err.message}`);
  }
}

/**
 * Broadcast a peer profile mutation (block / mute) so other windows
 * sharing this session refresh their open drawer.
 */
function _broadcastPeerProfileChanged(userId, sessionId, peerType, peerId, profile) {
  try {
    const io = global.io;
    if (!io) return;
    io.to(`tg-client:u${userId}:s${sessionId}`).emit('tg-client:profileChanged', {
      sessionId: String(sessionId),
      kind: 'peer',
      peerType,
      peerId,
      profile: { ...profile, peerType },
    });
  } catch (err) {
    logger.debug(`tg-client peer profile broadcast failed: ${err.message}`);
  }
}

/**
 * Broadcast a profile mutation back to every window tracking this
 * session. Other places (D6 / D10) reuse the same event so peer-side
 * caches can refresh without a full re-poll.
 */
function _broadcastProfileChanged(userId, sessionId, profile) {
  try {
    const io = global.io;
    if (!io) return;
    io.to(`tg-client:u${userId}:s${sessionId}`).emit('tg-client:profileChanged', {
      sessionId: String(sessionId),
      kind: 'self',
      profile,
    });
  } catch (err) {
    logger.debug(`tg-client profile broadcast failed: ${err.message}`);
  }
}

const _MEDIA_CACHE = new Map();
const MEDIA_CACHE_TTL_MS = 5 * 60 * 1000;
const MEDIA_CACHE_MAX_ENTRIES = 256;

function _extractMediaMeta(msg) {
  const out = {
    kind: 'document',
    mimeType: 'application/octet-stream',
    fileName: `media-${msg.id || 'msg'}`,
    width: null,
    height: null,
    duration: null,
    isThumb: false,
    docId: null,
  };
  const m = msg.media;
  if (!m) return out;
  if (m.className?.includes('Photo') || (m.photo && !m.document)) {
    out.kind = 'photo';
    out.mimeType = 'image/jpeg';
    out.fileName = `photo-${msg.id}.jpg`;
    if (m.photo) {
      out.docId = m.photo.id ? String(m.photo.id) : null;
      const sizes = (m.photo.sizes || []).filter((s) => s.w && s.h);
      const largest = sizes.sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
      if (largest) {
        out.width = largest.w;
        out.height = largest.h;
      }
    }
    return out;
  }
  if (m.document) {
    const doc = m.document;
    out.docId = doc.id ? String(doc.id) : null;
    out.mimeType = doc.mimeType || out.mimeType;
    const attrs = doc.attributes || [];
    const fnAttr = attrs.find((a) => a.className === 'DocumentAttributeFilename');
    if (fnAttr?.fileName) out.fileName = fnAttr.fileName;
    const videoAttr = attrs.find((a) => a.className === 'DocumentAttributeVideo');
    const audioAttr = attrs.find((a) => a.className === 'DocumentAttributeAudio');
    const stickerAttr = attrs.find((a) => a.className === 'DocumentAttributeSticker');
    if (stickerAttr) {
      out.kind = 'sticker';
    } else if (audioAttr) {
      out.kind = audioAttr.voice ? 'voice' : 'audio';
      out.duration = audioAttr.duration || null;
    } else if (videoAttr) {
      out.kind = videoAttr.roundMessage ? 'videoNote' : 'video';
      out.width = videoAttr.w || null;
      out.height = videoAttr.h || null;
      out.duration = videoAttr.duration || null;
    } else if ((doc.mimeType || '').startsWith('image/')) {
      out.kind = 'photo';
    } else {
      out.kind = 'document';
    }
    return out;
  }
  return out;
}

/**
 * Build a GramJS peer input from a (peerType, peerId) pair.
 *
 * GramJS resolves a numeric id via `getEntity` against its peer cache;
 * for peers it has never seen we return `peerId` as a string so GramJS
 * tries the resolveUsername / inputPeerSelf fallbacks. For known
 * peers an explicit `Api.PeerUser/Chat/Channel` is the cheapest input.
 */
function _buildPeerInput(peerType, peerId) {
  const idNum = _toIdNum(peerId);
  if (idNum == null) return peerId;
  if (peerType === 'user') return new Api.PeerUser({ userId: idNum });
  if (peerType === 'chat') return new Api.PeerChat({ chatId: idNum });
  if (peerType === 'channel') return new Api.PeerChannel({ channelId: idNum });
  return peerId;
}

function safeParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function _basename(p) {
  if (!p) return 'file';
  const i1 = p.lastIndexOf('/');
  const i2 = p.lastIndexOf('\\');
  const i = Math.max(i1, i2);
  return i === -1 ? p : p.slice(i + 1);
}

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.txt': 'text/plain', '.csv': 'text/csv',
  '.tgs': 'application/x-tgsticker', '.webm-stick': 'video/webm',
};

function _guessMime(fileName, kind) {
  const lower = String(fileName || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot !== -1) {
    const ext = lower.slice(dot);
    if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  }
  switch (kind) {
    case 'photo':   return 'image/jpeg';
    case 'video':   return 'video/mp4';
    case 'audio':   return 'audio/mpeg';
    case 'voice':   return 'audio/ogg';
    case 'sticker': return 'image/webp';
    default:        return 'application/octet-stream';
  }
}

function _buildAttributes(kind, payload, fileName, mimeType) {
  const attrs = [];
  const dur = parseInt(payload.duration, 10);
  const w = parseInt(payload.width, 10);
  const h = parseInt(payload.height, 10);
  if (kind === 'voice') {
    let waveform;
    if (payload.waveform) {
      try { waveform = Buffer.from(String(payload.waveform), 'base64'); } catch (_) { /* ignore */ }
    }
    attrs.push(new Api.DocumentAttributeAudio({
      duration: Number.isFinite(dur) ? dur : 0,
      voice: true,
      waveform,
    }));
    attrs.push(new Api.DocumentAttributeFilename({ fileName: fileName || 'voice.ogg' }));
  } else if (kind === 'audio') {
    attrs.push(new Api.DocumentAttributeAudio({
      duration: Number.isFinite(dur) ? dur : 0,
      voice: false,
      title: payload.title || undefined,
      performer: payload.performer || undefined,
    }));
    attrs.push(new Api.DocumentAttributeFilename({ fileName }));
  } else if (kind === 'video') {
    attrs.push(new Api.DocumentAttributeVideo({
      duration: Number.isFinite(dur) ? dur : 0,
      w: Number.isFinite(w) ? w : 0,
      h: Number.isFinite(h) ? h : 0,
      supportsStreaming: true,
    }));
    attrs.push(new Api.DocumentAttributeFilename({ fileName }));
  } else if (kind === 'sticker') {
    if (mimeType === 'application/x-tgsticker') {
      attrs.push(new Api.DocumentAttributeSticker({
        alt: payload.alt || '',
        stickerset: new Api.InputStickerSetEmpty(),
      }));
    }
    attrs.push(new Api.DocumentAttributeFilename({ fileName }));
  } else if (kind === 'document') {
    attrs.push(new Api.DocumentAttributeFilename({ fileName }));
  }
  return attrs;
}

function _toBigInt(v) {
  if (v == null) return BigInt(0);
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return BigInt(Math.trunc(v));
    return BigInt(String(v));
  } catch {
    return BigInt(0);
  }
}

function _decodeFileRef(ref) {
  if (!ref) return Buffer.alloc(0);
  if (Buffer.isBuffer(ref)) return ref;
  if (typeof ref === 'string') {
    // Accept hex or base64.
    if (/^[0-9a-fA-F]+$/.test(ref) && ref.length % 2 === 0) {
      return Buffer.from(ref, 'hex');
    }
    return Buffer.from(ref, 'base64');
  }
  if (Array.isArray(ref)) return Buffer.from(ref);
  return Buffer.alloc(0);
}

function _randomBigInt() {
  // GramJS expects a 64-bit signed random id for SendMedia/SendMessage.
  const buf = require('crypto').randomBytes(8);
  return BigInt.asIntN(64, BigInt(`0x${buf.toString('hex')}`));
}

/**
 * GramJS messages.SendMedia returns an Updates container. The new
 * message lives inside `updates[].message` for `UpdateNewMessage`,
 * `UpdateNewChannelMessage`, or top-level `update.message`. Pull the
 * first one we find.
 */
function _extractFirstMessageFromUpdates(result) {
  if (!result) return null;
  if (result.message && typeof result.message === 'object') return result.message;
  const list = result.updates || [];
  for (const u of list) {
    if (u && u.message) return u.message;
  }
  return null;
}

module.exports = new TelegramClientService();
module.exports._normalizeMessage = _normalizeMessage;
module.exports._normalizeSender = _normalizeSender;
module.exports._normalizeDialog = _normalizeDialog;
module.exports._toIdNum = _toIdNum;
module.exports._peerTypeOf = _peerTypeOf;
module.exports._entityTitle = _entityTitle;
