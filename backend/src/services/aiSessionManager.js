/**
 * AiSessionManager — manages AI real-time event listeners for sessions.
 *
 * Uses GramJS NewMessage event handlers for real-time message detection.
 * Falls back to polling for sessions that don't receive updates (stale sessions).
 * Provides robust session lifecycle management with automatic reconnection.
 */

const { pool } = require('../config/database');
const tgService = require('./telegramService');
const logger = require('../utils/logger');

class AiSessionManager {
  constructor() {
    // Active session handlers: sessionId -> { handler, pollFallback, attachedAt }
    this._sessions = new Map();

    // Per-session message ID tracking for deduplication
    this._lastMsgIds = new Map(); // `${sessionId}:${peerType}:${peerId}` -> lastMsgId

    // Session reconnection state
    this._reconnectTimers = new Map();
    this._maxReconnectAttempts = 5;
    this._reconnectBaseDelay = 5000; // 5 seconds

    // Polling fallback interval (for stale sessions)
    this._pollIntervalMs = 10000;

    logger.info('AiSessionManager initialized with real-time event listeners');
  }

  /**
   * Attach a real-time NewMessage listener for `sessionId`.
   * Falls back to polling if the session doesn't receive updates.
   *
   * @param {string|number} sessionId
   * @returns {Promise<{ attached: boolean, method: 'realtime'|'polling', reason?: string }>}
   */
  async attach(sessionId) {
    const sid = String(sessionId);
    if (this._sessions.has(sid)) {
      const existing = this._sessions.get(sid);
      return { attached: false, method: existing.method, reason: 'already_attached' };
    }

    let panelUserId;
    try {
      const { rows } = await pool.query(
        'SELECT user_id FROM sessions WHERE id = $1 LIMIT 1',
        [sid]
      );
      if (!rows.length) {
        throw new Error(`Session ${sid} not found in DB`);
      }
      panelUserId = rows[0].user_id;
      if (!panelUserId) {
        throw new Error(`Session ${sid} has no user_id`);
      }
    } catch (err) {
      logger.error(`AI attach: cannot resolve user_id for session ${sid}: ${err.message}`);
      throw new Error(`AI attach: cannot resolve user_id for session ${sid}: ${err.message}`);
    }

    const userIdStr = String(panelUserId);

    try {
      // Ensure the Telegram client is connected
      await tgService._ensureConnected(sid);

      const entry = tgService.clients.get(sid);
      if (!entry || !entry.client) {
        throw new Error(`Telegram client not available for session ${sid}`);
      }

      const client = entry.client;

      // Set up real-time NewMessage handler
      const handler = async (event) => {
        try {
          await this._handleNewMessage(sid, userIdStr, event);
        } catch (err) {
          logger.warn(`AI realtime handler error for ${sid}: ${err.message}`);
        }
      };

      // Register the event handler
      client.addEventHandler(handler, new (require('telegram/events')).NewMessage({ incoming: true }));

      // Set up a polling fallback that activates if no messages received for 2 minutes
      const pollFallback = this._startPollFallback(sid, userIdStr);

      this._sessions.set(sid, {
        handler,
        // Keep a reference to the exact client the handler was bound to.
        // If the heartbeat later rebuilds the GramJS client (proxy swap,
        // socket revive), this lets us detect the stale binding and
        // re-attach ONLY then — instead of churning every cycle.
        client,
        pollFallback,
        method: 'realtime',
        attachedAt: Date.now(),
        reconnectAttempts: 0,
        lastMessageAt: Date.now(),
      });

      // Set up connection monitoring
      this._setupConnectionMonitoring(sid, userIdStr);

      logger.info(`AI real-time listener attached for session ${sid}`);
      return { attached: true, method: 'realtime' };
    } catch (err) {
      logger.error(`AI listener attach failed for session ${sid}: ${err.message}`);
      throw new Error(`AI listener attach failed for session ${sid}: ${err.message}`);
    }
  }

