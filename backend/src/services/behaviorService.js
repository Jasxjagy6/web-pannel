/**
 * BehaviorService — Anti-Detect Layer
 * --------------------------------------------------------------------
 * Telegram's anti-spam classifier looks at *behavior*, not just IP and
 * device. Accounts that connect, idle 24/7, and never read a message
 * stand out. So we periodically perform low-risk, **read-only** actions
 * on a randomized subset of logged-in sessions to make them look like
 * humans casually checking Telegram.
 *
 * Action menu (all safe):
 *   1. ping           — light request to keep the auth_key warm
 *   2. fetch_dialogs  — pull the most recent dialog list (mimics opening
 *                       the Chats tab)
 *   3. read_random    — mark the first unread message in a random
 *                       dialog as read
 *   4. set_typing     — set a "typing" action briefly in a random
 *                       dialog (no message is sent — Telegram drops the
 *                       indicator after a few seconds)
 *   5. react_random   — send a single reaction (👍, 🔥, ❤️) to a recent
 *                       message — only enabled once the account is more
 *                       than WARMUP_GRACE_HOURS old, matching the
 *                       prompt's 48-hour warm-up rule
 *
 * Each tick picks BEHAVIOR_BATCH_SIZE eligible sessions, performs ONE
 * randomly-selected action per session, with a `random.uniform(MIN,MAX)`
 * delay between sessions. Every action is logged to `behavior_log`.
 *
 * Scheduling is opt-in: the panel calls `start()` once on boot. The
 * scheduler always wakes up on a randomized base interval so the
 * pattern doesn't itself become a fingerprint.
 *
 * Public API:
 *   start()                            — kick off the background scheduler
 *   stop()                             — stop the scheduler (used in tests)
 *   tickOnce(opts)                     — run one batch immediately
 *   runForSession(sessionId, action?)  — manual single-session warm-up
 *   listLogs(filter)                   — recent rows from behavior_log
 *   stats()                            — aggregate counts
 */

'use strict';

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const tgService = require('./telegramService');

let Api;
try {
  Api = require('telegram').Api;
} catch (err) {
  Api = null;
}

const TICK_INTERVAL_MS = parseInt(
  process.env.BEHAVIOR_TICK_INTERVAL_MS || `${5 * 60 * 1000}`,
  10
);
const BATCH_SIZE = parseInt(process.env.BEHAVIOR_BATCH_SIZE || '5', 10);
const PER_SESSION_DELAY_MIN_MS = parseInt(
  process.env.BEHAVIOR_DELAY_MIN_MS || '4000',
  10
);
const PER_SESSION_DELAY_MAX_MS = parseInt(
  process.env.BEHAVIOR_DELAY_MAX_MS || '12000',
  10
);
const WARMUP_GRACE_HOURS = parseInt(
  process.env.BEHAVIOR_WARMUP_GRACE_HOURS || '48',
  10
);
const MIN_GAP_MS = parseInt(
  process.env.BEHAVIOR_MIN_GAP_MS || `${30 * 60 * 1000}`,
  10
); // never act on the same session more than once per 30 min by default

