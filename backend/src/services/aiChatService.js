/**
 * AiChatService — orchestrator for the AI auto-responder.
 *
 * Responsibilities:
 *   - Decide whether an incoming GramJS NewMessage event should trigger AI.
 *   - Maintain per-session and per-chat settings.
 *   - Persist incoming messages to per-chat memory.
 *   - Enqueue a BullMQ job for the actual CupidBot call + reply.
 *
 * The heavy work (CupidBot HTTP request, Telegram send, logging) is delegated
 * to the queue worker so the GramJS update dispatcher never blocks.
 */

const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');
const aiMemoryService = require('./aiMemoryService');
const aiSessionManager = require('./aiSessionManager');
const aiChatQueue = require('../queues/aiChatQueue');
const tcService = require('./telegramClientService');
const logger = require('../utils/logger');

const DEFAULT_CONFIG = {
  replyDelayMs: 3000,
  replyDelayJitterMs: 2000,
  memoryMessageLimit: 100,
  // AI auto-responder is restricted to personal (DM) chats only.
  // Groups, channels, and bot accounts are intentionally excluded.
  allowedPeerTypes: ['user'],
  allowGroups: false,
  allowChannels: false,
  skipBots: true,
  cupidbot: {
    app: 'telegram',
    isAPI: true,
    brand: 'cupidbotofm',
    isOF: true,
    chatStyle: 'youth',
    responseLanguage: 'en',
  },
};

function _mergeConfig(config) {
  // AI auto-responder is institutional-grade restricted to personal DMs.
  // Groups, channels, and bot accounts are intentionally excluded even if a
  // stored config row tries to enable them — this keeps the feature safe for
  // large-scale panels where accidental group/channel replies are dangerous.
  return {
    ...DEFAULT_CONFIG,
    ...config,
    allowedPeerTypes: ['user'],
    allowGroups: false,
    allowChannels: false,
    skipBots: config.skipBots !== false,
    cupidbot: { ...DEFAULT_CONFIG.cupidbot, ...(config.cupidbot || {}) },
  };
}

class AiChatService {
  /**
   * Main entry point called by the persistent GramJS NewMessage handler.
   *
   * @param {string|number} sessionId
   * @param {object} event - GramJS NewMessage event
   * @returns {Promise<object>} { handled: boolean, reason?: string }
   */
  async handleIncomingMessage(sessionId, event) {
    const sid = Number(sessionId);
    const msg = event?.message;
    if (!msg) {
      return { handled: false, reason: 'no_message' };
    }

    // Ignore outgoing messages so the AI never replies to itself.
    if (msg.out) {
      return { handled: false, reason: 'outgoing' };
    }

    logger.info(`AI: incoming message received session=${sid} msgId=${msg.id}`);

    let chat;
    try {
      chat = await event.getChat();
    } catch (err) {
      logger.debug(`aiChatService: getChat failed for session ${sid}: ${err.message}`);
    }
    if (!chat) {
      return { handled: false, reason: 'no_chat' };
    }

    const peerType = tcService._peerTypeOf(chat);
    const peerId = tcService._toIdNum(chat.id);
    if (!peerType || peerId == null) {
      return { handled: false, reason: 'bad_peer' };
    }

    const sessionSettings = await this.getSessionSettings(sid);
    if (!sessionSettings.enabled) {
      return { handled: false, reason: 'session_disabled' };
    }

    // Per-chat override. A row with enabled=FALSE disables this chat;
    // no row means default enabled. The chat config (if any) is layered
    // on top of the session-level config so an operator can opt a single
    // chat into group/channel replies even when the session default is
    // more restrictive.
    const chatOverride = await this.getChatSettings(sid, peerType, peerId);
    if (chatOverride && chatOverride.enabled === false) {
      return { handled: false, reason: 'chat_disabled' };
    }

    const cfg = _mergeConfig({
      ...sessionSettings.config,
      ...(chatOverride?.config || {}),
    });

    // Peer-type / group / channel filters.
    if (!cfg.allowedPeerTypes.includes(peerType)) {
      return { handled: false, reason: 'peer_type_filtered' };
    }
    if (peerType === 'chat' && cfg.allowGroups !== true) {
      return { handled: false, reason: 'groups_disabled' };
    }
    if (peerType === 'channel' && cfg.allowChannels !== true) {
      return { handled: false, reason: 'channels_disabled' };
    }

    const sender = await event.getSender().catch(() => null);
    const title = tcService._entityTitle(sender || chat) || '';
    const username = (sender || chat).username || '';

    // AI auto-responder: skip bot accounts (Telegram users with bot=true).
    if (cfg.skipBots && sender && sender.bot === true) {
      logger.info(`aiChatService: dropping message ${msg.id}: sender_is_bot`);
      return { handled: false, reason: 'sender_is_bot' };
    }

    const memoryItem = {
      id: `tg-${msg.id}`,
      telegramMessageId: tcService._toIdNum(msg.id),
      timestamp: Date.now(),
      msg: msg.message || '',
      isIncoming: true,
      medias: [],
    };

    await aiMemoryService.append(sid, peerType, peerId, memoryItem, cfg.memoryMessageLimit);

    const recipient = {
      id: String(peerId),
      name: title,
      username,
      bio: '',
      location: '',
    };

    const userId = await this._resolveUserId(sid);
    if (!userId) {
      return { handled: false, reason: 'no_user_id' };
    }

    await aiChatQueue.add('generate-reply', {
      sessionId: sid,
      userId,
      peerType,
      peerId,
      incomingMessage: memoryItem,
      recipient,
      config: cfg,
    });

    return { handled: true };
  }

