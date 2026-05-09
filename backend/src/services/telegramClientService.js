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
 * Extract the FLOOD_WAIT seconds value from a GramJS error, or null
 * when the error isn't a flood-wait. GramJS surfaces FLOOD_WAIT in
 * a few shapes depending on the entrypoint, so we cover all of them.
 */
function _floodWaitSeconds(err) {
  if (!err) return null;
  if (typeof err.seconds === 'number' && err.seconds >= 0) return err.seconds;
  const tag = err.errorMessage || err.message || '';
  const m = String(tag).match(/FLOOD[_ ]?WAIT[_ ]?(\d+)/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

/**
 * Run `fn`. If Telegram answers with FLOOD_WAIT_X for X ≤ 120 seconds,
 * sleep X+1 seconds and retry once. Larger waits are surfaced
 * unchanged so the caller can fail the dialog and move on instead of
 * blocking the whole job for minutes.
 */
async function _withFloodRetry(fn, opts = {}) {
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : 1;
  const maxFloodSeconds = opts.maxFloodSeconds != null ? opts.maxFloodSeconds : 120;
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const wait = _floodWaitSeconds(err);
      if (wait != null && wait <= maxFloodSeconds && attempt < maxRetries) {
        logger.debug(`FLOOD_WAIT_${wait}s — sleeping then retrying`);
        await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

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
    // Preserve full int64 precision: real access_hashes routinely
    // exceed 2^53 and Number-coercion would silently corrupt them,
    // breaking any later InputUser/InputPeer construction by the UI.
    accessHash: entity.accessHash != null ? String(entity.accessHash) : null,
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
    draft: _normalizeDraft(dialog.draft),
  };
}

/**
 * Normalize a GramJS DraftMessage / DraftMessageEmpty.
 *
 * Returns null for empty drafts so the UI can use truthiness to decide
 * whether to render the "Draft: …" preview.
 */
function _normalizeDraft(draft) {
  if (!draft) return null;
  if (draft.className === 'DraftMessageEmpty') return null;
  const text = String(draft.message || '').trim();
  if (!text && !draft.media) return null;
  return {
    text: draft.message || '',
    date: _toIsoDate(draft.date),
    replyToMsgId: _toIdNum(
      draft.replyTo?.replyToMsgId ?? draft.replyToMsgId ?? null
    ),
    noWebpage: !!draft.noWebpage,
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

    // The "open in another window" UI calls /connect first to verify
    // the underlying GramJS client is alive AND grab the user's
    // identity for the title bar. `getMe` already retries internally
    // on TypeNotFoundError (a known GramJS-versus-newer-Telegram-TL
    // mismatch coming from concurrent update streams), but if it
    // ultimately fails we'd rather hand the UI a cached identity
    // (we already saved telegramId / username / firstName during
    // login) than 500 the entire window. The MTProto socket itself
    // is up; only the response parser choked on an unrelated update.
    let me;
    try {
      me = await tgService.getMe(sessionId);
    } catch (err) {
      const msg = String(err && err.message || err);

      // 1) Permanent auth errors (AUTH_KEY_UNREGISTERED, SESSION_REVOKED,
      //    etc.) mean Telegram has invalidated this session out-of-band
      //    — usually because the user terminated it from another
      //    device. Without this branch the controller surfaces the
      //    raw GramJS message as a 500 INTERNAL_ERROR, which is what
      //    operators were hitting when they "couldn't login active
      //    sessions" from the panel. Mark the row revoked so the
      //    sessions list updates immediately, then return a clean
      //    401 the UI can render as "session needs re-upload".
      if (tgService.isPermanentAuthError(err)) {
        try {
          const accountInfoForUpdate =
            (row.account_info && typeof row.account_info === 'object')
              ? { ...row.account_info }
              : (() => {
                  try {
                    return row.account_info ? JSON.parse(row.account_info) : {};
                  } catch {
                    return {};
                  }
                })();
          accountInfoForUpdate.lastError = msg;
          accountInfoForUpdate.lastErrorAt = new Date().toISOString();
          accountInfoForUpdate.revokedAt =
            accountInfoForUpdate.revokedAt || new Date().toISOString();
          await pool.query(
            `UPDATE sessions
                SET is_logged_in = FALSE,
                    status       = 'revoked',
                    account_info = $2,
                    updated_at   = NOW()
              WHERE id = $1`,
            [sessionId, JSON.stringify(accountInfoForUpdate)]
          );
          logger.warn(
            `connect(${sessionId}): permanent auth error from getMe; flagged session revoked in DB: ${msg}`,
            { userId }
          );
        } catch (markErr) {
          logger.warn(
            `connect(${sessionId}): could not flag session revoked: ${markErr.message}`,
            { userId }
          );
        }
        throw new AppError(
          'This session has been revoked remotely (auth key invalidated). Please re-upload or re-login it.',
          401,
          'SESSION_REVOKED_REMOTELY'
        );
      }

      // 2) GramJS-versus-newer-Telegram-TL parser mismatch — recoverable
      //    via the cached identity we stored at login time.
      const isParseRecvError =
        (err && err.name === 'TypeNotFoundError') ||
        msg.includes('Could not find a matching Constructor ID') ||
        msg.includes('matching Constructor ID for the TLObject');

      if (!isParseRecvError) throw err;

      const cached = (row.account_info && typeof row.account_info === 'object')
        ? row.account_info
        : (() => {
            try {
              return row.account_info ? JSON.parse(row.account_info) : null;
            } catch {
              return null;
            }
          })();

      if (cached && (cached.telegramId || cached.username || cached.firstName)) {
        logger.warn(
          `connect(${sessionId}): getMe TLObject parse error; serving cached identity from account_info so the UI window can still open: ${msg}`
        );
        me = {
          id: cached.telegramId || null,
          username: cached.username || null,
          firstName: cached.firstName || null,
          lastName: cached.lastName || null,
          phone: cached.phone || row.phone || null,
          isPremium: cached.isPremium || false,
          isVerified: cached.isVerified || false,
          _cached: true,
        };
      } else {
        // No cached identity — surface the original error.
        throw err;
      }
    }

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
   * Download a sticker / GIF / saved-document by (id, accessHash,
   * fileReference). Used by the in-panel emoji/sticker/GIF picker.
   *
   * Uses the same per-session cache as message media so a sticker
   * thumb fetched in the picker is reused when the same sticker is
   * received in a chat.
   */
  async downloadDocumentMedia(sessionId, userId, documentId, accessHash, fileReference, opts = {}) {
    const thumb = opts.thumb === true;
    if (documentId == null || accessHash == null || !fileReference) {
      throw new AppError(
        'documentId, accessHash and fileReference are required',
        400,
        'DOC_REF_REQUIRED'
      );
    }
    const cacheKey = `doc:${sessionId}:${documentId}:${thumb ? 1 : 0}`;
    const cached = _MEDIA_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.t < MEDIA_CACHE_TTL_MS) {
      return cached.v;
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let inputDoc;
    try {
      inputDoc = new Api.InputDocument({
        id: _toBigInt(documentId),
        accessHash: _toBigInt(accessHash),
        fileReference: _decodeFileRef(fileReference),
      });
    } catch (err) {
      throw new AppError(`Invalid document reference: ${err.message}`, 400, 'DOC_REF_INVALID');
    }

    let buf = null;
    try {
      if (thumb) {
        // Fetch the smallest preview (gif/sticker thumbnails are
        // already tiny — telegram serves an embedded thumb on the
        // message wrapper). For raw documents we ask for thumb 'm'.
        buf = await entry.client.downloadFile(
          new Api.InputDocumentFileLocation({
            id: inputDoc.id,
            accessHash: inputDoc.accessHash,
            fileReference: inputDoc.fileReference,
            thumbSize: 'm',
          }),
          { dcId: undefined, fileSize: undefined, partSizeKb: 64 }
        );
      } else {
        buf = await entry.client.downloadFile(
          new Api.InputDocumentFileLocation({
            id: inputDoc.id,
            accessHash: inputDoc.accessHash,
            fileReference: inputDoc.fileReference,
            thumbSize: '',
          }),
          { dcId: undefined, fileSize: undefined }
        );
      }
    } catch (err) {
      logger.warn(`downloadDocumentMedia failed for doc ${documentId} (thumb=${thumb}): ${err.message}`);
      // Try the alternate thumbSize as a fallback.
      try {
        buf = await entry.client.downloadFile(
          new Api.InputDocumentFileLocation({
            id: inputDoc.id,
            accessHash: inputDoc.accessHash,
            fileReference: inputDoc.fileReference,
            thumbSize: thumb ? '' : 'm',
          }),
          {}
        );
      } catch (_) { buf = null; }
    }
    if (!buf || (buf.length != null && buf.length === 0)) return null;

    const value = {
      buffer: Buffer.isBuffer(buf) ? buf : Buffer.from(buf),
      mimeType: thumb ? 'image/jpeg' : 'application/octet-stream',
      fileName: `doc-${documentId}`,
      kind: 'document',
      width: null,
      height: null,
      duration: null,
      isThumb: !!thumb,
      docId: String(documentId),
    };
    _MEDIA_CACHE.set(cacheKey, { t: Date.now(), v: value });
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
   * Wipe a session: clear the message history of every dialog and, for
   * groups / channels, leave (or delete, if the account is the creator)
   * so the dialog itself is removed from the account's chat list.
   *
   * Used by the "Delete chats" action on the Telegram Login page so a
   * user can clean a session without opening each dialog one by one.
   *
   * Per-peer flow:
   *   - user (private chat): messages.DeleteHistory(peer, max_id=0,
   *     just_clear=!revoke, revoke). revoke=true also removes the
   *     dialog from the caller's list and deletes for the other side.
   *   - chat (basic group): messages.DeleteHistory clears messages,
   *     then the account leaves via messages.DeleteChatUser(self,
   *     revoke_history=revoke). When revoke=true and the account is
   *     the creator, messages.DeleteChat is attempted first to delete
   *     the whole group for everyone; if Telegram rejects it
   *     (typically `CHAT_ADMIN_REQUIRED`) we fall back to leaving.
   *   - channel / megagroup: channels.DeleteHistory clears messages,
   *     then the account leaves via channels.LeaveChannel. When
   *     revoke=true we first try channels.DeleteChannel (creator
   *     only); on rejection we fall back to LeaveChannel.
   *
   * Per-peer failures never abort the run — they are recorded and the
   * loop keeps going. The history-clear step is best-effort: a failure
   * there (e.g. CHAT_ADMIN_REQUIRED on a non-admin channel) is not
   * fatal, the leave/delete step still runs so the dialog disappears.
   *
   * Dialogs run through a bounded Promise pool (default concurrency 8)
   * so 100s of dialogs finish in seconds rather than minutes. Each
   * GramJS invoke is wrapped in a FLOOD_WAIT-aware retry: when Telegram
   * tells us to back off for ≤ `maxFloodSeconds`, we sleep and retry
   * once instead of failing the dialog.
   *
   * `opts.onProgress(event)` is called with one of:
   *   - { type: 'connecting' }
   *   - { type: 'scanning', dialogsSoFar }
   *   - { type: 'started', total }
   *   - { type: 'progress', total, done, peerType, peerId, title, ok,
   *       action, cleared, left, deleted, error, code }
   *   - { type: 'finished', total, succeeded, failed }
   * It is the only mechanism the caller has to receive per-peer state
   * during the run; the controller uses it to feed the in-memory job.
   *
   * @param {string|number} sessionId
   * @param {string|number} userId
   * @param {object} [opts]
   * @param {boolean} [opts.revoke=false] true = delete from both sides /
   *   try to fully delete groups & channels where allowed
   * @param {number} [opts.concurrency=8] in-flight dialog calls per
   *   session (clamped to [1, 16])
   * @param {string} [opts.jobId] echoed onto socket events so the
   *   History tab can correlate emits with its job id
   * @param {(event: object) => void} [opts.onProgress] callback invoked
   *   with per-peer + lifecycle events (see above)
   * @param {AbortSignal} [opts.signal] aborts the run between
   *   dialogs / before pre-flight; surfaces as `CANCELLED` errors
   * @param {number} [opts.connectTimeoutMs=10000] hard cap for the
   *   pre-flight connect + getMe race
   * @param {number} [opts.scanTimeoutMs=120000] hard cap for the
   *   total dialog-scan loop
   */
  async deleteAllChatsHistory(sessionId, userId, opts = {}) {
    const revoke = !!opts.revoke;
    const concurrency = Math.max(
      1,
      Math.min(16, parseInt(opts.concurrency, 10) || 8),
    );
    const jobId = opts.jobId || null;
    const signal = opts.signal && typeof opts.signal === 'object' ? opts.signal : null;
    const connectTimeoutMs = Number.isFinite(opts.connectTimeoutMs) && opts.connectTimeoutMs > 0
      ? opts.connectTimeoutMs
      : 10_000;
    const scanTimeoutMs = Number.isFinite(opts.scanTimeoutMs) && opts.scanTimeoutMs > 0
      ? opts.scanTimeoutMs
      : 120_000;
    const onProgress =
      typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const _emitProgress = (ev) => {
      if (!onProgress) return;
      try { onProgress(ev); } catch (err) {
        logger.debug(`clearChats onProgress threw: ${err.message}`);
      }
    };

    const _throwIfAborted = () => {
      if (signal && signal.aborted) {
        const reason = (signal.reason && (signal.reason.message || String(signal.reason)))
          || 'Cancelled';
        const err = new AppError(reason, 499, 'CANCELLED');
        err.cancelled = true;
        throw err;
      }
    };

    const _withTimeoutAndAbort = (promise, ms, label) => {
      let timer = null;
      const timeoutP = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new AppError(`Operation timed out (${label})`, 504, `TIMEOUT_${label}`);
          err.isTimeout = true;
          reject(err);
        }, ms);
      });
      const abortP = signal
        ? new Promise((_, reject) => {
            const onAbort = () => {
              const reason = (signal.reason && (signal.reason.message || String(signal.reason)))
                || 'Cancelled';
              const err = new AppError(reason, 499, 'CANCELLED');
              err.cancelled = true;
              reject(err);
            };
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
          })
        : null;
      const racers = abortP ? [promise, timeoutP, abortP] : [promise, timeoutP];
      return Promise.race(racers).finally(() => {
        if (timer) clearTimeout(timer);
      });
    };

    _throwIfAborted();

    // ---- Pre-flight: load + connect ---------------------------------
    // The controller emits `tg-client:clearChatsStart` only after we
    // know how many dialogs there are, so the History tab paints
    // "Scanning…" until that event lands. Surface a `connecting`
    // lifecycle event up-front so the operator sees that the worker
    // actually started doing something instead of staring at "queued".
    _emitProgress({ type: 'connecting' });

    await _loadAndAuthSession(sessionId, userId);
    // 10s hard cap on the (re)connect with proxy → direct-IP fallback
    // when the bound proxy is unreachable. With a dead SOCKS5 proxy
    // gramJS retries the underlying socket internally for 15s+ a pop
    // and never resolves on its own.
    await tgService._ensureConnected(sessionId, {
      timeoutMs: connectTimeoutMs,
      allowProxyFallback: true,
    });
    _throwIfAborted();
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    // Pre-flight `getMe` so the worker fails fast when MTProto can't
    // actually round-trip even though `client.connect()` reported
    // success (typical of a proxy that opens TCP but corrupts msg_keys
    // — see "Security error while unpacking …" in the bug report).
    let selfId = null;
    try {
      const me = await _withTimeoutAndAbort(
        entry.client.getMe(),
        connectTimeoutMs,
        'GETME',
      );
      selfId = _toIdNum(me?.id);
    } catch (err) {
      if (err && err.cancelled) throw err;
      // Network-level pre-flight failure (timeout / mtproto desync) —
      // fail the whole session rather than spend minutes on dialog
      // scan that will also hang.
      if (err && (err.isTimeout || /TIMEOUT_/.test(err.code || ''))) {
        throw new AppError(
          `Pre-flight check failed for session ${sessionId}: ${err.message}`,
          504,
          'PREFLIGHT_TIMEOUT',
        );
      }
      logger.debug(`clearChats getMe failed (continuing without self id): ${err.message}`);
    }

    _throwIfAborted();

    // ---- Dialog scan with hard cap + heartbeats --------------------
    // Pull as many dialogs as Telegram will give us for the account in
    // one call. The `iterDialogs` helper is the "no limit" sibling of
    // getDialogs and returns every dialog the account has on the panel
    // side. We collect into an array so we can fan out concurrently
    // and emit progress events as each dialog completes.
    //
    // Wrapped in a hard timeout because gramJS's iterator silently
    // retries internally on socket errors; without a deadline the
    // whole job can sit on "Scanning chats" forever when the proxy
    // misbehaves mid-stream.
    _emitProgress({ type: 'scanning', dialogsSoFar: 0 });
    const io = global.io;
    const room = `tg-client:u${userId}:s${sessionId}`;
    if (io) {
      try {
        io.to(room).emit('tg-client:clearChatsScanning', {
          sessionId: String(sessionId),
          jobId,
        });
      } catch (_) { /* ignore */ }
    }
    const dialogs = [];
    let lastHeartbeatMs = Date.now();
    const HEARTBEAT_MS = 1_500;

    const _scanDialogs = async () => {
      for await (const d of entry.client.iterDialogs({})) {
        if (signal && signal.aborted) {
          const reason = (signal.reason && (signal.reason.message || String(signal.reason)))
            || 'Cancelled';
          const err = new AppError(reason, 499, 'CANCELLED');
          err.cancelled = true;
          throw err;
        }
        if (d && d.entity) dialogs.push(d);
        const now = Date.now();
        if (now - lastHeartbeatMs >= HEARTBEAT_MS) {
          lastHeartbeatMs = now;
          _emitProgress({ type: 'scanning', dialogsSoFar: dialogs.length });
          if (io) {
            try {
              io.to(room).emit('tg-client:clearChatsScanning', {
                sessionId: String(sessionId),
                jobId,
                dialogsSoFar: dialogs.length,
              });
            } catch (_) { /* ignore */ }
          }
        }
      }
    };

    try {
      await _withTimeoutAndAbort(_scanDialogs(), scanTimeoutMs, 'DIALOGS');
    } catch (err) {
      if (err && err.cancelled) throw err;
      if (err && (err.isTimeout || /TIMEOUT_/.test(err.code || ''))) {
        throw new AppError(
          `Dialog scan timed out after ${Math.round(scanTimeoutMs / 1000)}s (proxy may be unreachable)`,
          504,
          'DIALOG_SCAN_TIMEOUT',
        );
      }
      throw new AppError(`Failed to list dialogs: ${err.message}`, 502, 'DIALOGS_FETCH_FAILED');
    }

    _throwIfAborted();

    const total = dialogs.length;
    const results = new Array(total);
    let succeeded = 0;
    let failed = 0;
    let done = 0;

    if (io && total > 0) {
      try {
        io.to(room).emit('tg-client:clearChatsStart', {
          sessionId: String(sessionId),
          total,
          revoke,
          jobId,
        });
      } catch (_) { /* ignore */ }
    }
    _emitProgress({ type: 'started', total });

    const _errStr = (e) => (e && (e.message || e.errorMessage)) || String(e);
    const _errCode = (e) => {
      const c = e && (e.errorMessage || e.code);
      return typeof c === 'string' ? c : null;
    };

    // Process one dialog: clear history, then leave/delete for groups
    // & channels. Records into `results[idx]` and bumps shared counters
    // so the Promise-pool workers can run in any order without stepping
    // on each other.
    const _processDialog = async (idx) => {
      // Cancellation: when the controller has flipped the AbortSignal
      // on us, mark this peer as cancelled instead of attempting
      // another DeleteHistory round-trip on a possibly-dead proxy.
      if (signal && signal.aborted) {
        failed += 1;
        done += 1;
        const reason = (signal.reason && (signal.reason.message || String(signal.reason)))
          || 'Cancelled';
        const r = {
          peerType: _peerTypeOf(dialogs[idx]?.entity) || 'unknown',
          peerId: _toIdNum(dialogs[idx]?.entity?.id),
          title: _entityTitle(dialogs[idx]?.entity),
          ok: false,
          action: null,
          cleared: false,
          left: false,
          deleted: false,
          error: reason,
          code: 'CANCELLED',
          warnings: [],
        };
        results[idx] = r;
        _emitProgress({ type: 'progress', total, done, ...r });
        return;
      }

      const dialog = dialogs[idx];
      const entity = dialog.entity;
      const peerType = _peerTypeOf(entity);
      const peerIdNum = _toIdNum(entity?.id);
      const title = _entityTitle(entity);

      if (!peerType || peerIdNum == null) {
        failed += 1;
        done += 1;
        const r = {
          peerType: peerType || 'unknown',
          peerId: peerIdNum,
          title,
          ok: false,
          action: null,
          cleared: false,
          left: false,
          deleted: false,
          error: 'Unrecognized dialog entity',
          code: 'BAD_PEER',
          warnings: [],
        };
        results[idx] = r;
        _emitProgress({ type: 'progress', total, done, ...r });
        return;
      }

      // Skip the account's own "Saved Messages" chat — it can't be left,
      // and we still want a successful "cleared" entry rather than a
      // misleading leave failure.
      const isSelfChat =
        peerType === 'user' && selfId != null && peerIdNum === selfId;

      // Bots are User entities with `entity.bot === true`. We treat them
      // like groups/channels for removal purposes: the dialog must be
      // dropped from the caller's list (not just cleared) and the bot
      // is blocked so it can't ping the user back.
      const isBot = peerType === 'user' && !isSelfChat && !!entity?.bot;

      const warnings = [];
      let cleared = false;
      let left = false;
      let deleted = false;
      let blocked = false;
      let fatalErr = null;

      // ---- Step 1: clear history (best-effort for groups/channels) ----
      try {
        if (peerType === 'channel') {
          const inputChannel = await entry.client.getInputEntity(entity);
          await _withFloodRetry(() =>
            entry.client.invoke(new Api.channels.DeleteHistory({
              channel: inputChannel,
              maxId: 0,
              forEveryone: revoke,
            }))
          );
        } else {
          const inputPeer = await entry.client.getInputEntity(entity);
          await _withFloodRetry(() =>
            entry.client.invoke(new Api.messages.DeleteHistory({
              peer: inputPeer,
              maxId: 0,
              // Private chats keep the historical semantic:
              // revoke=false ⇒ just_clear (caller-only), revoke=true ⇒
              // also remove the dialog and delete for the other side.
              // Bots are forced to just_clear=false so the dialog is
              // dropped from the caller's list — leaving a bot in the
              // dialog list defeats the point of "delete bot".
              // Basic chats always just_clear here because the dialog
              // is removed by the explicit DeleteChatUser / DeleteChat
              // step below — using just_clear=false here would make
              // Telegram report CHAT_ADMIN_REQUIRED on some basic groups.
              justClear: isBot ? false : peerType === 'user' ? !revoke : true,
              revoke,
            }))
          );
        }
        cleared = true;
        if (isBot) {
          // The DeleteHistory(justClear=false) call above already removed
          // the bot dialog from the caller's list, so flag it as deleted
          // for the per-action breakdown.
          deleted = true;
        }
      } catch (err) {
        const code = _errCode(err);
        const msg = _errStr(err);
        if (peerType === 'user') {
          fatalErr = { msg, code, stage: 'clearHistory' };
        } else {
          warnings.push({ stage: 'clearHistory', code, error: msg });
          logger.debug(
            `clearChats session=${sessionId} peer=${peerType}/${peerIdNum} clear failed (will still try leave): ${msg}`
          );
        }
      }

      // ---- Step 1b: block bots so they can't keep messaging us -------
      // Best-effort: a Block failure shouldn't fail the whole peer.
      if (!fatalErr && isBot) {
        try {
          const inputPeer = await entry.client.getInputEntity(entity);
          await _withFloodRetry(() =>
            entry.client.invoke(new Api.contacts.Block({ id: inputPeer }))
          );
          blocked = true;
        } catch (err) {
          warnings.push({
            stage: 'blockBot',
            code: _errCode(err),
            error: _errStr(err),
          });
          logger.debug(
            `clearChats session=${sessionId} bot=${peerIdNum} block failed (continuing): ${_errStr(err)}`
          );
        }
      }

      // ---- Step 2: leave / delete groups & channels ------------------
      if (!fatalErr && peerType === 'chat' && !isSelfChat) {
        if (revoke) {
          try {
            await _withFloodRetry(() =>
              entry.client.invoke(new Api.messages.DeleteChat({
                chatId: peerIdNum,
              }))
            );
            deleted = true;
          } catch (err) {
            warnings.push({
              stage: 'deleteChat',
              code: _errCode(err),
              error: _errStr(err),
            });
          }
        }
        if (!deleted) {
          try {
            await _withFloodRetry(() =>
              entry.client.invoke(new Api.messages.DeleteChatUser({
                chatId: peerIdNum,
                userId: new Api.InputUserSelf(),
                revokeHistory: revoke,
              }))
            );
            left = true;
          } catch (err) {
            fatalErr = {
              msg: _errStr(err),
              code: _errCode(err),
              stage: 'leaveChat',
            };
          }
        }
      } else if (!fatalErr && peerType === 'channel') {
        const inputChannel = await entry.client.getInputEntity(entity);
        if (revoke) {
          try {
            await _withFloodRetry(() =>
              entry.client.invoke(new Api.channels.DeleteChannel({
                channel: inputChannel,
              }))
            );
            deleted = true;
          } catch (err) {
            warnings.push({
              stage: 'deleteChannel',
              code: _errCode(err),
              error: _errStr(err),
            });
          }
        }
        if (!deleted) {
          try {
            await _withFloodRetry(() =>
              entry.client.invoke(new Api.channels.LeaveChannel({
                channel: inputChannel,
              }))
            );
            left = true;
          } catch (err) {
            fatalErr = {
              msg: _errStr(err),
              code: _errCode(err),
              stage: 'leaveChannel',
            };
          }
        }
      }

      // ---- Step 3: record + emit ------------------------------------
      const ok = !fatalErr;
      const action = deleted ? 'deleted' : left ? 'left' : ok ? 'cleared' : null;
      if (ok) succeeded += 1;
      else failed += 1;
      done += 1;

      if (!ok) {
        logger.warn(
          `clearChats session=${sessionId} peer=${peerType}/${peerIdNum} stage=${fatalErr.stage} failed: ${fatalErr.msg}`
        );
      }

      const r = {
        peerType,
        peerId: peerIdNum,
        title,
        ok,
        action,
        isBot,
        cleared,
        left,
        deleted,
        blocked,
        error: ok ? null : fatalErr.msg,
        code: ok ? null : fatalErr.code,
        warnings,
      };
      results[idx] = r;

      _emitProgress({ type: 'progress', total, done, ...r });

      if (io) {
        try {
          io.to(room).emit('tg-client:clearChatsProgress', {
            sessionId: String(sessionId),
            total,
            done,
            peerType,
            peerId: peerIdNum,
            title,
            ok,
            action,
            error: r.error,
            jobId,
          });
          if (cleared) {
            io.to(room).emit('tg-client:dialogHistoryCleared', {
              sessionId: String(sessionId),
              peerType,
              peerId: peerIdNum,
              revoke,
            });
          }
          if (left || deleted) {
            io.to(room).emit('tg-client:dialogLeft', {
              sessionId: String(sessionId),
              peerType,
              peerId: peerIdNum,
              deleted,
            });
          }
        } catch (_) { /* ignore */ }
      }
    };

    // Bounded-concurrency pool. Each "worker" pulls the next index and
    // processes it; when the index pointer overruns the array, the
    // worker exits. `Promise.all` then resolves once every worker is
    // idle, i.e. every dialog has been processed.
    //
    // Workers also bail out as soon as the AbortSignal fires so that
    // an operator clicking Cancel doesn't have to wait for every
    // already-queued peer to round-trip Telegram.
    let nextIdx = 0;
    const workerCount = Math.min(concurrency, total);
    await Promise.all(
      new Array(workerCount).fill(0).map(async () => {
        while (true) {
          if (signal && signal.aborted) return;
          const i = nextIdx++;
          if (i >= total) return;
          await _processDialog(i);
        }
      })
    );

    // If we exited early because of a cancel, mark every untouched
    // dialog as cancelled so the UI per-session counters add up.
    if (signal && signal.aborted) {
      const reason = (signal.reason && (signal.reason.message || String(signal.reason)))
        || 'Cancelled';
      for (let i = 0; i < total; i += 1) {
        if (results[i]) continue;
        failed += 1;
        done += 1;
        const entity = dialogs[i]?.entity;
        const r = {
          peerType: _peerTypeOf(entity) || 'unknown',
          peerId: _toIdNum(entity?.id),
          title: _entityTitle(entity),
          ok: false,
          action: null,
          cleared: false,
          left: false,
          deleted: false,
          error: reason,
          code: 'CANCELLED',
          warnings: [],
        };
        results[i] = r;
        _emitProgress({ type: 'progress', total, done, ...r });
      }
    }

    if (io) {
      try {
        io.to(room).emit('tg-client:clearChatsDone', {
          sessionId: String(sessionId),
          total,
          succeeded,
          failed,
          revoke,
          jobId,
          cancelled: !!(signal && signal.aborted),
        });
      } catch (_) { /* ignore */ }
    }
    _emitProgress({ type: 'finished', total, succeeded, failed });

    return {
      sessionId: String(sessionId),
      total,
      succeeded,
      failed,
      revoke,
      cancelled: !!(signal && signal.aborted),
      results: results.filter(Boolean),
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

  // -----------------------------------------------------------------------
  // D9 — Contacts
  // -----------------------------------------------------------------------

  /**
   * D9 — List contacts. contacts.GetContacts returns Users + Contacts;
   * we merge into a single normalized array sorted by mutual / firstName.
   */
  async listContacts(sessionId, userId, { search = '' } = {}) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let res;
    try {
      res = await entry.client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) }));
    } catch (err) {
      throw new AppError(`GetContacts failed: ${err.message}`, 502, 'GET_CONTACTS_FAILED');
    }
    if (res?.className === 'contacts.contactsNotModified') return { contacts: [] };

    const userById = new Map();
    for (const u of res.users || []) userById.set(String(_toIdNum(u.id)), u);

    const out = (res.contacts || []).map((c) => {
      const u = userById.get(String(_toIdNum(c.userId)));
      if (!u) return null;
      return {
        id: _toIdNum(u.id),
        accessHash: u.accessHash != null ? String(u.accessHash) : null,
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        username: u.username || null,
        usernames: Array.isArray(u.usernames) ? u.usernames.map((un) => un.username) : [],
        phone: u.phone || null,
        mutual: !!c.mutual,
        verified: !!u.verified,
        premium: !!u.premium,
        bot: !!u.bot,
        deleted: !!u.deleted,
        photoId: u.photo?.photoId != null ? String(u.photo.photoId) : null,
      };
    }).filter(Boolean);

    const q = String(search || '').toLowerCase().trim();
    const filtered = q
      ? out.filter((c) => {
        const hay = [
          c.firstName, c.lastName, c.username, ...(c.usernames || []), c.phone,
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      })
      : out;

    filtered.sort((a, b) => {
      if (a.mutual !== b.mutual) return a.mutual ? -1 : 1;
      const an = `${a.firstName} ${a.lastName}`.trim().toLowerCase();
      const bn = `${b.firstName} ${b.lastName}`.trim().toLowerCase();
      return an.localeCompare(bn);
    });

    return { count: filtered.length, contacts: filtered };
  }

  /**
   * D9 — Search the user's contacts + global directory by query.
   */
  async searchContacts(sessionId, userId, q, { limit = 20 } = {}) {
    if (!q || String(q).trim().length < 1) {
      throw new AppError('q is required', 400, 'NO_QUERY');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let res;
    try {
      res = await entry.client.invoke(new Api.contacts.Search({
        q: String(q).trim(),
        limit: Math.max(1, Math.min(Number(limit) || 20, 50)),
      }));
    } catch (err) {
      throw new AppError(`Search failed: ${err.message}`, 502, 'SEARCH_CONTACTS_FAILED');
    }

    const users = new Map();
    for (const u of res.users || []) users.set(String(_toIdNum(u.id)), u);
    const chats = new Map();
    for (const c of res.chats || []) chats.set(String(_toIdNum(c.id)), c);

    const myContactIds = new Set((res.myResults || [])
      .filter((p) => p.className === 'PeerUser')
      .map((p) => String(_toIdNum(p.userId))));

    const results = (res.results || []).map((p) => {
      if (p.className === 'PeerUser') {
        const u = users.get(String(_toIdNum(p.userId)));
        if (!u) return null;
        return {
          kind: 'user',
          id: _toIdNum(u.id),
          accessHash: u.accessHash != null ? String(u.accessHash) : null,
          firstName: u.firstName || '',
          lastName: u.lastName || '',
          username: u.username || null,
          phone: u.phone || null,
          isContact: myContactIds.has(String(_toIdNum(u.id))),
          verified: !!u.verified,
          premium: !!u.premium,
          bot: !!u.bot,
          photoId: u.photo?.photoId != null ? String(u.photo.photoId) : null,
        };
      }
      if (p.className === 'PeerChannel') {
        const c = chats.get(String(_toIdNum(p.channelId)));
        if (!c) return null;
        return {
          kind: c.broadcast ? 'channel' : 'chat',
          id: _toIdNum(c.id),
          accessHash: c.accessHash != null ? String(c.accessHash) : null,
          title: c.title || '',
          username: c.username || null,
          membersCount: c.participantsCount || 0,
          verified: !!c.verified,
          photoId: c.photo?.photoId != null ? String(c.photo.photoId) : null,
        };
      }
      return null;
    }).filter(Boolean);

    return { results };
  }

  /**
   * D9 — Add a contact. Body: { phone, firstName?, lastName? } OR
   * { userId, firstName?, lastName? }. Telegram's contacts.AddContact
   * needs a user input — we call ImportContacts when only a phone is
   * given (server resolves the user); otherwise we use AddContact.
   */
  async addContact(sessionId, userId, payload = {}) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const firstName = String(payload.firstName || '').slice(0, 64);
    const lastName  = String(payload.lastName  || '').slice(0, 64);
    const sharePhone = !!payload.sharePhone;
    let resultUser = null;

    if (payload.userId) {
      let inputUser;
      try {
        inputUser = await entry.client.getInputEntity(_buildPeerInput('user', _toIdNum(payload.userId)));
      } catch (err) {
        throw new AppError(`Resolve user failed: ${err.message}`, 502, 'RESOLVE_FAILED');
      }
      let updates;
      try {
        updates = await entry.client.invoke(new Api.contacts.AddContact({
          id: inputUser,
          firstName,
          lastName,
          phone: String(payload.phone || ''),
          addPhonePrivacyException: sharePhone,
        }));
      } catch (err) {
        throw new AppError(`AddContact failed: ${err.message}`, 502, 'ADD_CONTACT_FAILED');
      }
      resultUser = (updates?.users || []).find((u) => String(_toIdNum(u.id)) === String(_toIdNum(payload.userId)));
    } else if (payload.phone) {
      let res;
      try {
        res = await entry.client.invoke(new Api.contacts.ImportContacts({
          contacts: [
            new Api.InputPhoneContact({
              clientId: BigInt(Date.now() & 0x7fffffff),
              phone: String(payload.phone),
              firstName,
              lastName,
            }),
          ],
        }));
      } catch (err) {
        throw new AppError(`ImportContacts failed: ${err.message}`, 502, 'IMPORT_CONTACT_FAILED');
      }
      if (!res || (res.imported || []).length === 0) {
        throw new AppError('Phone is not on Telegram', 404, 'PHONE_NOT_FOUND');
      }
      const importedUserId = String(_toIdNum(res.imported[0].userId));
      resultUser = (res.users || []).find((u) => String(_toIdNum(u.id)) === importedUserId);
    } else {
      throw new AppError('phone or userId is required', 400, 'NO_TARGET');
    }

    this._broadcastContactsChanged(userId, sessionId, 'add', resultUser ? _toIdNum(resultUser.id) : null);
    return this.listContacts(sessionId, userId);
  }

  /**
   * D9 — Delete one or more contacts.
   */
  async deleteContacts(sessionId, userId, ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('ids is required', 400, 'NO_IDS');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const inputs = [];
    for (const uid of ids) {
      try {
        inputs.push(await entry.client.getInputEntity(_buildPeerInput('user', _toIdNum(uid))));
      } catch (_) { /* skip unresolved */ }
    }
    if (inputs.length === 0) throw new AppError('No valid users', 400, 'NO_VALID');

    try {
      await entry.client.invoke(new Api.contacts.DeleteContacts({ id: inputs }));
    } catch (err) {
      throw new AppError(`DeleteContacts failed: ${err.message}`, 502, 'DELETE_CONTACTS_FAILED');
    }
    for (const uid of ids) this._broadcastContactsChanged(userId, sessionId, 'remove', _toIdNum(uid));
    return this.listContacts(sessionId, userId);
  }

  _broadcastContactsChanged(userId, sessionId, action, userIdChanged) {
    try {
      const io = global.io;
      if (!io) return;
      io.to(`tg-client:u${userId}:s${sessionId}`).emit('tg-client:contactsChanged', {
        sessionId: String(sessionId), action, userId: userIdChanged,
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.debug(`tg-client contacts broadcast failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------
  // D12 — Drafts
  // ---------------------------------------------------------------------

  /**
   * Save a per-chat draft on Telegram's servers.
   *
   * Telegram exposes drafts as a server-side feature so the same chat
   * shows the same draft on every device. We use messages.SaveDraft
   * which both writes the draft and broadcasts an UpdateDraftMessage to
   * other listening sessions.
   */
  async saveDraft(sessionId, userId, peerType, peerId, payload = {}) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    const text = String(payload.text ?? '').slice(0, 4096);
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let inputPeer;
    try {
      inputPeer = await entry.client.getInputEntity(_buildPeerInput(peerType, peerId));
    } catch (err) {
      throw new AppError(`Could not resolve peer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    const params = {
      peer: inputPeer,
      message: text,
      noWebpage: !!payload.noWebpage,
    };
    const replyToMsgId = parseInt(payload.replyToMsgId, 10);
    if (Number.isFinite(replyToMsgId) && replyToMsgId > 0) {
      params.replyTo = new Api.InputReplyToMessage({ replyToMsgId });
    }

    try {
      await entry.client.invoke(new Api.messages.SaveDraft(params));
    } catch (err) {
      throw new AppError(`SaveDraft failed: ${err.message}`, 502, 'SAVE_DRAFT_FAILED');
    }

    return {
      peerType,
      peerId: _toIdNum(peerId),
      draft: text || (params.replyTo)
        ? {
            text,
            date: new Date().toISOString(),
            replyToMsgId: params.replyTo ? replyToMsgId : null,
            noWebpage: !!payload.noWebpage,
          }
        : null,
    };
  }

  /**
   * Clear the draft for a single chat.
   *
   * Telegram does this with messages.SaveDraft({ message: '' }), which
   * server-side maps to DraftMessageEmpty.
   */
  async clearDraft(sessionId, userId, peerType, peerId) {
    return this.saveDraft(sessionId, userId, peerType, peerId, { text: '' });
  }

  /**
   * Get every draft the account has across all chats.
   *
   * Returns a list keyed by peerType/peerId so the UI can render them
   * inline in the dialog list (the DialogList already gets per-row
   * drafts via getDialogs, but a fresh page-load — or a cross-window
   * sync — uses this endpoint to refresh).
   */
  async getAllDrafts(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let res;
    try {
      res = await entry.client.invoke(new Api.messages.GetAllDrafts());
    } catch (err) {
      throw new AppError(`GetAllDrafts failed: ${err.message}`, 502, 'GET_ALL_DRAFTS_FAILED');
    }

    const updates = res?.updates || [];
    const drafts = [];
    for (const u of updates) {
      if (u?.className !== 'UpdateDraftMessage') continue;
      const peer = u.peer;
      let peerType = null;
      let peerIdNum = null;
      if (peer?.userId != null) { peerType = 'user'; peerIdNum = _toIdNum(peer.userId); }
      else if (peer?.chatId != null) { peerType = 'chat'; peerIdNum = _toIdNum(peer.chatId); }
      else if (peer?.channelId != null) { peerType = 'channel'; peerIdNum = _toIdNum(peer.channelId); }
      if (!peerType || peerIdNum == null) continue;
      const norm = _normalizeDraft(u.draft);
      if (!norm) continue;
      drafts.push({ peerType, peerId: peerIdNum, draft: norm });
    }
    return { drafts };
  }

  // ---------------------------------------------------------------------
  // D13 — Pinned messages
  // ---------------------------------------------------------------------

  /**
   * Toggle the pinned flag on one message.
   *
   * @param {boolean} unpin    if true, unpin the message
   * @param {boolean} silent   if true, don't notify chat members
   * @param {boolean} pmOneside  in 1-on-1 chats, pin only on the caller's side
   */
  async setMessagePin(sessionId, userId, peerType, peerId, messageId, opts = {}) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    const idNum = parseInt(messageId, 10);
    if (!Number.isFinite(idNum) || idNum <= 0) {
      throw new AppError('Invalid messageId', 400, 'INVALID_MESSAGE_ID');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let inputPeer;
    try {
      inputPeer = await entry.client.getInputEntity(_buildPeerInput(peerType, peerId));
    } catch (err) {
      throw new AppError(`Could not resolve peer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    try {
      await entry.client.invoke(new Api.messages.UpdatePinnedMessage({
        peer: inputPeer,
        id: idNum,
        unpin: !!opts.unpin,
        silent: !!opts.silent,
        pmOneside: !!opts.pmOneside,
      }));
    } catch (err) {
      throw new AppError(`UpdatePinnedMessage failed: ${err.message}`, 502, 'PIN_FAILED');
    }

    return {
      peerType,
      peerId: _toIdNum(peerId),
      messageId: idNum,
      pinned: !opts.unpin,
    };
  }

  async pinMessage(sessionId, userId, peerType, peerId, messageId, opts = {}) {
    return this.setMessagePin(sessionId, userId, peerType, peerId, messageId, {
      ...opts, unpin: false,
    });
  }

  async unpinMessage(sessionId, userId, peerType, peerId, messageId) {
    return this.setMessagePin(sessionId, userId, peerType, peerId, messageId, {
      unpin: true,
    });
  }

  /**
   * Unpin every pinned message in a chat in one round-trip.
   */
  async unpinAllMessages(sessionId, userId, peerType, peerId) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let inputPeer;
    try {
      inputPeer = await entry.client.getInputEntity(_buildPeerInput(peerType, peerId));
    } catch (err) {
      throw new AppError(`Could not resolve peer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    try {
      await entry.client.invoke(new Api.messages.UnpinAllMessages({ peer: inputPeer }));
    } catch (err) {
      throw new AppError(`UnpinAllMessages failed: ${err.message}`, 502, 'UNPIN_ALL_FAILED');
    }

    return {
      peerType,
      peerId: _toIdNum(peerId),
      pinned: false,
    };
  }

  /**
   * Fetch every pinned message in a chat (newest first).
   *
   * Telegram exposes this as messages.Search with InputMessagesFilterPinned;
   * the response is the same shape as a regular message list, so we can
   * reuse `_normalizeMessage`.
   */
  async getPinnedMessages(sessionId, userId, peerType, peerId, opts = {}) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const me = await tgService.getMe(sessionId).catch(() => null);
    const ownId = me ? _toIdNum(me.id) : null;

    let entity;
    try {
      entity = await entry.client.getEntity(_buildPeerInput(peerType, peerId));
    } catch (err) {
      throw new AppError(`Could not resolve peer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    const limit = Math.min(
      Math.max(1, parseInt(opts.limit, 10) || 50),
      100
    );
    const offsetId = parseInt(opts.offsetId, 10) || 0;

    let res;
    try {
      res = await entry.client.invoke(new Api.messages.Search({
        peer: entity,
        q: '',
        filter: new Api.InputMessagesFilterPinned(),
        minDate: 0,
        maxDate: 0,
        offsetId,
        addOffset: 0,
        limit,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
      }));
    } catch (err) {
      throw new AppError(`Search(pinned) failed: ${err.message}`, 502, 'GET_PINNED_FAILED');
    }

    const dialogPeer = entity.id != null ? { [`${peerType}Id`]: entity.id } : null;
    const messages = (res.messages || [])
      .map((m) => _normalizeMessage(m, ownId, dialogPeer))
      .filter(Boolean);

    const senders = new Map();
    for (const u of res.users || []) {
      const sn = _normalizeSender(u);
      if (sn) senders.set(`${sn.peerType}:${sn.peerId}`, sn);
    }
    for (const c of res.chats || []) {
      const sn = _normalizeSender(c);
      if (sn) senders.set(`${sn.peerType}:${sn.peerId}`, sn);
    }

    return {
      peerType,
      peerId: _toIdNum(entity.id),
      messages,
      senders: Array.from(senders.values()),
      total: res.count ?? messages.length,
    };
  }

  // ---------------------------------------------------------------------
  // D4 — Search
  // ---------------------------------------------------------------------

  /**
   * Search messages within one chat (messages.Search with default filter).
   */
  async searchInChat(sessionId, userId, peerType, peerId, q, opts = {}) {
    if (!PEER_TYPES.has(peerType)) {
      throw new AppError('Invalid peer type', 400, 'INVALID_PEER_TYPE');
    }
    const query = String(q || '').trim();
    if (!query && !opts.filter) {
      throw new AppError('Search query is required', 400, 'SEARCH_QUERY_REQUIRED');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const me = await tgService.getMe(sessionId).catch(() => null);
    const ownId = me ? _toIdNum(me.id) : null;

    let entity;
    try {
      entity = await entry.client.getEntity(_buildPeerInput(peerType, peerId));
    } catch (err) {
      throw new AppError(`Could not resolve peer: ${err.message}`, 404, 'PEER_NOT_FOUND');
    }

    const limit = Math.min(
      Math.max(1, parseInt(opts.limit, 10) || 30),
      100
    );
    const offsetId = parseInt(opts.offsetId, 10) || 0;
    const filter = _buildSearchFilter(opts.filter);

    let res;
    try {
      res = await entry.client.invoke(new Api.messages.Search({
        peer: entity,
        q: query,
        filter,
        minDate: 0,
        maxDate: 0,
        offsetId,
        addOffset: 0,
        limit,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
        fromId: opts.fromId
          ? await entry.client.getInputEntity(_buildPeerInput('user', opts.fromId)).catch(() => null)
          : undefined,
      }));
    } catch (err) {
      throw new AppError(`Search failed: ${err.message}`, 502, 'SEARCH_FAILED');
    }

    const dialogPeer = entity.id != null ? { [`${peerType}Id`]: entity.id } : null;
    const messages = (res.messages || [])
      .map((m) => _normalizeMessage(m, ownId, dialogPeer))
      .filter(Boolean);

    const senders = new Map();
    for (const u of res.users || []) {
      const sn = _normalizeSender(u);
      if (sn) senders.set(`${sn.peerType}:${sn.peerId}`, sn);
    }
    for (const c of res.chats || []) {
      const sn = _normalizeSender(c);
      if (sn) senders.set(`${sn.peerType}:${sn.peerId}`, sn);
    }

    const nextOffsetId = messages.length
      ? Math.min(...messages.map((m) => Number(m.id)).filter((n) => Number.isFinite(n)))
      : 0;

    return {
      peerType,
      peerId: _toIdNum(entity.id),
      query,
      filter: opts.filter || 'all',
      messages,
      senders: Array.from(senders.values()),
      total: res.count ?? messages.length,
      nextOffsetId,
    };
  }

  /**
   * Search messages across every chat the account participates in
   * (messages.SearchGlobal).
   */
  async searchGlobal(sessionId, userId, q, opts = {}) {
    const query = String(q || '').trim();
    if (!query) {
      throw new AppError('Search query is required', 400, 'SEARCH_QUERY_REQUIRED');
    }
    await _loadAndAuthSession(sessionId, userId);
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    const me = await tgService.getMe(sessionId).catch(() => null);
    const ownId = me ? _toIdNum(me.id) : null;

    const limit = Math.min(
      Math.max(1, parseInt(opts.limit, 10) || 30),
      100
    );
    const filter = _buildSearchFilter(opts.filter);

    let res;
    try {
      res = await entry.client.invoke(new Api.messages.SearchGlobal({
        q: query,
        filter,
        minDate: 0,
        maxDate: 0,
        offsetRate: parseInt(opts.offsetRate, 10) || 0,
        offsetPeer: new Api.InputPeerEmpty(),
        offsetId: parseInt(opts.offsetId, 10) || 0,
        limit,
      }));
    } catch (err) {
      throw new AppError(`SearchGlobal failed: ${err.message}`, 502, 'SEARCH_GLOBAL_FAILED');
    }

    const userById = new Map();
    for (const u of res.users || []) userById.set(String(_toIdNum(u.id)), u);
    const chatById = new Map();
    for (const c of res.chats || []) chatById.set(String(_toIdNum(c.id)), c);

    const messages = [];
    const chatHints = new Map();
    for (const m of res.messages || []) {
      const peer = m.peerId;
      const chatPeerType = peer?.channelId ? 'channel'
        : peer?.chatId ? 'chat'
        : peer?.userId ? 'user'
        : null;
      const chatPeerId = _toIdNum(peer?.channelId ?? peer?.chatId ?? peer?.userId ?? null);
      const norm = _normalizeMessage(m, ownId, peer);
      if (!norm) continue;
      let chat = null;
      if (chatPeerType && chatPeerId != null) {
        const lookup = chatPeerType === 'user'
          ? userById.get(String(chatPeerId))
          : chatById.get(String(chatPeerId));
        if (lookup) {
          chat = {
            peerType: chatPeerType,
            peerId: chatPeerId,
            title: _entityTitle(lookup),
            username: lookup.username || null,
          };
          chatHints.set(`${chatPeerType}:${chatPeerId}`, chat);
        } else {
          chat = { peerType: chatPeerType, peerId: chatPeerId, title: '', username: null };
        }
      }
      messages.push({ ...norm, chat });
    }

    const senders = new Map();
    for (const u of res.users || []) {
      const sn = _normalizeSender(u);
      if (sn) senders.set(`${sn.peerType}:${sn.peerId}`, sn);
    }
    for (const c of res.chats || []) {
      const sn = _normalizeSender(c);
      if (sn) senders.set(`${sn.peerType}:${sn.peerId}`, sn);
    }

    const nextOffsetRate = res.nextRate || 0;
    const nextOffsetId = messages.length ? Math.min(...messages.map((m) => Number(m.id)).filter(Number.isFinite)) : 0;

    return {
      query,
      filter: opts.filter || 'all',
      messages,
      chats: Array.from(chatHints.values()),
      senders: Array.from(senders.values()),
      total: res.count ?? messages.length,
      nextOffsetRate,
      nextOffsetId,
    };
  }

  // ---------------------------------------------------------------------
  // D11 — Stickers / GIFs
  // ---------------------------------------------------------------------

  /**
   * Internal cache for sticker / GIF responses. Telegram's sticker
   * endpoints are slow (50–200 KB payload, several DB hits server-side)
   * and the data only changes when the user installs / uninstalls a
   * pack, so we keep a 5-minute per-session memo.
   */
  _stickerCacheGet(sessionId, key) {
    if (!this._stickerCache) this._stickerCache = new Map();
    const k = `${sessionId}|${key}`;
    const entry = this._stickerCache.get(k);
    if (!entry) return null;
    if (entry.expires < Date.now()) {
      this._stickerCache.delete(k);
      return null;
    }
    return entry.value;
  }

  _stickerCacheSet(sessionId, key, value, ttlMs = 5 * 60 * 1000) {
    if (!this._stickerCache) this._stickerCache = new Map();
    const k = `${sessionId}|${key}`;
    this._stickerCache.set(k, { value, expires: Date.now() + ttlMs });
  }

  _stickerCacheInvalidate(sessionId) {
    if (!this._stickerCache) return;
    const prefix = `${sessionId}|`;
    for (const key of this._stickerCache.keys()) {
      if (key.startsWith(prefix)) this._stickerCache.delete(key);
    }
  }

  /**
   * Installed sticker sets (messages.GetAllStickers).
   */
  async getStickerSets(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    const cached = this._stickerCacheGet(sessionId, 'sets');
    if (cached) return cached;
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let res;
    try {
      res = await entry.client.invoke(new Api.messages.GetAllStickers({ hash: BigInt(0) }));
    } catch (err) {
      throw new AppError(`GetAllStickers failed: ${err.message}`, 502, 'STICKERS_FAILED');
    }
    const sets = (res?.sets || []).map((s) => _normalizeStickerSet(s));
    const out = { sets };
    this._stickerCacheSet(sessionId, 'sets', out);
    return out;
  }

  /**
   * Recently used stickers (messages.GetRecentStickers).
   */
  async getRecentStickers(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    const cached = this._stickerCacheGet(sessionId, 'recent');
    if (cached) return cached;
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let res;
    try {
      res = await entry.client.invoke(new Api.messages.GetRecentStickers({ hash: BigInt(0) }));
    } catch (err) {
      throw new AppError(`GetRecentStickers failed: ${err.message}`, 502, 'RECENT_STICKERS_FAILED');
    }
    const stickers = (res?.stickers || []).map((d) => _normalizeStickerDoc(d)).filter(Boolean);
    const out = { stickers };
    this._stickerCacheSet(sessionId, 'recent', out);
    return out;
  }

  /**
   * Favorite stickers (messages.GetFavedStickers).
   */
  async getFavoriteStickers(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    const cached = this._stickerCacheGet(sessionId, 'faved');
    if (cached) return cached;
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let res;
    try {
      res = await entry.client.invoke(new Api.messages.GetFavedStickers({ hash: BigInt(0) }));
    } catch (err) {
      throw new AppError(`GetFavedStickers failed: ${err.message}`, 502, 'FAVED_STICKERS_FAILED');
    }
    const stickers = (res?.stickers || []).map((d) => _normalizeStickerDoc(d)).filter(Boolean);
    const out = { stickers };
    this._stickerCacheSet(sessionId, 'faved', out);
    return out;
  }

  /**
   * Search public sticker sets by short name / title (messages.SearchStickerSets).
   */
  async searchStickerSets(sessionId, userId, q) {
    await _loadAndAuthSession(sessionId, userId);
    const query = String(q || '').trim();
    if (!query) return { sets: [] };
    const cached = this._stickerCacheGet(sessionId, `search:${query}`);
    if (cached) return cached;
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let res;
    try {
      res = await entry.client.invoke(new Api.messages.SearchStickerSets({
        q: query, hash: BigInt(0),
      }));
    } catch (err) {
      throw new AppError(`SearchStickerSets failed: ${err.message}`, 502, 'SEARCH_STICKERS_FAILED');
    }
    const sets = (res?.sets || []).map((s) => _normalizeStickerSet(s));
    const out = { sets };
    this._stickerCacheSet(sessionId, `search:${query}`, out, 60 * 1000);
    return out;
  }

  /**
   * Saved GIFs (messages.GetSavedGifs).
   */
  async getSavedGifs(sessionId, userId) {
    await _loadAndAuthSession(sessionId, userId);
    const cached = this._stickerCacheGet(sessionId, 'gifs:saved');
    if (cached) return cached;
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let res;
    try {
      res = await entry.client.invoke(new Api.messages.GetSavedGifs({ hash: BigInt(0) }));
    } catch (err) {
      throw new AppError(`GetSavedGifs failed: ${err.message}`, 502, 'SAVED_GIFS_FAILED');
    }
    const gifs = (res?.gifs || []).map((d) => _normalizeGifDoc(d)).filter(Boolean);
    const out = { gifs };
    this._stickerCacheSet(sessionId, 'gifs:saved', out);
    return out;
  }

  /**
   * Search the public GIF directory via @gif inline bot (the same
   * mechanism the official client uses).
   */
  async searchGifs(sessionId, userId, q, opts = {}) {
    await _loadAndAuthSession(sessionId, userId);
    const query = String(q || '').trim();
    if (!query) return { gifs: [], nextOffset: '' };
    const cacheKey = `gifs:search:${query}|${opts.offset || ''}`;
    const cached = this._stickerCacheGet(sessionId, cacheKey);
    if (cached) return cached;
    await tgService._ensureConnected(sessionId);
    const entry = tgService.clients.get(String(sessionId));
    if (!entry) throw new AppError('Session client not loaded', 500, 'CLIENT_NOT_LOADED');

    let bot;
    try {
      bot = await entry.client.getInputEntity('gif');
    } catch (err) {
      throw new AppError(`GIF bot unreachable: ${err.message}`, 502, 'GIFS_BOT_FAILED');
    }

    let res;
    try {
      res = await entry.client.invoke(new Api.messages.GetInlineBotResults({
        bot,
        peer: new Api.InputPeerEmpty(),
        query,
        offset: String(opts.offset || ''),
      }));
    } catch (err) {
      throw new AppError(`GIF search failed: ${err.message}`, 502, 'GIFS_SEARCH_FAILED');
    }

    const gifs = (res?.results || [])
      .map((r) => _normalizeInlineGif(r))
      .filter(Boolean);
    const out = { gifs, nextOffset: res.nextOffset || '' };
    this._stickerCacheSet(sessionId, cacheKey, out, 60 * 1000);
    return out;
  }
}

/**
 * Map a UI filter name to a Telegram InputMessagesFilter constructor.
 * Used by D4 search.
 */
function _buildSearchFilter(name) {
  switch (String(name || 'all').toLowerCase()) {
    case 'photo':       return new Api.InputMessagesFilterPhotos();
    case 'video':       return new Api.InputMessagesFilterVideo();
    case 'media':       return new Api.InputMessagesFilterPhotoVideo();
    case 'document':    return new Api.InputMessagesFilterDocument();
    case 'url':         return new Api.InputMessagesFilterUrl();
    case 'gif':         return new Api.InputMessagesFilterGif();
    case 'voice':       return new Api.InputMessagesFilterVoice();
    case 'audio':       return new Api.InputMessagesFilterMusic();
    case 'mention':     return new Api.InputMessagesFilterMyMentions();
    case 'pinned':      return new Api.InputMessagesFilterPinned();
    case 'all':
    default:            return new Api.InputMessagesFilterEmpty();
  }
}

/**
 * Best-effort sticker-set summary — enough for the picker to render
 * the cover, title, and request individual stickers later by id.
 */
function _normalizeStickerSet(item) {
  const set = item?.set || item;
  if (!set) return null;
  const cover = item?.cover || item?.covers?.[0] || null;
  return {
    id: set.id != null ? String(set.id) : null,
    accessHash: set.accessHash != null ? String(set.accessHash) : null,
    title: set.title || '',
    shortName: set.shortName || '',
    count: set.count || 0,
    archived: !!set.archived,
    official: !!set.official,
    masks: !!set.masks,
    animated: !!set.animated,
    videos: !!set.videos,
    emojis: !!set.emojis,
    thumbDocId: set.thumbDocumentId != null ? String(set.thumbDocumentId) : null,
    cover: cover ? _normalizeStickerDoc(cover) : null,
  };
}

/**
 * Best-effort sticker / animated-sticker / video-sticker summary.
 *
 * The shape is sufficient for the picker UI and for the existing
 * /send-sticker endpoint (which takes documentId + accessHash + fileRef).
 */
function _normalizeStickerDoc(doc) {
  if (!doc || doc.className === 'DocumentEmpty') return null;
  const attrs = doc.attributes || [];
  const sticker = attrs.find((a) => a.className === 'DocumentAttributeSticker');
  const dim = attrs.find((a) => a.className === 'DocumentAttributeImageSize')
    || attrs.find((a) => a.className === 'DocumentAttributeVideo');
  const fileRef = doc.fileReference
    ? Buffer.from(doc.fileReference).toString('base64')
    : null;
  return {
    id: String(doc.id),
    accessHash: String(doc.accessHash),
    fileReference: fileRef,
    mimeType: doc.mimeType || 'image/webp',
    size: doc.size != null ? Number(doc.size) : 0,
    width: dim?.w || 0,
    height: dim?.h || 0,
    alt: sticker?.alt || '',
    setId: sticker?.stickerset?.id != null ? String(sticker.stickerset.id) : null,
    animated: doc.mimeType === 'application/x-tgsticker',
    video: doc.mimeType === 'video/webm',
    thumbId: doc.thumbs?.[0]?.type || null,
  };
}

/**
 * Best-effort GIF document (animated MP4 / video) summary.
 */
function _normalizeGifDoc(doc) {
  if (!doc || doc.className === 'DocumentEmpty') return null;
  const attrs = doc.attributes || [];
  const dim = attrs.find((a) => a.className === 'DocumentAttributeVideo');
  const fileRef = doc.fileReference
    ? Buffer.from(doc.fileReference).toString('base64')
    : null;
  return {
    id: String(doc.id),
    accessHash: String(doc.accessHash),
    fileReference: fileRef,
    mimeType: doc.mimeType || 'video/mp4',
    size: doc.size != null ? Number(doc.size) : 0,
    width: dim?.w || 0,
    height: dim?.h || 0,
    duration: dim?.duration || 0,
    isVideo: !!dim,
  };
}

/**
 * Best-effort BotInlineMediaResult / BotInlineResult summary for GIFs.
 *
 * Inline GIF results come back from the @gif inline bot wrapped in a
 * BotInlineMediaResult that carries the underlying Document so we
 * normalize it the same way as a saved GIF, plus the mp4/thumb URLs.
 */
function _normalizeInlineGif(r) {
  if (!r) return null;
  const doc = r.document;
  if (doc && doc.className !== 'DocumentEmpty') {
    return {
      ..._normalizeGifDoc(doc),
      title: r.title || '',
      queryId: r.queryId != null ? String(r.queryId) : null,
      resultId: r.id || null,
    };
  }
  // Inline-only result: surface URLs so the UI can preview but the
  // sender can't relay it as a saved-GIF (no document handle).
  const content = r.content || r.thumb || null;
  if (!content) return null;
  return {
    id: r.id || null,
    title: r.title || '',
    inline: true,
    url: content.url || null,
    mimeType: content.mimeType || 'video/mp4',
    width: content.w || 0,
    height: content.h || 0,
    queryId: r.queryId != null ? String(r.queryId) : null,
    resultId: r.id || null,
  };
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