  /**
   * Handle incoming NewMessage event from GramJS.
   */
  async _handleNewMessage(sessionId, userIdStr, event) {
    const sid = String(sessionId);
    const sessionData = this._sessions.get(sid);
    if (sessionData) {
      sessionData.lastMessageAt = Date.now();
      // If we were polling, switch back to realtime
      if (sessionData.method === 'polling') {
        this._stopPollFallback(sid);
        sessionData.method = 'realtime';
        sessionData.pollFallback = null;
        logger.info(`AI session ${sid} switched from polling to realtime`);
      }
    }

    const msg = event?.message;
    if (!msg) return;

    // Skip outgoing messages
    if (msg.out) return;

    // Resolve peer info
    let peerType = 'user';
    let peerId = null;
    let accessHash = null;

    try {
      const chat = await event.getChat();
      if (chat) {
        if (chat.className === 'User') {
          peerType = 'user';
          peerId = chat.id ? Number(chat.id) : null;
          accessHash = chat.accessHash ? String(chat.accessHash) : null;
        } else if (chat.className === 'Chat') {
          peerType = 'chat';
          peerId = chat.id ? Number(chat.id) : null;
        } else if (chat.className === 'Channel') {
          peerType = chat.megagroup ? 'chat' : 'channel';
          peerId = chat.id ? Number(chat.id) : null;
        }
      }
    } catch (err) {
      logger.debug(`AI: getChat failed for session ${sid}: ${err.message}`);
    }

    // Fallback to message peerId/fromId
    if (!peerId) {
      const rawPeer = msg.peerId || msg.fromId || msg.chatId;
      if (rawPeer) {
        peerId = rawPeer.userId || rawPeer.chatId || rawPeer.channelId;
        if (rawPeer.userId) peerType = 'user';
        else if (rawPeer.chatId) peerType = 'chat';
        else if (rawPeer.channelId) peerType = 'channel';
        peerId = peerId ? Number(peerId) : null;
      }
    }

    if (!peerType || peerId == null) {
      logger.warn(`AI: bad_peer for session ${sid}`);
      return;
    }

    // AI only handles DMs (user peerType)
    if (peerType !== 'user') return;

    // Deduplication: track last message ID per chat
    const key = `${sid}:${peerType}:${peerId}`;
    const msgId = msg.id ? Number(msg.id) : null;
    if (msgId) {
      const lastId = this._lastMsgIds.get(key) || 0;
      if (msgId <= lastId) return;
      this._lastMsgIds.set(key, msgId);
    }

    // Create fake event for aiChatService, include accessHash if available
    const fakeEvent = {
      message: msg,
      _peer: { peerType, peerId, accessHash },
    };

    const aiChatService = require('./aiChatService');
    try {
      await aiChatService.handleIncomingMessage(sid, fakeEvent);
    } catch (err) {
      logger.warn(`AI handler error for ${key}: ${err.message}`);
    }
  }

  /**
   * Start polling fallback for a session.
   */
  _startPollFallback(sessionId, userIdStr) {
    const sid = String(sessionId);
    const poll = setInterval(async () => {
      const sessionData = this._sessions.get(sid);
      if (!sessionData) return;

      const timeSinceLastMsg = Date.now() - (sessionData.lastMessageAt || sessionData.attachedAt);
      // Only poll if no messages received for 2 minutes (likely stale session)
      if (timeSinceLastMsg < 120000) return;

      if (sessionData.method !== 'polling') {
        logger.info(`AI session ${sid} switching to polling fallback (no messages for ${Math.round(timeSinceLastMsg/1000)}s)`);
        sessionData.method = 'polling';
      }

      try {
        await this._pollOnce(sid, userIdStr);
      } catch (err) {
        logger.warn(`AI poll fallback error for ${sid}: ${err.message}`);
      }
    }, this._pollIntervalMs);

    if (poll.unref) poll.unref();
    return poll;
  }

  /**
   * Stop polling fallback for a session.
   */
  _stopPollFallback(sessionId) {
    const sid = String(sessionId);
    const sessionData = this._sessions.get(sid);
    if (sessionData?.pollFallback) {
      clearInterval(sessionData.pollFallback);
      sessionData.pollFallback = null;
    }
  }