  /**
   * Fetch or create session-level AI settings.
   */
  async getSessionSettings(sessionId) {
    const sid = Number(sessionId);
    const { rows } = await pool.query(
      `SELECT enabled, config FROM ai_session_settings WHERE session_id = $1`,
      [sid]
    );
    if (rows.length) {
      return { enabled: rows[0].enabled, config: rows[0].config || {} };
    }
    return { enabled: false, config: {} };
  }

  /**
   * Enable/disable AI for a session and persist default config.
   * Also attaches/detaches the persistent GramJS listener.
   *
   * Attach is attempted BEFORE the DB write so a listener failure cannot
   * leave the row marked enabled while no listener is actually running.
   * If attach throws we surface a 502 AppError and the DB row is left
   * untouched (existing rows keep their previous enabled flag; new rows
   * are not created).
   *
   * If the DB write fails after a successful attach we detach again to
   * keep DB and listener state consistent.
   *
   * @returns {Promise<{ sessionId: number, enabled: boolean, config: object, attached: boolean }>}
   */
  async setSessionEnabled(sessionId, userId, enabled, config = {}) {
    const sid = Number(sessionId);
    await this._authorizeSession(sid, userId);

    const cfg = _mergeConfig(config);

    let attached = false;
    if (enabled) {
      let attachResult;
      try {
        attachResult = await aiSessionManager.attach(sid);
      } catch (attachErr) {
        throw new AppError(
          `Failed to attach AI listener for session ${sid}: ${attachErr.message}`,
          502,
          'AI_LISTENER_ATTACH_FAILED'
        );
      }
      // `already_attached` from a prior successful toggle still counts as
      // the listener being live for this session; the only failure mode
      // that falls through is throw, which is handled above.
      attached = !!attachResult?.attached;
    } else {
      await aiSessionManager.detach(sid);
      attached = false;
    }

    try {
      await pool.query(
        `INSERT INTO ai_session_settings (session_id, enabled, config, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (session_id) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             config = EXCLUDED.config,
             updated_at = NOW()`,
        [sid, !!enabled, JSON.stringify(cfg)]
      );
    } catch (dbErr) {
      // Roll back the listener we just attached so DB and runtime stay
      // in sync. Don't mask the original DB error.
      if (enabled) {
        await aiSessionManager.detach(sid).catch((detachErr) => {
          logger.warn(
            `Failed to detach AI listener after DB write failure for session ${sid}: ${detachErr.message}`
          );
        });
      }
      throw dbErr;
    }

    return { sessionId: sid, enabled: !!enabled, config: cfg, attached };
  }

  /**
   * Fetch per-chat override, or null when no override exists.
   */
  async getChatSettings(sessionId, peerType, peerId) {
    const sid = Number(sessionId);
    const { rows } = await pool.query(
      `SELECT enabled, config FROM ai_chat_settings
       WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3`,
      [sid, peerType, peerId]
    );
    if (rows.length) {
      return { enabled: rows[0].enabled, config: rows[0].config || {} };
    }
    return null;
  }

  /**
   * Set per-chat override.
   */
  async setChatEnabled(sessionId, userId, peerType, peerId, enabled, config = {}) {
    const sid = Number(sessionId);
    await this._authorizeSession(sid, userId);

    // Ensure the session settings row exists so the chat override has a
    // logical parent even if the operator toggled a chat before enabling
    // the session.
    await pool.query(
      `INSERT INTO ai_session_settings (session_id, enabled, config, updated_at)
       VALUES ($1, FALSE, '{}', NOW())
       ON CONFLICT (session_id) DO NOTHING`,
      [sid]
    );

    await pool.query(
      `INSERT INTO ai_chat_settings (session_id, peer_type, peer_id, enabled, config, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (session_id, peer_type, peer_id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           config = EXCLUDED.config,
           updated_at = NOW()`,
      [sid, peerType, peerId, !!enabled, JSON.stringify(config)]
    );

    // When a chat override is enabled for the first time on an empty
    // memory row, opportunistically backfill from recent Telegram
    // history so the first AI reply has context. Fire-and-forget so the
    // toggle responds quickly; failures are logged but do not roll back
    // the override write.
    if (enabled) {
      this._maybeAutoSeedOnEnable(sid, userId, peerType, peerId).catch((err) => {
        logger.warn(
          `seedChatMemory auto-backfill failed for ${sid}/${peerType}/${peerId}: ${err && err.message}`
        );
      });
    }

    return { sessionId: sid, peerType, peerId, enabled: !!enabled };
  }