const READ_ONLY_REACTIONS = ['👍', '🔥', '❤️', '👏', '🥰'];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class BehaviorService {
  constructor() {
    this._timer = null;
    this._running = false;
    this._lastTickAt = null;
    this._lastTickResult = null;
  }

  /** Kick off the periodic scheduler. */
  start() {
    if (this._timer) return;
    const seed = randomInt(0, TICK_INTERVAL_MS);
    logger.info(
      `BehaviorService scheduler armed (interval=${TICK_INTERVAL_MS}ms, ` +
        `batch=${BATCH_SIZE}, jitter-seed=${seed}ms)`
    );
    // First tick after a random delay so panels rebooting in lockstep
    // don't all hit Telegram at the same wall-clock second.
    this._timer = setTimeout(() => this._tickLoop(), seed);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async _tickLoop() {
    if (this._running) {
      // Re-arm and bail; never run two ticks concurrently.
      this._scheduleNext();
      return;
    }
    this._running = true;
    try {
      await this.tickOnce({ batchSize: BATCH_SIZE });
    } catch (err) {
      logger.warn(`BehaviorService tick failed: ${err.message}`);
    } finally {
      this._running = false;
      this._scheduleNext();
    }
  }

  _scheduleNext() {
    // Add ±25% jitter so the period itself isn't observable.
    const jitter = randomInt(
      Math.floor(TICK_INTERVAL_MS * 0.75),
      Math.ceil(TICK_INTERVAL_MS * 1.25)
    );
    this._timer = setTimeout(() => this._tickLoop(), jitter);
    if (this._timer.unref) this._timer.unref();
  }

  /**
   * Pick eligible sessions and run one action per session.
   * @param {object} [opts]
   * @param {number} [opts.batchSize] override BATCH_SIZE
   * @param {string[]} [opts.sessionIds] explicit sessions only
   * @returns {Promise<{picked:number, succeeded:number, failed:number, skipped:number, sessions:Array}>}
   */
  async tickOnce(opts = {}) {
    const batchSize = Math.max(1, Math.min(50, opts.batchSize || BATCH_SIZE));
    const explicit = Array.isArray(opts.sessionIds) && opts.sessionIds.length > 0;
    const candidates = explicit
      ? await this._loadByIds(opts.sessionIds)
      : await this._pickEligible(batchSize);

    const result = {
      picked: candidates.length,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      sessions: [],
    };

    for (const cand of candidates) {
      try {
        const outcome = await this.runForSession(cand.id, undefined, cand);
        result.sessions.push({ sessionId: cand.id, ...outcome });
        if (outcome.succeeded) result.succeeded++;
        else if (outcome.skipped) result.skipped++;
        else result.failed++;
      } catch (err) {
        result.failed++;
        result.sessions.push({
          sessionId: cand.id,
          succeeded: false,
          error: err.message,
        });
      }
      const delay = randomInt(PER_SESSION_DELAY_MIN_MS, PER_SESSION_DELAY_MAX_MS);
      await sleep(delay);
    }

    this._lastTickAt = new Date();
    this._lastTickResult = result;
    if (result.picked) {
      logger.info(
        `Behavior tick done: picked=${result.picked} ok=${result.succeeded} ` +
          `skip=${result.skipped} fail=${result.failed}`
      );
    }
    return result;
  }

  /**
   * Run a single action against a single session. Used both by the
   * scheduler (per-session) and the manual API.
   *
   * @param {number|string} sessionId
   * @param {string} [forcedAction]   Action name override
   * @param {object} [preloaded]      Optional row already fetched by tickOnce
   */
  async runForSession(sessionId, forcedAction, preloaded) {
    const row = preloaded || (await this._loadOne(sessionId));
    if (!row) {
      return { succeeded: false, skipped: true, reason: 'session_not_found' };
    }
    if (!row.is_logged_in) {
      return { succeeded: false, skipped: true, reason: 'not_logged_in' };
    }

    const ageHours =
      (Date.now() - new Date(row.created_at || Date.now()).getTime()) /
      (1000 * 60 * 60);
    const isWarmedUp = ageHours >= WARMUP_GRACE_HOURS;

    const menu = isWarmedUp
      ? ['ping', 'fetch_dialogs', 'read_random', 'set_typing', 'react_random']
      : ['ping', 'fetch_dialogs', 'read_random'];
    const action = forcedAction && menu.includes(forcedAction) ? forcedAction : pick(menu);

    let succeeded = false;
    let target = null;
    let errorCode = null;
    let errorMessage = null;
    let details = null;

    try {
      const out = await this._performAction(sessionId, action);
      succeeded = true;
      target = out.target || null;
      details = out.details || null;
    } catch (err) {
      errorCode = err.code || err.errorCode || err.errorMessage || 'ERROR';
      errorMessage = err.message || String(err);
    }

    await this._writeLog({
      sessionId,
      action,
      target,
      succeeded,
      errorCode,
      errorMessage,
      details,
    });

    if (succeeded) {
      try {
        await pool.query(
          `UPDATE sessions SET last_warmup_at = NOW() WHERE id = $1`,
          [sessionId]
        );
      } catch (_) {}
    }

    return {
      succeeded,
      action,
      target,
      error: errorMessage || undefined,
    };
  }

  /**
   * Dispatcher to the actual Telegram calls. Each branch keeps its own
   * try/catch and returns either { target, details } or throws.
   */
  async _performAction(sessionId, action) {
    const sid = String(sessionId);
    if (!tgService.isSessionActive(sid)) {
      // Force a (re)connect via _loadSessionFromDB so the heartbeat path
      // doesn't have to race us.
      await tgService._loadSessionFromDB(sessionId).catch(() => {});
      if (!tgService.isSessionActive(sid)) {
        throw new Error('session not active');
      }
    }
    const entry = tgService.clients.get(sid);
    const client = entry && entry.client;
    if (!client) throw new Error('no client');

    switch (action) {
      case 'ping': {
        // getMe() is the lightest possible authenticated round-trip.
        const me = await client.getMe();
        return { target: 'self', details: { id: me ? String(me.id) : null } };
      }
      case 'fetch_dialogs': {
        const dialogs = await client.getDialogs({ limit: 30 });
        return {
          target: 'dialogs',
          details: { count: Array.isArray(dialogs) ? dialogs.length : 0 },
        };
      }
      case 'read_random': {
        const dialogs = await client.getDialogs({ limit: 50 });
        const unread = (dialogs || []).filter(
          (d) => d && d.entity && (d.unreadCount || 0) > 0 && (d.message != null)
        );
        if (!unread.length) {
          return { target: 'none', details: { reason: 'nothing_unread' } };
        }
        const dialog = pick(unread);
        const messageId = dialog.message && dialog.message.id;
        if (!messageId) {
          return { target: 'none', details: { reason: 'missing_message_id' } };
        }
        // Mark the chat as read up to this message.
        try {
          await client.sendReadAcknowledge(dialog.entity, { maxId: messageId });
        } catch (err) {
          // Some entities (channels) need the channel-specific read API,
          // but Telegram quietly tolerates the generic call as well.
          throw err;
        }
        return {
          target: dialog.entity ? String(dialog.entity.id) : null,
          details: { messageId: String(messageId) },
        };
      }
      case 'set_typing': {
        if (!Api) throw new Error('Api unavailable');
        const dialogs = await client.getDialogs({ limit: 30 });
        const candidates = (dialogs || []).filter((d) => d && d.entity);
        if (!candidates.length) {
          return { target: 'none', details: { reason: 'no_dialogs' } };
        }
        const dialog = pick(candidates);
        await client.invoke(
          new Api.messages.SetTyping({
            peer: dialog.entity,
            action: new Api.SendMessageTypingAction(),
          })
        );
        return {
          target: dialog.entity ? String(dialog.entity.id) : null,
          details: {},
        };
      }
      case 'react_random': {
        if (!Api) throw new Error('Api unavailable');
        const dialogs = await client.getDialogs({ limit: 30 });
        const recent = (dialogs || []).filter(
          (d) => d && d.message && d.message.id && d.entity
        );
        if (!recent.length) {
          return { target: 'none', details: { reason: 'no_recent_messages' } };
        }
        const dialog = pick(recent);
        const reaction = pick(READ_ONLY_REACTIONS);
        await client.invoke(
          new Api.messages.SendReaction({
            peer: dialog.entity,
            msgId: dialog.message.id,
            reaction: [
              new Api.ReactionEmoji({ emoticon: reaction }),
            ],
            big: false,
            addToRecent: true,
          })
        );
        return {
          target: dialog.entity ? String(dialog.entity.id) : null,
          details: { reaction, msgId: String(dialog.message.id) },
        };
      }
      default:
        throw new Error(`unknown action: ${action}`);
    }
  }

  // --------------------------------------------------------------------
  // DB helpers
  // --------------------------------------------------------------------

  async _pickEligible(batchSize) {
    // Prefer sessions that haven't been touched recently. Order by
    // last_warmup_at ascending so we cycle fairly through the pool.
    // BehaviorService is Telegram-specific (uses GramJS warm-up
    // primitives + the TG-only _loadSessionFromDB), so filter to
    // platform='telegram' here so IG sessions never get picked up.
    const r = await pool.query(
      `SELECT id, user_id, phone, is_logged_in, created_at, last_warmup_at,
              device_identity, bound_proxy_id
         FROM sessions
        WHERE is_logged_in = TRUE
          AND COALESCE(keep_alive, TRUE) = TRUE
          AND platform = 'telegram'
          AND (last_warmup_at IS NULL OR last_warmup_at < NOW() - ($1::int * INTERVAL '1 millisecond'))
        ORDER BY COALESCE(last_warmup_at, TIMESTAMP 'epoch') ASC, id ASC
        LIMIT $2`,
      [MIN_GAP_MS, batchSize * 3] // over-fetch then random subset
    );
    const all = r.rows;
    // Random subset of size batchSize.
    if (all.length <= batchSize) return all;
    const shuffled = all.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, batchSize);
  }

  async _loadByIds(ids) {
    const r = await pool.query(
      `SELECT id, user_id, phone, is_logged_in, created_at, last_warmup_at,
              device_identity, bound_proxy_id
         FROM sessions WHERE id = ANY($1::int[])`,
      [ids.map((x) => Number(x)).filter(Boolean)]
    );
    return r.rows;
  }

  async _loadOne(sessionId) {
    const r = await pool.query(
      `SELECT id, user_id, phone, is_logged_in, created_at, last_warmup_at,
              device_identity, bound_proxy_id
         FROM sessions WHERE id = $1`,
      [sessionId]
    );
    return r.rows[0] || null;
  }

  async _writeLog({ sessionId, action, target, succeeded, errorCode, errorMessage, details }) {
    try {
      await pool.query(
        `INSERT INTO behavior_log
            (session_id, action, target, succeeded, error_code, error_message, details, performed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())`,
        [
          sessionId,
          action,
          target ? String(target).slice(0, 240) : null,
          !!succeeded,
          errorCode ? String(errorCode).slice(0, 60) : null,
          errorMessage || null,
          details ? JSON.stringify(details) : null,
        ]
      );
    } catch (err) {
      logger.warn(`behavior_log insert failed: ${err.message}`);
    }
  }

  /** Return recent log rows for the panel UI. */
  async listLogs(filter = {}) {
    const where = [];
    const args = [];
    if (filter.sessionId) {
      args.push(filter.sessionId);
      where.push(`session_id = $${args.length}`);
    }
    if (filter.action) {
      args.push(filter.action);
      where.push(`action = $${args.length}`);
    }
    if (filter.userId) {
      args.push(filter.userId);
      where.push(
        `session_id IN (SELECT id FROM sessions WHERE user_id = $${args.length})`
      );
    }
    const limit = Math.max(1, Math.min(500, Number(filter.limit) || 100));
    const sql = `
      SELECT id, session_id, action, target, succeeded, error_code, error_message, details, performed_at
        FROM behavior_log
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY performed_at DESC
       LIMIT ${limit}
    `;
    const r = await pool.query(sql, args);
    return r.rows;
  }

  async stats(userId) {
    const args = [];
    let userClause = '';
    if (userId) {
      args.push(userId);
      userClause = `WHERE session_id IN (SELECT id FROM sessions WHERE user_id = $${args.length})`;
    }
    const total = await pool.query(
      `SELECT COUNT(*)::int AS c FROM behavior_log ${userClause}`,
      args
    );
    const last24 = await pool.query(
      `SELECT COUNT(*)::int AS c FROM behavior_log
        ${userClause ? userClause + ' AND' : 'WHERE'}
              performed_at > NOW() - INTERVAL '24 hours'`,
      args
    );
    const succeeded = await pool.query(
      `SELECT COUNT(*)::int AS c FROM behavior_log
        ${userClause ? userClause + ' AND' : 'WHERE'} succeeded = TRUE
          AND performed_at > NOW() - INTERVAL '24 hours'`,
      args
    );
    const byAction = await pool.query(
      `SELECT action, COUNT(*)::int AS c FROM behavior_log
        ${userClause ? userClause + ' AND' : 'WHERE'}
              performed_at > NOW() - INTERVAL '7 days'
        GROUP BY action ORDER BY c DESC`,
      args
    );
    return {
      totalEverLogged: total.rows[0].c,
      last24h: last24.rows[0].c,
      successful24h: succeeded.rows[0].c,
      byAction7d: byAction.rows,
      lastTickAt: this._lastTickAt,
      lastTickResult: this._lastTickResult,
      tickIntervalMs: TICK_INTERVAL_MS,
      batchSize: BATCH_SIZE,
      warmupGraceHours: WARMUP_GRACE_HOURS,
    };
  }
}

module.exports = new BehaviorService();
