/**
 * aiCatchupService — answer pending, unreplied personal DMs when AI turns on.
 *
 * Why
 * ---
 * The AI auto-responder only reacts to LIVE incoming messages. So any DM
 * that arrived BEFORE the operator enabled AI on a session (or while the
 * process was down) is never answered. The operator wants: "the moment I
 * turn AI on, it replies to every personal DM from the last 24h that is
 * still awaiting a reply."
 *
 * What
 * ----
 * For a session, pull its dialogs, find PERSONAL (user) chats whose newest
 * message is inbound, unreplied, and <= MAX_AGE_HOURS old, and feed each
 * through aiChatService.handleIncomingMessage — exactly like the live
 * listener would. handleIncomingMessage already enforces DM-only (no
 * groups / channels / bots), per-session + per-chat enablement, and memory
 * dedup, so we inherit all of that. getDialogs() also warms the entity
 * cache, so the reply send resolves.
 *
 * Safety (the panel runs many jobs + 110 sessions + AI already live)
 * ------------------------------------------------------------------
 *  - Read-only against Telegram except the replies the AI chooses to send.
 *  - Never touches a chat that's already answered: we skip when our memory
 *    for that peer already ends with an outbound (AI) message at/after the
 *    dialog's last inbound id. So chats the live AI is already handling are
 *    left alone.
 *  - Jittered spacing between enqueues + a per-session cap, so we never
 *    burst the provider or Telegram.
 *  - A global in-flight guard + per-session guard so a sweep never runs
 *    twice concurrently for the same session.
 *  - Enqueue only — the existing AI worker does the actual generate+send
 *    with its own concurrency + rate-limit handling.
 */

'use strict';

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const tgService = require('./telegramService');

const ENABLED = String(process.env.AI_CATCHUP_ENABLED ?? 'true').toLowerCase() !== 'false';
const MAX_AGE_HOURS = parseInt(process.env.AI_CATCHUP_MAX_AGE_HOURS || '24', 10);
const MAX_CHATS_PER_SESSION = parseInt(process.env.AI_CATCHUP_MAX_CHATS_PER_SESSION || '60', 10);
const ENQUEUE_SPACING_MS = parseInt(process.env.AI_CATCHUP_ENQUEUE_SPACING_MS || '500', 10);
const DIALOG_LIMIT = parseInt(process.env.AI_CATCHUP_DIALOG_LIMIT || '200', 10);
// Delay before the auto-sweep fired by enabling AI on a session, so the
// listener attach + client connect settle first.
const ENABLE_SWEEP_DELAY_MS = parseInt(process.env.AI_CATCHUP_ENABLE_DELAY_MS || '4000', 10);
// Periodic safety sweep across all AI-enabled sessions.
const PERIODIC_INTERVAL_MS = parseInt(process.env.AI_CATCHUP_INTERVAL_MS || '900000', 10); // 15m

const _inFlight = new Set();     // session ids currently being swept
let _globalRunning = false;      // a full sweep is running
let _timer = null;

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Sweep one session's pending DMs and enqueue AI replies.
 * @returns {Promise<{sessionId:number, scanned:number, pending:number, enqueued:number, reason?:string}>}
 */
