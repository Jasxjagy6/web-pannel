/**
 * TelegramClientStream — bridges per-session GramJS update events to the
 * panel's existing Socket.IO instance so the React Telegram client can
 * react to new / edited / read messages in real time.
 *
 * Per-session reference counting:
 *   - the first browser window for a session triggers `attach(sessionId)`
 *     which registers ONE NewMessage handler + ONE Raw handler on the
 *     underlying GramJS client and bumps a refcount.
 *   - additional windows for the same session just bump the refcount.
 *   - on `detach(sessionId)` we decrement the refcount; when it hits
 *     zero we tear down the GramJS handlers so we're not running
 *     event subscriptions for accounts no one is looking at anymore.
 *
 * The Socket.IO room name is `tg-client:u<userId>:s<sessionId>`. Membership
 * is gated on `attachClient(sessionId, userId)` so a forged client-side
 * join can't subscribe to someone else's session.
 */

const tgService = require('./telegramService');
const tcService = require('./telegramClientService');
const logger = require('../utils/logger');

function _roomName(userId, sessionId) {
  return `tg-client:u${userId}:s${sessionId}`;
}

class TelegramClientStream {
  constructor() {
    /**
     * @type {Map<string, { unsubscribe: () => Promise<void> | void, refcount: number, userId: string }>}
     */
    this._subs = new Map();
  }

  /**
   * Idempotent: ensure GramJS event handlers are attached for `sessionId`
   * and that the Socket.IO `socket` joins the per-session room.
   *
   * @param {object} socket Socket.IO socket instance
   * @param {string|number} sessionId
   * @param {string|number} userId
   */
  async attach(socket, sessionId, userId) {
    const sid = String(sessionId);
    const uid = String(userId);
    const key = `${uid}:${sid}`;

    // Authorize: ensure session belongs to this user. We piggyback on
    // the same row check that the REST endpoints use so a Socket.IO
    // client can't subscribe to a session it doesn't own.
    try {
      await tcService.connect(sessionId, userId);
    } catch (err) {
      throw new Error(`attach denied: ${err.message}`);
    }

    // Always join the room for this socket.
    const roomName = _roomName(uid, sid);
    socket.join(roomName);

    // Bump or create the GramJS subscription.
    const existing = this._subs.get(key);
    if (existing) {
      existing.refcount += 1;
      this._subs.set(key, existing);
      return { ok: true, room: roomName, refcount: existing.refcount };
    }

    const sub = await this._installHandlers(sid, uid, roomName);
    this._subs.set(key, { ...sub, userId: uid, refcount: 1 });
    logger.info(`tg-client stream attached for session ${sid} (user ${uid})`);

    return { ok: true, room: roomName, refcount: 1 };
  }

  /**
   * Decrement the refcount; tear down GramJS handlers when no windows
   * remain. Always leaves the socket from the room.
   */
  async detach(socket, sessionId, userId) {
    const sid = String(sessionId);
    const uid = String(userId);
    const key = `${uid}:${sid}`;
    const roomName = _roomName(uid, sid);
    try {
      socket.leave(roomName);
    } catch (_) { /* socket already gone */ }

    const entry = this._subs.get(key);
    if (!entry) return { ok: true, refcount: 0 };
    entry.refcount = Math.max(0, entry.refcount - 1);
    if (entry.refcount > 0) {
      this._subs.set(key, entry);
      return { ok: true, refcount: entry.refcount };
    }
    try {
      await Promise.resolve(entry.unsubscribe());
    } catch (err) {
      logger.warn(`tg-client unsubscribe error for ${sid}: ${err.message}`);
    }
    this._subs.delete(key);
    logger.info(`tg-client stream detached for session ${sid} (user ${uid})`);
    return { ok: true, refcount: 0 };
  }

  /**
   * Tear down the GramJS subscription regardless of refcount. Used when
   * the underlying TelegramClient is being shut down (logout, recover,
   * restart).
   */
  async forceDetachAll(sessionId) {
    const sid = String(sessionId);
    const targets = [];
    for (const [k, v] of this._subs.entries()) {
      if (k.endsWith(`:${sid}`)) targets.push([k, v]);
    }
    for (const [k, entry] of targets) {
      try {
        await Promise.resolve(entry.unsubscribe());
      } catch (err) {
        logger.debug(`tg-client unsubscribe error for ${k}: ${err.message}`);
      }
      this._subs.delete(k);
    }
  }