  async _maybeAutoSeedOnEnable(sessionId, userId, peerType, peerId) {
    const sid = Number(sessionId);
    const pid = Number(peerId);
    const existing = await aiMemoryService.getMessages(sid, peerType, pid, 1);
    if (Array.isArray(existing) && existing.length > 0) return false;
    await this.seedChatMemory(sid, userId, peerType, pid, { limit: 100 });
    return true;
  }

  /**
   * List chat overrides for a session.
   */
  async listChatSettings(sessionId, userId, opts = {}) {
    const sid = Number(sessionId);
    await this._authorizeSession(sid, userId);
    const limit = Math.max(1, Math.min(200, parseInt(opts.limit, 10) || 50));
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    const { rows } = await pool.query(
      `SELECT peer_type, peer_id, enabled, config, created_at, updated_at
       FROM ai_chat_settings
       WHERE session_id = $1
       ORDER BY updated_at DESC
       LIMIT $2 OFFSET $3`,
      [sid, limit, offset]
    );
    return rows;
  }

  /**
   * Clear memory for a chat.
   */
  async clearChatMemory(sessionId, userId, peerType, peerId) {
    const sid = Number(sessionId);
    await this._authorizeSession(sid, userId);
    await aiMemoryService.clear(sid, peerType, peerId);
    return { sessionId: sid, peerType, peerId, cleared: true };
  }

  /**
   * Seed a chat's AI memory from recent Telegram history.
   *
   * Fetches up to 100 messages from the peer via telegramClientService,
   * normalizes each to the memory shape used by append(), and bulk-writes
   * the result via aiMemoryService.seedFromHistory.
   *
   * This is invoked explicitly via POST /seed and also (optionally,
   * fire-and-forget) the first time an operator enables a chat override
   * on a memory row that is still empty.
   *
   * @param {string|number} sessionId
   * @param {string|number} userId
   * @param {string} peerType
   * @param {string|number} peerId
   * @param {object} [opts]
   * @param {number} [opts.limit=100]
   * @returns {Promise<{ sessionId: number, peerType: string, peerId: number, seeded: number }>}
   */
  async seedChatMemory(sessionId, userId, peerType, peerId, opts = {}) {
    const sid = Number(sessionId);
    const pid = Number(peerId);
    await this._authorizeSession(sid, userId);

    const limit = Math.min(
      Math.max(1, parseInt(opts.limit, 10) || 100),
      100
    );

    const result = await tcService.getMessages(sid, userId, peerType, pid, {
      limit,
    });

    const raw = Array.isArray(result?.messages) ? result.messages : [];

    const memoryItems = raw.map((m) => {
      const ts = m && m.date ? new Date(m.date).getTime() : Date.now();
      return {
        id: m && m.id != null ? `tg-${m.id}` : null,
        telegramMessageId: m && m.id != null ? Number(m.id) : null,
        timestamp: Number.isFinite(ts) ? ts : Date.now(),
        msg: (m && m.text) || '',
        isIncoming: !(m && m.out),
        medias: m && m.mediaKind ? [{ kind: m.mediaKind, hasMedia: !!m.hasMedia }] : [],
      };
    });

    await aiMemoryService.seedFromHistory(sid, peerType, pid, memoryItems);

    return {
      sessionId: sid,
      peerType,
      peerId: pid,
      seeded: memoryItems.length,
    };
  }

  /**
   * List recent AI response logs for a session.
   */
  async listLogs(sessionId, userId, opts = {}) {
    const sid = Number(sessionId);
    await this._authorizeSession(sid, userId);
    const limit = Math.max(1, Math.min(200, parseInt(opts.limit, 10) || 50));
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    const { rows } = await pool.query(
      `SELECT id, peer_type, peer_id, incoming_msg_id, status, error_message, created_at
       FROM ai_response_logs
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [sid, limit, offset]
    );
    return rows;
  }

  /**
   * Verify the session belongs to the calling user.
   */
  async _authorizeSession(sessionId, userId) {
    const { rows } = await pool.query(
      `SELECT id FROM sessions WHERE id = $1 AND user_id = $2 AND platform = 'telegram'`,
      [sessionId, userId]
    );
    if (!rows.length) {
      throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
    }
  }

  async _resolveUserId(sessionId) {
    const { rows } = await pool.query(
      `SELECT user_id FROM sessions WHERE id = $1`,
      [sessionId]
    );
    return rows[0]?.user_id;
  }
  /**
   * Hard-delete AI response logs older than `retentionDays`.
   */
  async pruneOldLogs(retentionDays = 30) {
    const days = Math.max(1, parseInt(retentionDays, 10) || 30);
    const { rowCount } = await pool.query(
      `DELETE FROM ai_response_logs WHERE created_at < NOW() - INTERVAL '${days} days'`
    );
    logger.info(`Pruned ${rowCount} old AI response logs`);
    return { pruned: rowCount };
  }
}

module.exports = new AiChatService();