async function sweepSession(sessionId, userId) {
  const sid = Number(sessionId);
  if (!ENABLED) return { sessionId: sid, scanned: 0, pending: 0, enqueued: 0, reason: 'disabled' };
  if (_inFlight.has(sid)) return { sessionId: sid, scanned: 0, pending: 0, enqueued: 0, reason: 'already_running' };
  _inFlight.add(sid);

  try {
    const aiChatService = require('./aiChatService');

    // Only sweep if AI is actually enabled for this session (never enqueue
    // for a session the operator hasn't turned on).
    const settings = await aiChatService.getSessionSettings(sid).catch(() => null);
    if (!settings || !settings.enabled) {
      return { sessionId: sid, scanned: 0, pending: 0, enqueued: 0, reason: 'not_enabled' };
    }

    const entry = tgService.clients.get(String(sid));
    let client = entry && entry.client ? entry.client : null;
    if (!client) {
      try { await tgService._ensureConnected(sid); } catch { /* skip */ }
      client = tgService.clients.get(String(sid))?.client || null;
    }
    if (!client) return { sessionId: sid, scanned: 0, pending: 0, enqueued: 0, reason: 'not_connected' };

    let dialogs;
    try {
      dialogs = await client.getDialogs({ limit: DIALOG_LIMIT });
    } catch (err) {
      logger.warn(`aiCatchup: getDialogs failed for session ${sid}: ${err.message}`);
      return { sessionId: sid, scanned: 0, pending: 0, enqueued: 0, reason: `dialogs_failed` };
    }

    const cutoffMs = Date.now() - MAX_AGE_HOURS * 3600 * 1000;
    let scanned = 0, pending = 0, enqueued = 0;

    for (const dlg of dialogs || []) {
      if (enqueued >= MAX_CHATS_PER_SESSION) break;

      const entity = dlg.entity;
      // PERSONAL DMs only. handleIncomingMessage re-enforces this, but
      // filtering here avoids needless work on groups/channels/bots.
      if (!entity || entity.className !== 'User') continue;
      if (entity.bot) continue;
      if (entity.self) continue;
      const peerId = entity.id ? Number(entity.id) : null;
      if (!peerId) continue;
      if (peerId === 777000) continue; // Telegram service account
      scanned++;

      const last = dlg.message;
      if (!last) continue;
      if (last.out) continue;                 // newest msg is ours → already replied
      const lastMs = last.date ? Number(last.date) * 1000 : Date.now();
      if (lastMs < cutoffMs) continue;        // older than the 24h window
      const hasText = !!(last.message && String(last.message).trim());
      const hasMedia = !!last.media;
      if (!hasText && !hasMedia) continue;     // service/empty message
      pending++;

      // Skip if our memory already ends with an AI (outbound) message at or
      // after this dialog's last inbound id — i.e. the live AI already
      // handled it. This is what keeps us from disturbing active chats.
      try {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await pool.query(
          `SELECT (messages->-1->>'isIncoming') AS last_in,
                  (messages->-1->>'telegramMessageId') AS last_tg
             FROM ai_chat_memories
            WHERE session_id = $1 AND peer_type = 'user' AND peer_id = $2`,
          [sid, peerId]
        );
        if (rows.length) {
          const lastIn = rows[0].last_in;
          const lastTg = rows[0].last_tg != null ? Number(rows[0].last_tg) : null;
          if (lastIn === 'false' && lastTg != null && last.id != null && lastTg >= Number(last.id)) {
            continue; // already answered
          }
        }
      } catch (err) {
        logger.debug(`aiCatchup: memory check failed ${sid}/${peerId}: ${err.message}`);
      }

      const accessHash = entity.accessHash != null ? String(entity.accessHash) : null;
      const fakeEvent = {
        message: last,
        _peer: { peerType: 'user', peerId, accessHash },
        getChat: async () => entity,
        getSender: async () => entity,
      };

      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await aiChatService.handleIncomingMessage(sid, fakeEvent);
        if (res && res.handled) {
          enqueued++;
          // eslint-disable-next-line no-await-in-loop
          if (ENQUEUE_SPACING_MS > 0) await _sleep(ENQUEUE_SPACING_MS);
        }
      } catch (err) {
        logger.warn(`aiCatchup: handle failed ${sid}/${peerId}: ${err.message}`);
      }
    }

    if (pending > 0 || enqueued > 0) {
      logger.info(`aiCatchup: session ${sid} scanned=${scanned} pending=${pending} enqueued=${enqueued}`);
    }
    return { sessionId: sid, scanned, pending, enqueued };
  } finally {
    _inFlight.delete(sid);
  }
}

/**
 * Fire a one-off sweep for a single session shortly after AI is enabled on
 * it. Non-blocking (does not delay the enable request).
 */
function scheduleSessionSweep(sessionId, userId) {
  if (!ENABLED) return;
  const sid = Number(sessionId);
  setTimeout(() => {
    sweepSession(sid, userId).catch((err) =>
      logger.warn(`aiCatchup: enable-sweep error for ${sid}: ${err.message}`)
    );
  }, ENABLE_SWEEP_DELAY_MS).unref?.();
}

/**
 * Periodic safety sweep across every AI-enabled logged-in Telegram session.
 * Sequential per session so total load stays bounded.
 */
async function runSweep() {
  if (!ENABLED || _globalRunning) return { sessions: 0, enqueued: 0 };
  _globalRunning = true;
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.user_id
         FROM sessions s
         JOIN ai_session_settings a ON a.session_id = s.id
        WHERE a.enabled = TRUE AND s.is_logged_in = TRUE AND s.platform = 'telegram'
        ORDER BY s.id`
    );
    let enqueued = 0;
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      const r = await sweepSession(row.id, row.user_id).catch(() => null);
      if (r) enqueued += r.enqueued || 0;
    }
    logger.info(`aiCatchup: periodic sweep done sessions=${rows.length} enqueued=${enqueued}`);
    return { sessions: rows.length, enqueued };
  } finally {
    _globalRunning = false;
  }
}

function start() {
  if (!ENABLED) { logger.info('aiCatchup: disabled'); return; }
  if (PERIODIC_INTERVAL_MS > 0 && !_timer) {
    _timer = setInterval(() => {
      runSweep().catch((err) => logger.warn(`aiCatchup periodic error: ${err.message}`));
    }, PERIODIC_INTERVAL_MS);
    _timer.unref?.();
  }
  logger.info(`aiCatchup: started (periodic every ${Math.round(PERIODIC_INTERVAL_MS/60000)}m, window ${MAX_AGE_HOURS}h)`);
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, runSweep, sweepSession, scheduleSessionSweep };