  /**
   * Single polling iteration for a session.
   */
  async _pollOnce(sessionId, userIdStr) {
    const sid = String(sessionId);
    const entry = tgService.clients.get(sid);
    if (!entry || !entry.client) return;

    const client = entry.client;

    // Get dialogs directly from GramJS client
    let dialogs;
    try {
      dialogs = await client.getDialogs({ limit: 200 });
    } catch (err) {
      logger.warn(`AI poll getDialogs failed for ${sid}: ${err.message}`);
      return;
    }

    for (const dlg of dialogs || []) {
      const entity = dlg.entity;
      if (!entity) continue;

      let peerType = 'user';
      let peerId = null;

      if (entity.className === 'User') {
        peerType = 'user';
        peerId = entity.id ? Number(entity.id) : null;
      } else if (entity.className === 'Chat') {
        peerType = 'chat';
        peerId = entity.id ? Number(entity.id) : null;
      } else if (entity.className === 'Channel') {
        peerType = entity.megagroup ? 'chat' : 'channel';
        peerId = entity.id ? Number(entity.id) : null;
      }

      if (peerType !== 'user' || !peerId) continue;

      try {
        // Get messages directly from GramJS
        let msgs;
        try {
          msgs = await client.getMessages(entity, { limit: 20 });
        } catch (err) {
          continue; // Skip dialogs that fail
        }

        const key = `${sid}:${peerType}:${peerId}`;
        const lastPolled = this._lastMsgIds.get(key) || 0;

        for (const msg of msgs || []) {
          if (!msg.id) continue;
          if (msg.id <= lastPolled) continue;
          if (msg.out) continue;

          if (msg.id > (this._lastMsgIds.get(key) || 0)) {
            this._lastMsgIds.set(key, msg.id);
          }

          const fakeEvent = {
            message: msg,
            _peer: { peerType, peerId },
          };

          try {
            const aiChatService = require('./aiChatService');
            await aiChatService.handleIncomingMessage(sid, fakeEvent);
          } catch (err) {
            logger.warn(`AI poll handler error for ${key}: ${err.message}`);
          }
        }
      } catch (err) {
        continue; // Skip dialogs that fail
      }
    }
  }

  /**
   * Set up connection monitoring for automatic reconnection.
   */
  _setupConnectionMonitoring(sessionId, userIdStr) {
    const sid = String(sessionId);
    const entry = tgService.clients.get(sid);
    if (!entry?.client) return;

    const client = entry.client;

    // Monitor for disconnection
    const disconnectHandler = () => {
      // Check if client is actually disconnected (not just a transient event)
      setTimeout(() => {
        const currentEntry = tgService.clients.get(sid);
        if (currentEntry?.client?.connected === false) {
          logger.warn(`AI session ${sid} confirmed disconnected, scheduling reconnect`);
          this._scheduleReconnect(sid, userIdStr);
        } else {
          logger.debug(`AI session ${sid} disconnected event fired but client still connected, ignoring`);
        }
      }, 1000); // Wait a bit to see if it reconnects automatically
    };

    client.on('disconnected', disconnectHandler);

    // Store cleanup function
    const sessionData = this._sessions.get(sid);
    if (sessionData) {
      sessionData._disconnectHandler = disconnectHandler;
    }
  }

  /**
   * Schedule a reconnection attempt.
   */
  _scheduleReconnect(sessionId, userIdStr) {
    const sid = String(sessionId);
    const sessionData = this._sessions.get(sid);
    if (!sessionData) return;

    if (sessionData.reconnectAttempts >= this._maxReconnectAttempts) {
      logger.error(`AI session ${sid} max reconnect attempts reached, giving up`);
      this.detach(sid).catch(() => {});
      return;
    }

    const delay = this._reconnectBaseDelay * Math.pow(2, sessionData.reconnectAttempts);
    sessionData.reconnectAttempts++;

    if (this._reconnectTimers.has(sid)) {
      clearTimeout(this._reconnectTimers.get(sid));
    }

    const timer = setTimeout(async () => {
      this._reconnectTimers.delete(sid);
      try {
        await this.reattach(sid);
        logger.info(`AI session ${sid} reconnected successfully`);
      } catch (err) {
        logger.error(`AI session ${sid} reconnect failed: ${err.message}`);
        this._scheduleReconnect(sid, userIdStr);
      }
    }, delay);

    if (timer.unref) timer.unref();
    this._reconnectTimers.set(sid, timer);
  }

  /**
   * Reattach a session (detach + attach).
   */
  async reattach(sessionId) {
    const sid = String(sessionId);
    await this.detach(sid);
    return this.attach(sid);
  }

