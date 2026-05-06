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

    return {
      messageId: _toIdNum(result.messageId ?? result.id ?? null),
      date: result.date || new Date().toISOString(),
      peerType,
      peerId: _toIdNum(peerId),
      text,
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
   * Download the media attached to a single message (best-effort —
   * photos and small documents only). Returns `{ buffer, mimeType, fileName }`
   * or null on miss.
   */
  async downloadMessageMedia(sessionId, userId, peerType, peerId, messageId) {
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

    let buf;
    try {
      buf = await entry.client.downloadMedia(msg, {});
    } catch (err) {
      logger.warn(`downloadMedia failed for msg ${messageId}: ${err.message}`);
      return null;
    }
    if (!buf) return null;

    let mimeType = 'application/octet-stream';
    let fileName = `media-${messageId}`;
    if (msg.media.className?.includes('Photo')) {
      mimeType = 'image/jpeg';
      fileName = `photo-${messageId}.jpg`;
    } else if (msg.media.document) {
      mimeType = msg.media.document.mimeType || mimeType;
      const fnAttr = (msg.media.document.attributes || []).find(
        (a) => a.className === 'DocumentAttributeFilename'
      );
      if (fnAttr && fnAttr.fileName) fileName = fnAttr.fileName;
    }

    return {
      buffer: Buffer.isBuffer(buf) ? buf : Buffer.from(buf),
      mimeType,
      fileName,
    };
  }
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

module.exports = new TelegramClientService();
module.exports._normalizeMessage = _normalizeMessage;
module.exports._normalizeSender = _normalizeSender;
module.exports._normalizeDialog = _normalizeDialog;
module.exports._toIdNum = _toIdNum;
module.exports._peerTypeOf = _peerTypeOf;
module.exports._entityTitle = _entityTitle;
