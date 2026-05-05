/**
 * OtpRelayService — Saved-Messages OTP relay (Phase 4 follow-up).
 *
 * Why this exists
 * ---------------
 * Anti-revoke Phase 4 made panel sessions bulletproof against
 * *transient* revocation (false-positive errors, idle TTL expiry,
 * unconfirmed-window wipes). It cannot prevent an *intentional*
 * Telegram-side wipe of the user's main account — SIM swap,
 * password reset, support takedown, or the user themselves tapping
 * "Terminate all other sessions" on their phone. When that happens
 * the panel session for the main number is gone with the rest, and
 * any OTP that arrives next on that number never reaches the panel
 * because the account no longer exists.
 *
 * The relay solves it by forwarding incoming DMs from the official
 * Telegram service (chat id 777000) to the Saved Messages of a
 * *different* Telegram account. The relay account is fully
 * independent from the main account — Telegram cannot kill it as a
 * side-effect of wiping the main number — so the OTP survives even
 * a worst-case takedown.
 *
 * How it works
 * ------------
 *   1. The user adds a "relay" Telegram account to the panel via the
 *      normal Create Session flow.
 *   2. The user attaches that relay session to one or more "watch"
 *      sessions on the OTP-Relay page. Each attachment is a row in
 *      `tg_otp_relays`.
 *   3. On boot (and on every login + restore), this service registers
 *      a `NewMessage` GramJS event on every watch session. The
 *      handler:
 *        a. Filters by sender_filter (default 777000 / Telegram);
 *        b. Optionally filters by regex;
 *        c. Enforces per-minute rate-limit;
 *        d. Forwards the message body via `client.sendMessage('me', ...)`
 *           on the *relay* session's GramJS client (the literal 'me'
 *           resolves to InputPeerSelf which is the Saved Messages
 *           thread).
 *        e. Writes an audit row in `tg_otp_relay_events`.
 *   4. On logout / delete of either the watch or relay session, the
 *      listener is unsubscribed.
 *
 * Idempotency
 * -----------
 * Listeners are tracked by `(watchSessionId, attachmentId)`. The
 * heartbeat / restore loop calls `onSessionConnected(sessionId)`
 * unconditionally; this method is a no-op when listeners are already
 * registered, so reconnecting a session after a transient blip does
 * not double-attach.
 *
 * Failure modes
 * -------------
 * Every async path is wrapped in try/catch and surfaced via
 * `logger.warn` + an audit row. A failure to forward NEVER throws
 * back into the GramJS event dispatcher — that would silently kill
 * the listener and break OTP capture. Audit-row writes are
 * best-effort: if Postgres is down we continue serving forwards but
 * log a warning.
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const cfg = require('../config/telegram');
const tgService = require('./telegramService');
const { AppError } = require('../utils/errorHandler');

class OtpRelayService {
  constructor() {
    /**
     * Per-attachment listener registry. Keyed by `relayId` (the
     * `tg_otp_relays.id` PK) so a single watch session with N
     * attachments registers N independent listeners. Each entry is:
     *   {
     *     unsubscribe: () => void,    // returned by addNewMessageHandler
     *     watchSessionId: string,
     *     relaySessionId: string,
     *     senderFilter: string[],
     *     senderFilterLower: Set<string>,
     *     regex: RegExp | null,
     *     prefix: string,
     *     rateBucket: { minute: number, count: number },
     *     rateLimitPerMin: number,
     *   }
     */
    this._listeners = new Map();
    this._started = false;
  }

  // -----------------------------------------------------------------
  // Public lifecycle
  // -----------------------------------------------------------------

  /**
   * Boot-time entry point. Loads every enabled attachment from
   * `tg_otp_relays` and registers a listener for each. Idempotent.
   */
  async start() {
    if (this._started) return;
    this._started = true;
    if (!cfg.OTP_RELAY_ENABLED) {
      logger.info('OtpRelayService: OTP_RELAY_ENABLED=false — skipping start');
      return;
    }
    try {
      const { rows } = await pool.query(
        `SELECT id, user_id, watch_session_id, relay_session_id,
                sender_filter, regex, prefix, rate_limit_per_min
           FROM tg_otp_relays
          WHERE enabled = TRUE`
      );
      for (const r of rows) {
        // We only register listeners for sessions whose GramJS client
        // is already in the connected map. The
        // `restoreAllLoggedInSessions` flow calls back into this
        // service for sessions that come up later.
        if (!tgService.isSessionActive(String(r.watch_session_id))) {
          logger.debug(
            `OtpRelayService: watch session ${r.watch_session_id} not yet active; deferring`
          );
          continue;
        }
        try {
          await this._registerAttachment(r);
        } catch (err) {
          logger.warn(
            `OtpRelayService: failed to register attachment ${r.id}: ${err.message}`
          );
        }
      }
      logger.info(
        `OtpRelayService started: ${this._listeners.size}/${rows.length} attachments active`
      );
    } catch (err) {
      // Schema may not exist yet on first boot before the v18 migration
      // ran. Log + continue so the rest of the panel comes up.
      logger.warn(`OtpRelayService.start failed: ${err.message}`);
    }
  }

  /**
   * Called from sessionService whenever a session becomes connected
   * (login, restore, creation). Registers any attachment whose
   * watch_session_id matches.
   */
  async onSessionConnected(sessionId) {
    if (!cfg.OTP_RELAY_ENABLED) return;
    try {
      const { rows } = await pool.query(
        `SELECT id, user_id, watch_session_id, relay_session_id,
                sender_filter, regex, prefix, rate_limit_per_min
           FROM tg_otp_relays
          WHERE enabled = TRUE
            AND watch_session_id = $1`,
        [sessionId]
      );
      for (const r of rows) {
        if (this._listeners.has(r.id)) continue; // already registered
        try {
          await this._registerAttachment(r);
        } catch (err) {
          logger.debug(
            `onSessionConnected: register attachment ${r.id} failed: ${err.message}`
          );
        }
      }
    } catch (err) {
      logger.debug(`onSessionConnected: ${err.message}`);
    }
  }

  /**
   * Called from sessionService on logout / delete of any session.
   * Removes every attachment that referenced the session as either
   * watch or relay.
   */
  async onSessionDisconnected(sessionId) {
    const sid = String(sessionId);
    const toRemove = [];
    for (const [relayId, l] of this._listeners.entries()) {
      if (l.watchSessionId === sid || l.relaySessionId === sid) {
        toRemove.push(relayId);
      }
    }
    for (const relayId of toRemove) {
      this._unregisterAttachment(relayId);
    }
  }

  // -----------------------------------------------------------------
  // CRUD surface (used by controllers)
  // -----------------------------------------------------------------

  /**
   * @returns {Promise<Array<object>>}
   */
  async listForUser(userId) {
    const { rows } = await pool.query(
      `SELECT r.id, r.watch_session_id, r.relay_session_id,
              r.sender_filter, r.regex, r.prefix, r.enabled,
              r.rate_limit_per_min, r.last_forwarded_at,
              r.last_forward_error, r.created_at, r.updated_at,
              ws.phone   AS watch_phone,
              rs.phone   AS relay_phone,
              (SELECT COUNT(*) FROM tg_otp_relay_events e
                 WHERE e.relay_id = r.id) AS event_count
         FROM tg_otp_relays r
    LEFT JOIN sessions ws ON ws.id = r.watch_session_id
    LEFT JOIN sessions rs ON rs.id = r.relay_session_id
        WHERE r.user_id = $1
        ORDER BY r.created_at DESC`,
      [userId]
    );
    return rows.map((r) => ({
      ...r,
      attached:
        this._listeners.has(r.id) ||
        (!r.enabled
          ? false
          : tgService.isSessionActive(String(r.watch_session_id))),
    }));
  }

  async create(userId, payload) {
    const watchSessionId = parseInt(payload.watchSessionId, 10);
    const relaySessionId = parseInt(payload.relaySessionId, 10);
    if (!watchSessionId || !relaySessionId) {
      throw new AppError(
        'watchSessionId and relaySessionId are required',
        400, 'INVALID_REQUEST'
      );
    }
    if (watchSessionId === relaySessionId) {
      throw new AppError(
        'watch and relay sessions must differ',
        400, 'INVALID_REQUEST'
      );
    }
    // Both sessions must belong to this user (cross-tenant safety).
    const { rows } = await pool.query(
      `SELECT id, user_id, platform FROM sessions
        WHERE id IN ($1, $2)`,
      [watchSessionId, relaySessionId]
    );
    if (rows.length !== 2) {
      throw new AppError('one or both sessions not found', 404, 'SESSION_NOT_FOUND');
    }
    for (const s of rows) {
      if (s.user_id !== userId) {
        throw new AppError(
          'session does not belong to this user', 403, 'FORBIDDEN'
        );
      }
      if (s.platform !== 'telegram') {
        throw new AppError(
          'OTP relay is Telegram-only', 400, 'PLATFORM_UNSUPPORTED'
        );
      }
    }

    const senderFilter = Array.isArray(payload.senderFilter) && payload.senderFilter.length > 0
      ? payload.senderFilter
      : cfg.OTP_RELAY_DEFAULT_SENDERS;
    const regex = typeof payload.regex === 'string' && payload.regex.trim()
      ? payload.regex.trim()
      : (cfg.OTP_RELAY_DEFAULT_REGEX || null);
    if (regex) {
      try {
        // eslint-disable-next-line no-new
        new RegExp(regex);
      } catch (err) {
        throw new AppError(`invalid regex: ${err.message}`, 400, 'INVALID_REGEX');
      }
    }
    const prefix = typeof payload.prefix === 'string' ? payload.prefix.slice(0, 200) : null;
    const rateLimit = Number.isFinite(parseInt(payload.rateLimitPerMin, 10))
      ? Math.max(1, Math.min(600, parseInt(payload.rateLimitPerMin, 10)))
      : cfg.OTP_RELAY_RATE_LIMIT_PER_MIN;

    let inserted;
    try {
      const ins = await pool.query(
        `INSERT INTO tg_otp_relays (
           user_id, watch_session_id, relay_session_id,
           sender_filter, regex, prefix, rate_limit_per_min
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
         RETURNING id, watch_session_id, relay_session_id, sender_filter,
                   regex, prefix, enabled, rate_limit_per_min,
                   last_forwarded_at, last_forward_error,
                   created_at, updated_at`,
        [
          userId, watchSessionId, relaySessionId,
          JSON.stringify(senderFilter), regex, prefix, rateLimit,
        ]
      );
      inserted = ins.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw new AppError(
          'this watch + relay pair is already attached', 409, 'DUPLICATE_ATTACHMENT'
        );
      }
      throw err;
    }

    // Best-effort: register the listener immediately if the watch
    // session is already connected.
    if (cfg.OTP_RELAY_ENABLED && tgService.isSessionActive(String(watchSessionId))) {
      try {
        await this._registerAttachment({
          id: inserted.id,
          user_id: userId,
          watch_session_id: watchSessionId,
          relay_session_id: relaySessionId,
          sender_filter: senderFilter,
          regex,
          prefix,
          rate_limit_per_min: rateLimit,
        });
      } catch (err) {
        logger.warn(
          `OtpRelayService.create: registered DB row but listener failed: ${err.message}`
        );
      }
    }
    return inserted;
  }

  async update(userId, relayId, patch) {
    const owned = await pool.query(
      `SELECT id FROM tg_otp_relays WHERE id = $1 AND user_id = $2`,
      [relayId, userId]
    );
    if (owned.rows.length === 0) {
      throw new AppError('relay not found', 404, 'RELAY_NOT_FOUND');
    }
    const sets = [];
    const args = [];
    let i = 1;
    if (typeof patch.enabled === 'boolean') {
      sets.push(`enabled = $${i++}`); args.push(patch.enabled);
    }
    if (Array.isArray(patch.senderFilter)) {
      sets.push(`sender_filter = $${i++}::jsonb`); args.push(JSON.stringify(patch.senderFilter));
    }
    if (typeof patch.regex === 'string' || patch.regex === null) {
      const r = patch.regex && patch.regex.trim() ? patch.regex.trim() : null;
      if (r) {
        try { new RegExp(r); } catch (err) {
          throw new AppError(`invalid regex: ${err.message}`, 400, 'INVALID_REGEX');
        }
      }
      sets.push(`regex = $${i++}`); args.push(r);
    }
    if (typeof patch.prefix === 'string' || patch.prefix === null) {
      sets.push(`prefix = $${i++}`); args.push(patch.prefix ? patch.prefix.slice(0, 200) : null);
    }
    if (Number.isFinite(parseInt(patch.rateLimitPerMin, 10))) {
      sets.push(`rate_limit_per_min = $${i++}`);
      args.push(Math.max(1, Math.min(600, parseInt(patch.rateLimitPerMin, 10))));
    }
    if (sets.length === 0) {
      throw new AppError('no fields to update', 400, 'INVALID_REQUEST');
    }
    sets.push('updated_at = NOW()');
    args.push(relayId);
    args.push(userId);
    const updated = await pool.query(
      `UPDATE tg_otp_relays SET ${sets.join(', ')}
         WHERE id = $${i++} AND user_id = $${i}
         RETURNING *`,
      args
    );
    // Re-register the listener so config edits take immediate effect.
    this._unregisterAttachment(relayId);
    if (updated.rows[0].enabled
        && cfg.OTP_RELAY_ENABLED
        && tgService.isSessionActive(String(updated.rows[0].watch_session_id))) {
      try {
        await this._registerAttachment(updated.rows[0]);
      } catch (err) {
        logger.warn(`update: listener re-register failed: ${err.message}`);
      }
    }
    return updated.rows[0];
  }

  async remove(userId, relayId) {
    const r = await pool.query(
      `DELETE FROM tg_otp_relays
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [relayId, userId]
    );
    if (r.rows.length === 0) {
      throw new AppError('relay not found', 404, 'RELAY_NOT_FOUND');
    }
    this._unregisterAttachment(relayId);
    return { id: r.rows[0].id };
  }

  async listEvents(userId, relayId, { limit = 50, offset = 0 } = {}) {
    const owned = await pool.query(
      `SELECT id FROM tg_otp_relays WHERE id = $1 AND user_id = $2`,
      [relayId, userId]
    );
    if (owned.rows.length === 0) {
      throw new AppError('relay not found', 404, 'RELAY_NOT_FOUND');
    }
    const { rows } = await pool.query(
      `SELECT id, sender_id, message_excerpt, status, error_message, created_at
         FROM tg_otp_relay_events
        WHERE relay_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [relayId, Math.min(parseInt(limit, 10) || 50, 200), parseInt(offset, 10) || 0]
    );
    return rows;
  }

  async pruneOldEvents() {
    if (!cfg.OTP_RELAY_ENABLED) return { deleted: 0 };
    try {
      const r = await pool.query(
        `DELETE FROM tg_otp_relay_events
           WHERE created_at < NOW() - ($1 || ' days')::interval
           RETURNING id`,
        [String(Math.max(1, cfg.OTP_RELAY_EVENT_RETENTION_DAYS))]
      );
      return { deleted: r.rowCount || 0 };
    } catch (err) {
      logger.debug(`pruneOldEvents: ${err.message}`);
      return { deleted: 0, error: err.message };
    }
  }

  // -----------------------------------------------------------------
  // Internal listener registration
  // -----------------------------------------------------------------

  async _registerAttachment(row) {
    const relayId = row.id;
    if (this._listeners.has(relayId)) return;
    const watchSessionId = String(row.watch_session_id);
    const relaySessionId = String(row.relay_session_id);
    if (!tgService.isSessionActive(watchSessionId)) {
      logger.debug(`_registerAttachment: watch ${watchSessionId} not active; skipping`);
      return;
    }
    const senderFilter = Array.isArray(row.sender_filter) ? row.sender_filter : [];
    const senderFilterLower = new Set(senderFilter.map((s) => String(s).toLowerCase()));
    let regex = null;
    if (row.regex) {
      try { regex = new RegExp(row.regex); } catch (err) {
        logger.warn(`relay ${relayId}: invalid regex; ignoring (${err.message})`);
      }
    }
    const handler = async (event) => {
      try {
        await this._handleNewMessage({
          relayId,
          watchSessionId,
          relaySessionId,
          senderFilterLower,
          regex,
          prefix: row.prefix || '',
          rateLimitPerMin: row.rate_limit_per_min || cfg.OTP_RELAY_RATE_LIMIT_PER_MIN,
          event,
        });
      } catch (err) {
        // NEVER let an exception escape the GramJS dispatcher.
        logger.warn(`relay ${relayId}: handler crashed: ${err.message}`);
      }
    };
    const unsubscribe = await tgService.addNewMessageHandler(watchSessionId, handler);
    this._listeners.set(relayId, {
      unsubscribe,
      watchSessionId,
      relaySessionId,
      rateBucket: { minute: 0, count: 0 },
    });
    logger.info(
      `OtpRelayService: registered relay #${relayId} (watch=${watchSessionId} → relay=${relaySessionId})`
    );
  }

  _unregisterAttachment(relayId) {
    const l = this._listeners.get(relayId);
    if (!l) return;
    try { l.unsubscribe(); } catch { /* ignore */ }
    this._listeners.delete(relayId);
    logger.info(`OtpRelayService: unregistered relay #${relayId}`);
  }

  // -----------------------------------------------------------------
  // Forward path
  // -----------------------------------------------------------------

  async _handleNewMessage(ctx) {
    const {
      relayId, watchSessionId, relaySessionId,
      senderFilterLower, regex, prefix, rateLimitPerMin, event,
    } = ctx;

    if (!event || !event.message) return;
    const message = event.message;
    // Only DM messages are interesting; skip channel posts and
    // outgoing messages.
    if (message.out) return;

    // Sender filter — accept either the numeric senderId or the
    // username-style sender. We coerce both sides to lower-case.
    let senderIdRaw = null;
    if (message.senderId) {
      try { senderIdRaw = String(message.senderId.value || message.senderId); }
      catch { senderIdRaw = String(message.senderId); }
    } else if (message.peerId && message.peerId.userId) {
      try { senderIdRaw = String(message.peerId.userId.value || message.peerId.userId); }
      catch { senderIdRaw = String(message.peerId.userId); }
    }

    // Resolve sender username if available — needed to match
    // 'Telegram' as a string filter.
    let senderUsername = null;
    try {
      const sender = typeof event.getSender === 'function' ? await event.getSender() : null;
      if (sender && sender.username) senderUsername = String(sender.username);
    } catch { /* network failure resolving sender — sender_id check still applies */ }

    const matchesSender =
      (senderIdRaw && senderFilterLower.has(senderIdRaw.toLowerCase())) ||
      (senderUsername && senderFilterLower.has(senderUsername.toLowerCase()));

    if (!matchesSender) {
      // Don't log skipped_sender events — they would dominate the
      // ledger noise-wise. We only audit forwards, drops we care
      // about (rate-limited, regex-skipped, send-failed), and the
      // operator-visible status changes.
      return;
    }

    const text = String(message.message || message.text || '').trim();
    if (!text) {
      await this._writeEvent({
        relayId, watchSessionId, relaySessionId,
        senderId: senderIdRaw, status: 'skipped_regex', excerpt: null,
      });
      return;
    }

    if (regex && !regex.test(text)) {
      await this._writeEvent({
        relayId, watchSessionId, relaySessionId,
        senderId: senderIdRaw, status: 'skipped_regex',
        excerpt: text.slice(0, 1024),
      });
      return;
    }

    // Per-attachment rate-limit (sliding 1-minute window).
    const l = this._listeners.get(relayId);
    if (l) {
      const minuteNow = Math.floor(Date.now() / 60000);
      if (l.rateBucket.minute !== minuteNow) {
        l.rateBucket.minute = minuteNow;
        l.rateBucket.count = 0;
      }
      l.rateBucket.count++;
      if (l.rateBucket.count > rateLimitPerMin) {
        await this._writeEvent({
          relayId, watchSessionId, relaySessionId,
          senderId: senderIdRaw, status: 'rate_limited',
          excerpt: text.slice(0, 1024),
        });
        return;
      }
    }

    // Make sure the relay session is connected. The phase-4 heartbeat
    // takes care of reconnecting; here we just abort with an audit
    // row if it's not currently up.
    if (!tgService.isSessionActive(relaySessionId)) {
      await this._writeEvent({
        relayId, watchSessionId, relaySessionId,
        senderId: senderIdRaw, status: 'watch_disconnected',
        excerpt: text.slice(0, 1024),
        errorMessage: 'relay session not connected',
      });
      return;
    }

    const body = prefix ? `${prefix}\n\n${text}` : text;
    try {
      // GramJS treats the literal string 'me' as InputPeerSelf, which
      // is the Saved Messages thread. This is the cleanest way to
      // post into Saved Messages from a session — no need to resolve
      // a peer.
      await tgService.sendMessage(relaySessionId, 'me', body, {
        noWebpage: true,
      });
      await this._writeEvent({
        relayId, watchSessionId, relaySessionId,
        senderId: senderIdRaw, status: 'forwarded',
        excerpt: text.slice(0, 1024),
      });
      // Bookkeeping: bump last_forwarded_at on the parent row.
      try {
        await pool.query(
          `UPDATE tg_otp_relays
              SET last_forwarded_at = NOW(),
                  last_forward_error = NULL,
                  updated_at = NOW()
            WHERE id = $1`,
          [relayId]
        );
      } catch { /* best-effort */ }
    } catch (err) {
      logger.warn(`relay ${relayId}: forward failed: ${err.message}`);
      await this._writeEvent({
        relayId, watchSessionId, relaySessionId,
        senderId: senderIdRaw, status: 'send_failed',
        excerpt: text.slice(0, 1024),
        errorMessage: err.message,
      });
      try {
        await pool.query(
          `UPDATE tg_otp_relays
              SET last_forward_error = $2, updated_at = NOW()
            WHERE id = $1`,
          [relayId, String(err.message).slice(0, 500)]
        );
      } catch { /* best-effort */ }
    }
  }

  async _writeEvent(e) {
    try {
      // Resolve user_id from the parent row (so the audit log is
      // queryable scoped to the user without joining sessions).
      const u = await pool.query(
        `SELECT user_id FROM tg_otp_relays WHERE id = $1`,
        [e.relayId]
      );
      const userId = u.rows[0] ? u.rows[0].user_id : null;
      await pool.query(
        `INSERT INTO tg_otp_relay_events (
           relay_id, user_id, watch_session_id, relay_session_id,
           sender_id, message_excerpt, status, error_message
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          e.relayId, userId, e.watchSessionId, e.relaySessionId,
          e.senderId || null, e.excerpt || null, e.status,
          e.errorMessage || null,
        ]
      );
    } catch (err) {
      logger.debug(`_writeEvent: ${err.message}`);
    }
  }
}

const instance = new OtpRelayService();
module.exports = instance;