  /**
   * Idempotently guarantee a live, correctly-bound listener for a session
   * WITHOUT churning. This is what the heartbeat should call every cycle
   * instead of reattach():
   *
   *   - Not attached at all        -> attach().
   *   - Attached, but the handler is bound to a STALE client (the
   *     heartbeat rebuilt the GramJS client via proxy-swap / socket
   *     revive) -> reattach() to bind the fresh client.
   *   - Attached to the CURRENT client -> no-op (this is the common case;
   *     the previous code blindly reattached here, which detached the
   *     working listener every ~60s and dropped any message that arrived
   *     during the gap — the "AI randomly stops" bug).
   *
   * @param {string|number} sessionId
   * @returns {Promise<{ ok: boolean, action: 'noop'|'attached'|'reattached', reason?: string }>}
   */
  async ensureAttached(sessionId) {
    const sid = String(sessionId);
    const data = this._sessions.get(sid);

    // Not tracked → attach fresh.
    if (!data) {
      try {
        await this.attach(sid);
        return { ok: true, action: 'attached' };
      } catch (err) {
        return { ok: false, action: 'attached', reason: err.message };
      }
    }

    // Tracked → check the binding is against the current client.
    const entry = tgService.clients.get(sid);
    const currentClient = entry && entry.client ? entry.client : null;
    if (currentClient && data.client && data.client === currentClient) {
      // Healthy and correctly bound — leave it completely alone.
      return { ok: true, action: 'noop' };
    }

    // Either the client was rebuilt (stale binding) or we can't see a
    // current client. Rebind to whatever the current client is.
    try {
      await this.reattach(sid);
      return { ok: true, action: 'reattached', reason: 'client_rebuilt' };
    } catch (err) {
      return { ok: false, action: 'reattached', reason: err.message };
    }
  }

  /**
   * Check if a session has an active listener.
   */
  isAttached(sessionId) {
    return this._sessions.has(String(sessionId));
  }

  /**
   * Get attachment info for a session.
   */
  getSessionInfo(sessionId) {
    const sid = String(sessionId);
    const data = this._sessions.get(sid);
    if (!data) return null;
    return {
      sessionId: sid,
      method: data.method,
      attachedAt: data.attachedAt,
      lastMessageAt: data.lastMessageAt,
      reconnectAttempts: data.reconnectAttempts,
    };
  }

  /**
   * Detach listener for a session.
   */
  async detach(sessionId) {
    const sid = String(sessionId);
    const sessionData = this._sessions.get(sid);
    if (!sessionData) {
      return { detached: false, reason: 'not_attached' };
    }

    // Clear reconnect timer
    if (this._reconnectTimers.has(sid)) {
      clearTimeout(this._reconnectTimers.get(sid));
      this._reconnectTimers.delete(sid);
    }

    // Stop polling fallback
    this._stopPollFallback(sid);

    // Remove GramJS event handler
    const entry = tgService.clients.get(sid);
    if (entry?.client && sessionData.handler) {
      try {
        entry.client.removeEventHandler(sessionData.handler);
      } catch (err) {
        logger.warn(`AI detach handler removal error for ${sid}: ${err.message}`);
      }
    }

    // Remove disconnect handler
    if (entry?.client && sessionData._disconnectHandler) {
      try {
        entry.client.off('disconnected', sessionData._disconnectHandler);
      } catch (_) {}
    }

    // Clean up message ID tracking
    for (const key of this._lastMsgIds.keys()) {
      if (key.startsWith(`${sid}:`)) this._lastMsgIds.delete(key);
    }

    this._sessions.delete(sid);
    logger.info(`AI listener detached for session ${sid}`);
    return { detached: true };
  }

  /**
   * Detach all sessions.
   */
  async detachAll() {
    for (const [sid] of this._sessions) {
      await this.detach(sid);
    }
    logger.info('All AI listeners detached');
  }

  /**
   * Get all active sessions info.
   */
  getAllSessions() {
    const result = [];
    for (const [sid, data] of this._sessions) {
      result.push({
        sessionId: sid,
        method: data.method,
        attachedAt: data.attachedAt,
        lastMessageAt: data.lastMessageAt,
        reconnectAttempts: data.reconnectAttempts,
      });
    }
    return result;
  }
}

module.exports = new AiSessionManager();