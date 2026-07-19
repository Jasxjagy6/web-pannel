/**
 * aiCatchupService — sweep pending, unreplied DMs and drive AI replies.
 *
 * Why this exists
 * ---------------
 * The AI auto-responder is driven purely by the live GramJS NewMessage
 * listener. That listener only fires for messages that arrive AFTER it is
 * attached, so anything that landed while the process was down (deploy,
 * crash, reconnect) — or before AI was enabled on the session — is never
 * answered. In production this left 350+ DMs sitting unanswered, some for
 * days, even though every session was logged in and AI-enabled.
 *
 * What it does
 * ------------
 * For every AI-enabled + logged-in Telegram session, it:
 *   1. Calls client.getDialogs() — this ALSO repopulates GramJS's entity
 *      cache for each peer, which fixes the "Could not find the input
 *      entity" send failures that happen for peers we haven't interacted
 *      with since the last restart.
 *   2. Finds DM dialogs whose latest message is INCOMING and unreplied.
 *   3. Feeds the newest incoming message of each such chat through
 *      aiChatService.handleIncomingMessage(), exactly as the live
 *      listener would — so memory, per-chat settings, provider routing
 *      and logging all work identically.
 *
 * Pacing / rate-limit safety
 * --------------------------
 * We space enqueues with a small delay and cap how many chats we enqueue
 * per session per sweep, so the queue drains steadily instead of in a
 * thundering herd. Job de-duplication in aiChatService collapses rapid
 * duplicates so CapitalBot never sees two concurrent requests for one
 * useridentifier (the "Request in progress" 429).
 *
 * READ-ONLY against Telegram except for the replies the AI sends.
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const tgService = require('./telegramService');

const SWEEP_ENABLED =
  String(process.env.AI_CATCHUP_ENABLED ?? 'true').toLowerCase() !== 'false';
const MAX_CHATS_PER_SESSION = parseInt(process.env.AI_CATCHUP_MAX_CHATS_PER_SESSION || '40', 10);
const ENQUEUE_SPACING_MS = parseInt(process.env.AI_CATCHUP_ENQUEUE_SPACING_MS || '400', 10);
const MAX_AGE_HOURS = parseInt(process.env.AI_CATCHUP_MAX_AGE_HOURS || '168', 10);
const PERIODIC_INTERVAL_MS = parseInt(process.env.AI_CATCHUP_INTERVAL_MS || '600000', 10);
const DIALOG_LIMIT = parseInt(process.env.AI_CATCHUP_DIALOG_LIMIT || '200', 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let _running = false;
let _timer = null;

/**
 * Sweep one session: pull dialogs, find pending unreplied DMs, enqueue AI.
 * @returns {Promise<{ sessionId:number, scanned:number, pending:number, enqueued:number, reason?:string }>}
 */
async function sweepSession(sessionId, userId) {
  const sid = Number(sessionId);
  const aiChatService = require('./aiChatService');

  const entry = tgService.clients.get(String(sid));
  if (!entry || !entry.client) {
    return { sessionId: sid, scanned: 0, pending: 0, enqueued: 0, reason: 'not_connected' };
  }
  const client = entry.client;

  let dialogs;
  try {
    // getDialogs repopulates the entity cache for every peer — this is
    // what makes the subsequent AI send able to resolve the input entity.
    dialogs = await client.getDialogs({ limit: DIALOG_LIMIT });
  } catch (err) {
    logger.warn(`aiCatchup: getDialogs failed for session ${sid}: ${err.message}`);
    return { sessionId: sid, scanned: 0, pending: 0, enqueued: 0, reason: `dialogs_failed: ${err.message}` };
  }

  const cutoffMs = Date.now() - MAX_AGE_HOURS * 3600 * 1000;

  let scanned = 0;
  let pending = 0;
  let enqueued = 0;

  for (const dlg of dialogs || []) {
    if (enqueued >= MAX_CHATS_PER_SESSION) break;

    const entity = dlg.entity;
    if (!entity || entity.className !== 'User') continue; // DMs only
    if (entity.bot) continue; // never AI-reply to bots
    if (entity.self) continue; // skip Saved Messages
    scanned++;

    const peerId = entity.id ? Number(entity.id) : null;
    if (!peerId) continue;
    // 777000 is Telegram's own service account (login codes, security
    // alerts). Never AI-reply to it.
    if (peerId === 777000) continue;

    const last = dlg.message;
    if (!last) continue;

    // Only chats awaiting OUR reply: newest message must be incoming.
    if (last.out) continue;

    const lastMs = last.date ? Number(last.date) * 1000 : Date.now();
    if (lastMs < cutoffMs) continue;

    const hasText = !!(last.message && String(last.message).trim());
    const hasMedia = !!last.media;
    if (!hasText && !hasMedia) continue;

    pending++;

    // Skip if memory already ends with an AI (outgoing) message at/after
    // this dialog's last incoming id — already answered.
    try {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        `SELECT (messages->-1->>'isIncoming') AS last_incoming,
                (messages->-1->>'telegramMessageId') AS last_tg_id
           FROM ai_chat_memories
          WHERE session_id = $1 AND peer_type = 'user' AND peer_id = $2`,
        [sid, peerId]
      );
      if (rows.length) {
        const lastIncoming = rows[0].last_incoming;
        const lastTgId = rows[0].last_tg_id ? Number(rows[0].last_tg_id) : null;
        if (lastIncoming === 'false' && lastTgId != null && last.id != null && lastTgId >= Number(last.id)) {
          continue;
        }
      }
    } catch (err) {
      logger.debug(`aiCatchup: memory check failed for ${sid}/${peerId}: ${err.message}`);
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
        if (ENQUEUE_SPACING_MS > 0) await sleep(ENQUEUE_SPACING_MS);
      }
    } catch (err) {
      logger.warn(`aiCatchup: handleIncomingMessage failed for ${sid}/${peerId}: ${err.message}`);
    }
  }

  if (pending > 0 || enqueued > 0) {
    logger.info(`aiCatchup: session ${sid} scanned=${scanned} pending=${pending} enqueued=${enqueued}`);
  }
  return { sessionId: sid, scanned, pending, enqueued };
}