  /**
   * Install NewMessage + Raw handlers on the GramJS client and return
   * a single unsubscribe function that removes both.
   * @private
   */
  async _installHandlers(sid, uid, roomName) {
    const io = global.io;
    if (!io) {
      logger.warn('global.io not initialised; tg-client stream will be inert');
    }

    // Helper: emit only when io is available so test environments / CLI
    // tools that load the service without booting the HTTP server don't
    // crash on the first event.
    const emit = (event, payload) => {
      if (!io) return;
      try {
        io.to(roomName).emit(event, payload);
      } catch (err) {
        logger.debug(`io.emit failed: ${err.message}`);
      }
    };

    // 1. NewMessage — most common, easiest to map.
    const offNewMsg = await tgService.addNewMessageHandler(sid, async (event) => {
      try {
        const msg = event.message;
        if (!msg) return;

        // Resolve sender + chat asynchronously; fall back to the
        // raw peer ids on the message itself if entities aren't cached.
        let chatPeer = null;
        let senderInfo = null;
        try {
          const chat = await event.getChat();
          chatPeer = _peerSummary(chat);
        } catch (_) { /* ignore */ }
        try {
          const sender = await event.getSender();
          senderInfo = _peerSummary(sender);
        } catch (_) { /* ignore */ }

        const ownId = (await tgService.getMe(sid).catch(() => null))?.id || null;
        const normalized = tcService._normalizeMessage(
          msg,
          ownId != null ? Number(ownId) : null,
          chatPeer ? { [`${chatPeer.peerType}Id`]: chatPeer.peerId } : null
        );

        emit('tg-client:newMessage', {
          sessionId: sid,
          chat: chatPeer,
          sender: senderInfo,
          message: normalized,
        });

        // Push a lightweight dialog-update so the dialog list can
        // re-sort + bump its preview without re-fetching all dialogs.
        if (chatPeer) {
          emit('tg-client:dialogUpdate', {
            sessionId: sid,
            chat: chatPeer,
            lastMessage: normalized,
            unreadDelta: msg.out ? 0 : 1,
          });
        }
      } catch (err) {
        logger.debug(`tg-client newMessage handler error: ${err.message}`);
      }
    });

    // 2. Raw updates — read receipts, edits, typing.
    let offRaw = null;
    try {
      offRaw = await tgService.addRawUpdateHandler(sid, (update) => {
        try {
          const cn = update?.className || '';
          if (cn === 'UpdateEditMessage' || cn === 'UpdateEditChannelMessage') {
            const m = update.message;
            if (!m) return;
            emit('tg-client:editMessage', {
              sessionId: sid,
              message: tcService._normalizeMessage(m, null, null),
            });
            return;
          }
          if (cn === 'UpdateDeleteMessages' || cn === 'UpdateDeleteChannelMessages') {
            const ids = Array.isArray(update.messages)
              ? update.messages.map((v) => tcService._toIdNum(v)).filter((v) => v != null)
              : [];
            if (ids.length === 0) return;
            const peer = cn === 'UpdateDeleteChannelMessages'
              ? { peerType: 'channel', peerId: tcService._toIdNum(update.channelId) }
              : null;
            emit('tg-client:deleteMessages', {
              sessionId: sid,
              peerType: peer?.peerType || null,
              peerId: peer?.peerId || null,
              messageIds: ids,
            });
            return;
          }
          if (cn === 'UpdateChatParticipants') {
            const cp = update.participants;
            if (!cp) return;
            emit('tg-client:participantUpdate', {
              sessionId: sid,
              peerType: 'chat',
              peerId: tcService._toIdNum(cp.chatId),
              action: 'refresh',
            });
            return;
          }
          if (cn === 'UpdateChannelParticipant') {
            emit('tg-client:participantUpdate', {
              sessionId: sid,
              peerType: 'channel',
              peerId: tcService._toIdNum(update.channelId),
              userId: tcService._toIdNum(update.userId),
              action: update.newParticipant ? 'change' : 'remove',
              newRights: update.newParticipant?.adminRights ? 'admin'
                : update.newParticipant?.bannedRights ? 'banned'
                : update.newParticipant ? 'member'
                : null,
            });
            return;
          }
          if (cn === 'UpdateChatParticipantAdd' || cn === 'UpdateChatParticipantDelete' || cn === 'UpdateChatParticipantAdmin') {
            emit('tg-client:participantUpdate', {
              sessionId: sid,
              peerType: 'chat',
              peerId: tcService._toIdNum(update.chatId),
              userId: tcService._toIdNum(update.userId),
              action: cn === 'UpdateChatParticipantAdd' ? 'add'
                : cn === 'UpdateChatParticipantDelete' ? 'remove'
                : 'admin',
            });
            return;
          }
          if (cn === 'UpdateReadHistoryInbox' || cn === 'UpdateReadHistoryOutbox') {
            const peer = _peerFromUpdate(update.peer);
            emit('tg-client:readHistory', {
              sessionId: sid,
              direction: cn === 'UpdateReadHistoryInbox' ? 'inbox' : 'outbox',
              peer,
              maxId: tcService._toIdNum(update.maxId),
              stillUnread: tcService._toIdNum(update.stillUnreadCount),
            });
            return;
          }
          if (cn === 'UpdateReadChannelInbox' || cn === 'UpdateReadChannelOutbox') {
            emit('tg-client:readHistory', {
              sessionId: sid,
              direction: cn === 'UpdateReadChannelInbox' ? 'inbox' : 'outbox',
              peer: { peerType: 'channel', peerId: tcService._toIdNum(update.channelId) },
              maxId: tcService._toIdNum(update.maxId),
              stillUnread: tcService._toIdNum(update.stillUnreadCount),
            });
            return;
          }
          if (cn === 'UpdateDraftMessage') {
            const peer = _peerFromUpdate(update.peer);
            if (!peer) return;
            const d = update.draft;
            const isEmpty = !d || d.className === 'DraftMessageEmpty';
            emit('tg-client:draftUpdate', {
              sessionId: sid,
              peer,
              draft: isEmpty
                ? null
                : {
                    text: d.message || '',
                    date: d.date ? new Date(d.date * 1000).toISOString() : null,
                    replyToMsgId: tcService._toIdNum(
                      d.replyTo?.replyToMsgId ?? d.replyToMsgId ?? null
                    ),
                    noWebpage: !!d.noWebpage,
                  },
            });
            return;
          }
          if (cn === 'UpdatePinnedMessages' || cn === 'UpdatePinnedChannelMessages') {
            const peer = cn === 'UpdatePinnedChannelMessages'
              ? { peerType: 'channel', peerId: tcService._toIdNum(update.channelId) }
              : _peerFromUpdate(update.peer);
            const messageIds = Array.isArray(update.messages)
              ? update.messages.map((v) => tcService._toIdNum(v)).filter((v) => v != null)
              : [];
            if (!peer || messageIds.length === 0) return;
            emit('tg-client:pinnedUpdate', {
              sessionId: sid,
              peer,
              messageIds,
              pinned: !!update.pinned,
            });
            return;
          }
          if (cn === 'UpdateUserTyping' || cn === 'UpdateChannelUserTyping' ||
              cn === 'UpdateChatUserTyping') {
            emit('tg-client:typing', {
              sessionId: sid,
              peer: _peerFromUpdate(update.peer || {
                userId: update.userId,
                channelId: update.channelId,
                chatId: update.chatId,
              }),
              fromId: tcService._toIdNum(
                update.userId || update.fromId?.userId || null
              ),
              action: update.action?.className || null,
            });
            return;
          }
        } catch (err) {
          logger.debug(`tg-client raw update handler error: ${err.message}`);
        }
      });
    } catch (err) {
      logger.warn(`Failed to install raw handler for session ${sid}: ${err.message}`);
    }

    return {
      unsubscribe: async () => {
        try { await Promise.resolve(offNewMsg && offNewMsg()); } catch (_) {}
        try { await Promise.resolve(offRaw && offRaw()); } catch (_) {}
      },
    };
  }
}

function _peerSummary(entity) {
  if (!entity) return null;
  const peerType = tcService._peerTypeOf(entity);
  if (!peerType) return null;
  const id = tcService._toIdNum(entity.id);
  if (id == null) return null;
  return {
    peerType,
    peerId: id,
    title: tcService._entityTitle(entity),
    username: entity.username || null,
    photoId: entity.photo?.photoId ? String(entity.photo.photoId) : null,
    hasPhoto: !!(entity.photo && (entity.photo.photoId || entity.photo.photoSmall)),
  };
}

function _peerFromUpdate(peer) {
  if (!peer) return null;
  if (peer.userId) return { peerType: 'user', peerId: tcService._toIdNum(peer.userId) };
  if (peer.chatId) return { peerType: 'chat', peerId: tcService._toIdNum(peer.chatId) };
  if (peer.channelId) return { peerType: 'channel', peerId: tcService._toIdNum(peer.channelId) };
  return null;
}

module.exports = new TelegramClientStream();
