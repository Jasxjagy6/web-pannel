/**
 * AiChatService — orchestrator for the AI auto-responder.
 *
 * Responsibilities:
 *   - Decide whether an incoming GramJS NewMessage event should trigger AI.
 *   - Maintain per-session and per-chat settings.
 *   - Persist incoming messages to per-chat memory.
 *   - Fetch recipient profile (bio, location) from Telegram for better AI context.
 *   - Get conversation state for CupidBot API (handles confirmed messages).
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
const tgService = require('./telegramService');
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
  // AI provider selection: 'cupidbot' or 'capitalbot'
  provider: 'cupidbot',
  cupidbot: {
    app: 'telegram',
    isAPI: true,
    brand: 'cupidbotofm',
    isOF: true,
    chatStyle: 'youth',
    responseLanguage: 'en',
  },
  capitalbot: {
    modelId: 43,
    presetId: 88,
    platform: 'Telegram',
    conversationSource: 'Telegram',
    language: 'en',
    audio: true,
    video: true,
    image: true,
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
    capitalbot: { ...DEFAULT_CONFIG.capitalbot, ...(config.capitalbot || {}) },
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
      logger.warn(`AI: no_message for session ${sid}`);
      return { handled: false, reason: 'no_message' };
    }

    // Ignore outgoing messages so the AI never replies to itself.
    if (msg.out) {
      logger.warn(`AI: outgoing message for session ${sid} — skipping`);
      return { handled: false, reason: 'outgoing' };
    }

    logger.info(`AI: incoming message received session=${sid} msgId=${msg.id}`);
    logger.info(`AI: msg.out=${msg.out} msg.message='${(msg.message || '').slice(0, 60)}'`);

    // Resolve the chat peer from the message. For DM/user chats, we can
    // use msg.peerId directly. getChat() may fail for uncached entities.
    let chat = null;
    try {
      chat = await event.getChat();
    } catch (err) {
      logger.debug(`aiChatService: getChat failed for session ${sid}: ${err.message}`);
    }

    // Fallback: use the message's fromId (sender) or peerId (chat) directly.
    // GramJS Message always has fromId (a PeerUser with userId for DMs).
    // msg.peerId is also the same for DMs (the user's Telegram ID).
    // event._peer is set by the AI session manager with { peerType, peerId } from the dialog.
    const eventPeer = event?._peer || null;
    const rawPeer = chat || msg?.fromId || msg?.chatId || msg?.peerId || (eventPeer && { id: eventPeer.peerId, userId: eventPeer.peerId }) || null;
    let peerId = tcService._toIdNum(rawPeer?.id || rawPeer?.userId || eventPeer?.peerId || null);
    let peerType = tcService._peerTypeOf(rawPeer) || (eventPeer?.peerType) || 'user';
    logger.info(`AI: peerType=${peerType} peerId=${peerId}`);

    if (!peerType || peerId == null) {
      logger.warn(`AI: bad_peer for session ${sid}`);
      return { handled: false, reason: 'bad_peer' };
    }

    // Re-check: if rawPeer has userId but peerType is still 'user', proceed.
    // If rawPeer has chatId (group), override to 'chat'.
    if (!['user', 'chat', 'channel'].includes(peerType)) {
      logger.warn(`AI: bad_peerType=${peerType}`);
      return { handled: false, reason: 'bad_peer' };
    }

    const sessionSettings = await this.getSessionSettings(sid);
    logger.info(`AI: sessionSettings enabled=${sessionSettings?.enabled}`);
    if (!sessionSettings.enabled) {
      logger.warn(`AI: session_disabled for session ${sid}`);
      return { handled: false, reason: 'session_disabled' };
    }

    // Per-chat override. A row with enabled=FALSE disables this chat;
    // no row means default enabled. The chat config (if any) is layered
    // on top of the session-level config so an operator can opt a single
    // chat into group/channel replies even when the session default is
    // more restrictive.
    const chatOverride = await this.getChatSettings(sid, peerType, peerId);
    logger.info(`AI: chatOverride=${JSON.stringify(chatOverride)}`);
    if (chatOverride && chatOverride.enabled === false) {
      logger.info(`AI: chat_disabled for session ${sid} peer ${peerType}:${peerId}`);
      return { handled: false, reason: 'chat_disabled' };
    }

    const cfg = _mergeConfig({
      ...sessionSettings.config,
      ...(chatOverride?.config || {}),
    });

    // Peer-type / group / channel filters (DM-only — always pass).
    // Skip bot accounts — use msg.fromId (PeerUser) which has userId but not bot.
    // The bot check uses msg.fromId which is a Peer object, not a User entity.
    // For DMs, msg.fromId.userId is the other user's ID. This is always 'user' type.
    // Bot check: msg.fromId doesn't have bot, but event.getSender() fails for unknown
    // entities. We use msg.fromId.bot if available, else skip.
    const title = tcService._entityTitle(chat || msg.fromId) || '';
    const username = (chat || msg.fromId).username || 'john_smith2';

    // Bot check: use msg.fromId. For DMs, this is a PeerUser with userId.
    // If getSender() returns a User with bot, check it.
    let sender = null;
    try { sender = await event.getSender(); } catch {}
    const isBot = cfg.skipBots && (
      (sender && sender.bot === true) ||
      (chat && chat.bot === true)
    );
    if (isBot) {
      logger.info(`aiChatService: dropping message ${msg.id}: sender_is_bot`);
      return { handled: false, reason: 'sender_is_bot' };
    }

    // Store incoming message in memory
    const memoryItem = {
      id: `tg-${msg.id}`,
      telegramMessageId: tcService._toIdNum(msg.id),
      timestamp: Date.now(),
      msg: msg.message || '',
      isIncoming: true,
      medias: [],
    };

    await aiMemoryService.append(sid, peerType, peerId, memoryItem, cfg.memoryMessageLimit);

    // Fetch recipient profile from Telegram for better AI context
    const recipientProfile = await this._getRecipientProfile(sid, peerType, peerId, chat);
    await aiMemoryService.setRecipientProfile(sid, peerType, peerId, recipientProfile);

    // Get accessHash for entity resolution when sending replies
    let accessHash = null;
    if (chat && chat.accessHash != null) {
      accessHash = String(chat.accessHash);
    } else if (msg?.fromId?.accessHash != null) {
      accessHash = String(msg.fromId.accessHash);
    } else if (msg?.peerId?.accessHash != null) {
      accessHash = String(msg.peerId.accessHash);
    }

    const recipient = {
      id: String(peerId),
      name: recipientProfile.name || title,
      username: recipientProfile.username || username,
      bio: recipientProfile.bio || '',
      location: recipientProfile.location || '',
      accessHash: accessHash || '',
    };

    // Fetch the bot's own profile for CupidBot context
    const botProfile = await this._getBotProfile(sid);

    const userId = await this._resolveUserId(sid);
    logger.info(`AI: userId=${userId}`);
    if (!userId) {
      logger.warn(`AI: no_user_id for session ${sid}`);
      return { handled: false, reason: 'no_user_id' };
    }

    // Get conversation state for CupidBot (includes unconfirmed AI messages + new user messages)
    const conversationState = await aiMemoryService.getConversationState(sid, peerType, peerId, cfg.memoryMessageLimit);
    const confirmedMessages = await this._getConfirmedMessageIds(sid, peerType, peerId);

    logger.info(`AI: enqueuing job for session ${sid} peer ${peerType}:${peerId}, messagesForCupidBot=${conversationState.messages.length}`);
    await aiChatQueue.add('generate-reply', {
      sessionId: sid,
      userId,
      peerType,
      peerId,
      incomingMessage: memoryItem,
      recipient,
      config: cfg,
      conversationState: {
        messages: conversationState.messages,
        lastExchange: conversationState.lastExchange,
      },
      confirmedMessageIds: confirmedMessages,
      botProfile,
    });

    logger.info(`AI: job enqueued — returning handled:true`);
    return { handled: true };
  }

  /**
   * Get recipient profile (bio, location) from Telegram for better AI context.
   */
  async _getRecipientProfile(sessionId, peerType, peerId, chat) {
    const profile = { name: '', username: '', bio: '', location: '' };

    try {
      let entity = chat;
      if (!entity) {
        const entry = tcService.clients.get(String(sessionId));
        if (entry?.client) {
          const peerInput = tcService._buildPeerInput(peerType, peerId);
          entity = await entry.client.getEntity(peerInput);
        }
      }

      if (entity) {
        if (entity.className === 'User') {
          profile.name = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
          profile.username = entity.username || '';
          // Try to get full user info for bio
          try {
            const fullUser = await tcService.getUserInfo(sessionId, peerId);
            if (fullUser?.bio) profile.bio = fullUser.bio;
          } catch (e) {
            // Bio not available, use empty
          }
        } else if (entity.className === 'Channel' || entity.className === 'Chat') {
          profile.name = entity.title || '';
          profile.username = entity.username || '';
        }
      }
    } catch (err) {
      logger.debug(`Failed to get recipient profile for ${sessionId}/${peerType}/${peerId}: ${err.message}`);
    }

    return profile;
  }

  /**
   * Get the bot's own profile (firstName, lastName, username) for CupidBot context.
   * This is the identity of the Telegram account running the AI.
   */
  async _getBotProfile(sessionId) {
    const profile = { name: '', username: '', firstName: '', lastName: '' };

    try {
      const me = await tgService.getMe(sessionId);
      if (me) {
        profile.firstName = me.firstName || '';
        profile.lastName = me.lastName || '';
        profile.name = [me.firstName, me.lastName].filter(Boolean).join(' ').trim();
        profile.username = me.username || '';
      }
    } catch (err) {
      logger.debug(`Failed to get bot profile for ${sessionId}: ${err.message}`);
    }

    return profile;
  }

  /**
   * Get confirmed message IDs from recent response logs.
   * These are AI messages that were successfully sent and need to be confirmed to CupidBot.
   */
  async _getConfirmedMessageIds(sessionId, peerType, peerId) {
    try {
      const { rows } = await pool.query(
        `SELECT incoming_msg_id FROM ai_response_logs
         WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3 AND status = 'sent'
         ORDER BY created_at DESC LIMIT 50`,
        [sessionId, peerType, peerId]
      );
      // We track outgoing message IDs in a different way - for now return empty
      // The worker will track confirmed messages
      return [];
    } catch (err) {
      logger.warn(`Failed to get confirmed message IDs: ${err.message}`);
      return [];
    }
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
   * -----------------------------------------------------------------
   * AI activity tracking (analytics over ai_response_logs)
   * -----------------------------------------------------------------
   *
   * Everything below reads the existing audit trail -- no new tables.
   * `request_payload.incomingMessage.msg` holds the user's message and
   * `response_payload.text` holds the exact message the AI sent, so the
   * tracking surface works over ALL historical records too.
   */

  /**
   * Extract the AI's sent text from a stored response_payload, tolerating
   * the couple of shapes the workers have written over time.
   */
  _extractAiText(responsePayload) {
    const rp = responsePayload || {};
    if (typeof rp.text === 'string' && rp.text.trim()) return rp.text;
    const raw = rp.rawResponse || {};
    if (Array.isArray(raw.messages) && raw.messages.length) {
      return raw.messages.filter(Boolean).join('\n');
    }
    if (Array.isArray(raw.content) && raw.content.length) {
      return raw.content
        .map((c) => (c && typeof c.content === 'string' ? c.content : ''))
        .filter(Boolean)
        .join('\n');
    }
    if (typeof raw.content === 'string' && raw.content.trim()) return raw.content;
    return '';
  }

  /**
   * A single owner-wide tracking summary: totals across every Telegram
   * session the user owns, plus a per-session breakdown. Powers the
   * "how many convos did the AI do and what did it send" overview.
   *
   * @param {number} userId
   * @param {object} [opts] { sessionId?, since?, until? }
   */
  async getTrackingOverview(userId, opts = {}) {
    const params = [userId];
    const where = [`s.user_id = $1`, `s.platform = 'telegram'`];

    if (opts.sessionId != null && opts.sessionId !== '') {
      params.push(Number(opts.sessionId));
      where.push(`l.session_id = $${params.length}`);
    }
    if (opts.since) {
      params.push(new Date(opts.since));
      where.push(`l.created_at >= $${params.length}`);
    }
    if (opts.until) {
      params.push(new Date(opts.until));
      where.push(`l.created_at <= $${params.length}`);
    }

    const whereSql = where.join(' AND ');

    // Owner-wide totals.
    const totalsQ = await pool.query(
      `SELECT
         COUNT(*)                                         AS total_events,
         COUNT(*) FILTER (WHERE l.status = 'sent')        AS sent,
         COUNT(*) FILTER (WHERE l.status <> 'sent')       AS not_sent,
         COUNT(DISTINCT (l.session_id))                   AS active_sessions,
         COUNT(DISTINCT (l.session_id, l.peer_type, l.peer_id)) AS conversations,
         COUNT(*) FILTER (WHERE l.cupidbot_did_convert IS TRUE) AS conversions,
         MIN(l.created_at)                                AS first_activity,
         MAX(l.created_at)                                AS last_activity
       FROM ai_response_logs l
       JOIN sessions s ON s.id = l.session_id
       WHERE ${whereSql}`,
      params
    );

    // Status breakdown for the whole scope.
    const statusQ = await pool.query(
      `SELECT l.status, COUNT(*) AS count
       FROM ai_response_logs l
       JOIN sessions s ON s.id = l.session_id
       WHERE ${whereSql}
       GROUP BY l.status
       ORDER BY count DESC`,
      params
    );

    // Per-session breakdown so the operator can see each account at a glance.
    const perSessionQ = await pool.query(
      `SELECT
         l.session_id,
         s.phone,
         s.username,
         s.account_info->>'firstName' AS first_name,
         s.account_info->>'lastName'  AS last_name,
         COUNT(*)                                         AS total_events,
         COUNT(*) FILTER (WHERE l.status = 'sent')        AS sent,
         COUNT(DISTINCT (l.peer_type, l.peer_id))         AS conversations,
         COUNT(*) FILTER (WHERE l.cupidbot_did_convert IS TRUE) AS conversions,
         MAX(l.created_at)                                AS last_activity
       FROM ai_response_logs l
       JOIN sessions s ON s.id = l.session_id
       WHERE ${whereSql}
       GROUP BY l.session_id, s.phone, s.username, s.account_info
       ORDER BY last_activity DESC NULLS LAST`,
      params
    );

    const t = totalsQ.rows[0] || {};
    return {
      totals: {
        totalEvents: Number(t.total_events || 0),
        sent: Number(t.sent || 0),
        notSent: Number(t.not_sent || 0),
        activeSessions: Number(t.active_sessions || 0),
        conversations: Number(t.conversations || 0),
        conversions: Number(t.conversions || 0),
        firstActivity: t.first_activity || null,
        lastActivity: t.last_activity || null,
      },
      statusBreakdown: statusQ.rows.map((r) => ({
        status: r.status,
        count: Number(r.count),
      })),
      sessions: perSessionQ.rows.map((r) => ({
        sessionId: r.session_id,
        phone: r.phone,
        username: r.username,
        displayName:
          [r.first_name, r.last_name].filter(Boolean).join(' ').trim() ||
          (r.username ? `@${r.username}` : null) ||
          r.phone ||
          `Session #${r.session_id}`,
        totalEvents: Number(r.total_events || 0),
        sent: Number(r.sent || 0),
        conversations: Number(r.conversations || 0),
        conversions: Number(r.conversions || 0),
        lastActivity: r.last_activity || null,
      })),
    };
  }

  /**
   * List every conversation (distinct peer) the AI touched for a session,
   * with per-conversation counts and recipient labels. This is the
   * "each session -> its conversations" drill-down.
   */
  async listTrackedConversations(sessionId, userId, opts = {}) {
    const sid = Number(sessionId);
    await this._authorizeSession(sid, userId);

    const { rows } = await pool.query(
      `SELECT
         peer_type,
         peer_id,
         COUNT(*)                                   AS total_events,
         COUNT(*) FILTER (WHERE status = 'sent')    AS sent,
         COUNT(*) FILTER (WHERE cupidbot_did_convert IS TRUE) AS conversions,
         MIN(created_at)                            AS first_at,
         MAX(created_at)                            AS last_at,
         (ARRAY_AGG(request_payload->'recipient'->>'name'
            ORDER BY created_at DESC)
            FILTER (WHERE request_payload->'recipient'->>'name' <> ''))[1] AS recipient_name,
         (ARRAY_AGG(request_payload->'recipient'->>'username'
            ORDER BY created_at DESC)
            FILTER (WHERE request_payload->'recipient'->>'username' <> ''))[1] AS recipient_username
       FROM ai_response_logs
       WHERE session_id = $1
       GROUP BY peer_type, peer_id
       ORDER BY last_at DESC`,
      [sid]
    );

    return rows.map((r) => ({
      peerType: r.peer_type,
      peerId: String(r.peer_id),
      recipientName: r.recipient_name || null,
      recipientUsername: r.recipient_username || null,
      totalEvents: Number(r.total_events || 0),
      sent: Number(r.sent || 0),
      conversions: Number(r.conversions || 0),
      firstAt: r.first_at,
      lastAt: r.last_at,
    }));
  }

  /**
   * Full message-by-message transcript for one tracked conversation:
   * every incoming user message the AI saw and every message the AI sent,
   * in chronological order, with status and error context. This is the
   * "exactly what the AI sent in each chat" view.
   */
  async getConversationTranscript(sessionId, userId, peerType, peerId, opts = {}) {
    const sid = Number(sessionId);
    const pid = Number(peerId);
    await this._authorizeSession(sid, userId);

    const limit = Math.max(1, Math.min(1000, parseInt(opts.limit, 10) || 500));

    const { rows } = await pool.query(
      `SELECT id, status, error_message, created_at,
              incoming_msg_id, cupidbot_category, cupidbot_did_convert,
              is_followup,
              request_payload->'incomingMessage' AS incoming,
              response_payload            AS response
       FROM ai_response_logs
       WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3
       ORDER BY created_at ASC
       LIMIT $4`,
      [sid, peerType, pid, limit]
    );

    const events = rows.map((r) => {
      const incoming = r.incoming || null;
      const aiText = this._extractAiText(r.response);
      return {
        id: r.id,
        createdAt: r.created_at,
        status: r.status,
        errorMessage: r.error_message || null,
        category: r.cupidbot_category || null,
        didConvert: r.cupidbot_did_convert === true,
        isFollowUp: r.is_followup === true,
        incomingText: incoming && typeof incoming.msg === 'string' ? incoming.msg : '',
        incomingMsgId: r.incoming_msg_id != null ? String(r.incoming_msg_id) : null,
        aiText,
        aiSent: r.status === 'sent' && !!aiText,
      };
    });

    return { events, total: events.length };
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