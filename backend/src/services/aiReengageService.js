/**
 * aiReengageService — keep silent users engaged.
 *
 * Goal: when the AI's last message to a user goes unanswered, proactively
 * send a natural re-engagement message so the conversation stays alive —
 * NOT a fixed "?" and NOT on a fixed 1-hour timer.
 *
 * How it works
 * ------------
 * A periodic scan finds chats (AI-enabled, DM-only) where our memory ends
 * with an OUTBOUND (AI) message — i.e. the user hasn't replied. Each such
 * chat is given a RANDOM silence threshold (default 10–25 min, jittered per
 * chat) that must elapse before we nudge. When it does, we enqueue a normal
 * AI job whose chatHistory ends with the assistant message — CapitalBot
 * then AUTO-GENERATES a contextual follow-up (in the user's language, e.g.
 * Italian), which is far better than a hardcoded "?".
 *
 * Anti-spam / safety
 * ------------------
 *  - At most one nudge per silence period, and a hard cap on total nudges
 *    per chat (default 3) so we never spam.
 *  - Only chats whose last activity is within the 24h window are eligible;
 *    truly dead chats are left alone.
 *  - The user replying resets everything (memory then ends with an inbound
 *    message, so the chat is no longer a candidate and the nudge counters
 *    are cleared on their next AI reply).
 *  - Skips 777000, groups, channels, bots (the AI pipeline re-enforces
 *    DM-only anyway).
 *  - Nudge state is stored on the memory row (JSONB) — no schema change.
 */

'use strict';

const { pool } = require('../config/database');
const logger = require('../utils/logger');

const ENABLED = String(process.env.AI_REENGAGE_ENABLED ?? 'true').toLowerCase() !== 'false';
// Random silence window before a nudge — pick a fresh value per chat so the
// timing looks human (sometimes 10m, sometimes 25m).
const MIN_SILENCE_MIN = parseInt(process.env.AI_REENGAGE_MIN_MIN || '30', 10);
const MAX_SILENCE_MIN = parseInt(process.env.AI_REENGAGE_MAX_MIN || '60', 10);
// After a nudge, wait AT LEAST this long (also randomised up to *2) before
// the next nudge on the same still-silent chat.
const RENUDGE_MIN_MIN = parseInt(process.env.AI_REENGAGE_RENUDGE_MIN || '120', 10);
const MAX_NUDGES = parseInt(process.env.AI_REENGAGE_MAX_NUDGES || '3', 10);
const WINDOW_HOURS = parseInt(process.env.AI_REENGAGE_WINDOW_HOURS || '24', 10);
const SCAN_INTERVAL_MS = parseInt(process.env.AI_REENGAGE_SCAN_INTERVAL_MS || '300000', 10); // 5m
const MAX_PER_SCAN = parseInt(process.env.AI_REENGAGE_MAX_PER_SCAN || '8', 10);
const ENQUEUE_SPACING_MS = parseInt(process.env.AI_REENGAGE_SPACING_MS || '3000', 10);

let _timer = null;
let _running = false;

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function _randMin(a, b) { return a + Math.random() * Math.max(0, b - a); }

/**
 * Find chats where the AI spoke last and the user is silent past their
 * randomised threshold, and enqueue a CapitalBot auto follow-up for each.
 */