/**
 * Run one full sweep across every AI-enabled + logged-in Telegram session.
 * @returns {Promise<{ sessions:number, enqueued:number, results:Array }>}
 */
async function runSweep() {
  if (!SWEEP_ENABLED) {
    logger.info('aiCatchup: disabled via AI_CATCHUP_ENABLED=false');
    return { sessions: 0, enqueued: 0, results: [] };
  }
  if (_running) {
    logger.info('aiCatchup: sweep already running, skipping');
    return { sessions: 0, enqueued: 0, results: [], reason: 'already_running' };
  }
  _running = true;

  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.user_id
         FROM sessions s
         JOIN ai_session_settings a ON a.session_id = s.id
        WHERE a.enabled = TRUE
          AND s.is_logged_in = TRUE
          AND s.platform = 'telegram'
        ORDER BY s.id`
    );

    const results = [];
    let totalEnqueued = 0;

    for (const row of rows) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await sweepSession(row.id, row.user_id);
        results.push(res);
        totalEnqueued += res.enqueued || 0;
      } catch (err) {
        logger.warn(`aiCatchup: sweepSession ${row.id} threw: ${err.message}`);
        results.push({ sessionId: Number(row.id), scanned: 0, pending: 0, enqueued: 0, reason: err.message });
      }
    }

    logger.info(`aiCatchup: sweep complete sessions=${rows.length} totalEnqueued=${totalEnqueued}`);
    return { sessions: rows.length, enqueued: totalEnqueued, results };
  } finally {
    _running = false;
  }
}

/**
 * Start the catch-up subsystem: an initial boot sweep (after sessions have
 * restored), then a periodic timer.
 */
function start(opts = {}) {
  if (!SWEEP_ENABLED) {
    logger.info('aiCatchup: not started (AI_CATCHUP_ENABLED=false)');
    return;
  }
  const bootDelayMs = opts.bootDelayMs != null
    ? opts.bootDelayMs
    : parseInt(process.env.AI_CATCHUP_BOOT_DELAY_MS || '90000', 10);

  setTimeout(() => {
    runSweep().catch((err) => logger.warn(`aiCatchup boot sweep error: ${err.message}`));
  }, bootDelayMs).unref?.();

  if (PERIODIC_INTERVAL_MS > 0) {
    _timer = setInterval(() => {
      runSweep().catch((err) => logger.warn(`aiCatchup periodic sweep error: ${err.message}`));
    }, PERIODIC_INTERVAL_MS);
    _timer.unref?.();
    logger.info(
      `aiCatchup: started (boot sweep in ${Math.round(bootDelayMs / 1000)}s, ` +
      `then every ${Math.round(PERIODIC_INTERVAL_MS / 60000)}m)`
    );
  } else {
    logger.info(`aiCatchup: started (boot sweep in ${Math.round(bootDelayMs / 1000)}s, no periodic)`);
  }
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { start, stop, runSweep, sweepSession };