async function runScan() {
  if (!ENABLED || _running) return { candidates: 0, nudged: 0 };
  // Runtime toggle — check the DB setting so the admin can turn
  // re-engagement on/off from the Settings page without a restart.
  const sysSettings = require('./systemSettingsService');
  if (!(await sysSettings.isReengageEnabled())) {
    _running = false;
    return { candidates: 0, nudged: 0, disabled: true };
  }
  _running = true;
  try {
    // Candidate chats: AI enabled, DM (user), last memory message is
    // OUTBOUND (AI), within the 24h window, and idle at least MIN_SILENCE.
    const { rows } = await pool.query(
      `SELECT m.session_id, m.peer_id, m.updated_at,
              m.messages, m.reengage
         FROM ai_chat_memories m
         JOIN ai_session_settings a ON a.session_id = m.session_id
         JOIN sessions s ON s.id = m.session_id
        WHERE a.enabled = TRUE
          AND s.is_logged_in = TRUE
          AND s.platform = 'telegram'
          AND m.peer_type = 'user'
          AND m.peer_id <> 777000
          AND (m.messages->-1->>'isIncoming')::boolean = FALSE
          AND m.updated_at > NOW() - ($1 || ' hours')::interval
          AND m.updated_at < NOW() - ($2 || ' minutes')::interval
          -- Skip PERMANENTLY UNREACHABLE peers (stale access_hash →
          -- PEER_ID_INVALID). Nudging them just fails and wastes actions.
          AND NOT EXISTS (
            SELECT 1 FROM ai_response_logs l
             WHERE l.session_id = m.session_id AND l.peer_id = m.peer_id
               AND l.status = 'send_failed'
               AND (l.error_message ILIKE '%PEER_ID_INVALID%'
                    OR l.error_message ILIKE '%input entity%')
               AND l.created_at > NOW() - INTERVAL '7 days'
          )
        ORDER BY m.updated_at ASC
        LIMIT 500`,
      [String(WINDOW_HOURS), String(MIN_SILENCE_MIN)]
    );

    let nudged = 0;
    const aiChatService = require('./aiChatService');

    for (const row of rows) {
      if (nudged >= MAX_PER_SCAN) break;

      const st = (row.reengage && typeof row.reengage === 'object') ? row.reengage : {};
      const count = Number(st.count || 0);
      if (count >= MAX_NUDGES) continue; // already nudged enough — leave it

      const idleMs = Date.now() - new Date(row.updated_at).getTime();

      // The threshold this chat must exceed. First nudge uses a random
      // 10–25m; subsequent nudges use a longer random re-nudge gap. The
      // chosen threshold is persisted so it stays stable between scans.
      let thresholdMs = st.thresholdMs;
      if (!thresholdMs) {
        thresholdMs = count === 0
          ? _randMin(MIN_SILENCE_MIN, MAX_SILENCE_MIN) * 60000
          : _randMin(RENUDGE_MIN_MIN, RENUDGE_MIN_MIN * 2) * 60000;
      }

      // Only nudge once the idle time since the LAST nudge (or last AI msg)
      // exceeds the randomised threshold.
      const sinceRef = st.lastNudgeAt ? (Date.now() - st.lastNudgeAt) : idleMs;
      if (sinceRef < thresholdMs) continue;

      // Pre-flight reachability check: proactively resolving the peer's
      // input entity avoids enqueuing a doomed send (stale access_hash →
      // PEER_ID_INVALID) that would just fail and drag the success rate.
      // Live user-initiated replies never need this (they carry a fresh
      // peer) — it only matters for these PROACTIVE nudges.
      try {
        const tgService = require('./telegramService');
        const entry = tgService.clients.get(String(row.session_id));
        const client = entry && entry.client ? entry.client : null;
        if (!client) continue; // session not connected right now — try later
        // eslint-disable-next-line no-await-in-loop
        await client.getInputEntity(Number(row.peer_id));
      } catch (_) {
        // Unreachable — mark it so subsequent scans skip it, and move on
        // WITHOUT a failed send.
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `UPDATE ai_chat_memories
              SET reengage = $3::jsonb
            WHERE session_id = $1 AND peer_type = 'user' AND peer_id = $2`,
          [row.session_id, Number(row.peer_id),
           JSON.stringify({ count: MAX_NUDGES, unreachable: true, at: Date.now() })]
        ).catch(() => {});
        continue;
      }

      try {
        // Re-invoke the AI for this chat. With CapitalBot, a chatHistory
        // ending in the assistant message triggers its automatic follow-up
        // generation — a natural, in-language re-engagement message.
        // eslint-disable-next-line no-await-in-loop
        const res = await aiChatService.enqueueFollowUp(row.session_id, 'user', Number(row.peer_id));
        if (res && res.handled) {
          nudged++;
          // Persist nudge state: bump count, stamp time, pick a NEW random
          // threshold for the next round so timing keeps varying.
          const nextThreshold = _randMin(RENUDGE_MIN_MIN, RENUDGE_MIN_MIN * 2) * 60000;
          // eslint-disable-next-line no-await-in-loop
          await pool.query(
            `UPDATE ai_chat_memories
                SET reengage = $4::jsonb
              WHERE session_id = $1 AND peer_type = 'user' AND peer_id = $2`,
            [row.session_id, Number(row.peer_id), null,
             JSON.stringify({ count: count + 1, lastNudgeAt: Date.now(), thresholdMs: nextThreshold })]
          );
          // eslint-disable-next-line no-await-in-loop
          if (ENQUEUE_SPACING_MS > 0) await _sleep(ENQUEUE_SPACING_MS);
        }
      } catch (err) {
        logger.warn(`aiReengage: nudge failed ${row.session_id}/${row.peer_id}: ${err.message}`);
      }
    }

    if (nudged > 0) {
      logger.info(`aiReengage: scan done candidates=${rows.length} nudged=${nudged}`);
    }
    return { candidates: rows.length, nudged };
  } finally {
    _running = false;
  }
}

function start() {
  if (!ENABLED) { logger.info('aiReengage: disabled'); return; }
  if (!_timer) {
    _timer = setInterval(() => {
      runScan().catch((err) => logger.warn(`aiReengage scan error: ${err.message}`));
    }, SCAN_INTERVAL_MS);
    _timer.unref?.();
  }
  logger.info(
    `aiReengage: started (scan every ${Math.round(SCAN_INTERVAL_MS/1000)}s, ` +
    `nudge after random ${MIN_SILENCE_MIN}-${MAX_SILENCE_MIN}m, max ${MAX_NUDGES}/chat)`
  );
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, runScan };
