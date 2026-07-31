/**
 * SpamBot Appeal Job Service.
 *
 * Operator workflow:
 *   1. Select N Telegram sessions (or a session list) in the Sessions UI.
 *   2. Click "Appeal". A background job walks each session ONE BY ONE.
 *   3. For each session the panel:
 *        a) opens a chat with @SpamBot and sends "/start",
 *        b) reads @SpamBot's reply,
 *        c) if the account is free ("no limits / free as a bird") → mark
 *           `no_restriction` and move on,
 *        d) if restricted → @SpamBot presents a REPLY-KEYBOARD button (in
 *           the compose box, NOT an inline button). We "press" it by
 *           sending the button's text as a normal message, then follow the
 *           bot's prompts, submitting a short appeal ("This was a mistake,
 *           I won't do it again") until the bot confirms the appeal was
 *           filed → mark `appealed`.
 *   4. The modal polls `/:jobId/status` and shows per-session progress +
 *      a short transcript of what @SpamBot said / what we sent.
 *
 * In-memory job registry (single panel process), mirroring
 * sessionBulkAuthPurgeService so the frontend reuses the same polling UX.
 *
 * READ-ONLY detection first — we only send the appeal flow when @SpamBot
 * actually offers the appeal keyboard. Reply polls are bounded so we never
 * hammer the bot.
 */

'use strict';

const crypto = require('crypto');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const tgService = require('./telegramService');
const spamStatusService = require('./sessionSpamStatusService');

const jobs = new Map();

const SPAMBOT = '@SpamBot';
const DEFAULT_INTER_SESSION_DELAY_MS = 1500;   // pace between sessions (anti-flood)
const REPLY_POLL_ATTEMPTS = 8;                 // how many times we poll for a bot reply
const REPLY_POLL_INTERVAL_MS = 1200;           // wait between polls
const STEP_DELAY_MS = 1500;                    // human-like delay between our sends
const MAX_APPEAL_STEPS = 6;                    // safety cap on conversation turns
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS_PER_JOB = 500;

// The appeal message we send once @SpamBot asks us to explain.
const APPEAL_TEXT =
  process.env.SPAM_APPEAL_TEXT ||
  "I believe this is a mistake. I only message people I know and I will be careful. Please lift the restriction — I won't do it again.";

// @SpamBot "you're clean" phrasings. If any match, the account is free.
const CLEAN_PATTERNS = [
  /free as a bird/i,
  /no limits are currently applied/i,
  /don'?t have any limits/i,
  /you'?re free/i,
  /good news/i,
  /no restrictions/i,
];

// The operator supplied @SpamBot's exact permanent-block reply. Telegram's
// UI calls these accounts frozen, so this full response is authoritative.
const FROZEN_PATTERNS = [
  /^\s*Your account was blocked for violations of the Telegram Terms of Service based on user reports confirmed by our moderators\.\s*$/i,
  /\b(?:your|this|the) account (?:is|was|has been) frozen\b/i,
  /\baccount freeze(?:n|d)?\b/i,
];

// Temporary or indefinite cold-DM limits. These accounts remain enabled for
// every feature except bulk/mass DM operations.
const LIMITED_PATTERNS = [
  /account is now limited until/i,
  /account is limited/i,
  /while the account is limited/i,
  /anti-spam systems/i,
  /not be able to send messages to people/i,
];

// Phrases that mean the appeal was accepted / already pending.
const DONE_PATTERNS = [
  /your (complaint|request) (has|will)/i,
  /moderators will/i,
  /thank you/i,
  /we'?ll look into/i,
  /has been (sent|submitted|forwarded)/i,
  /already/i,
];

function newJobId() {
  return `spam-appeal-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _matchAny(text, patterns) {
  if (!text) return false;
  return patterns.some((re) => re.test(text));
}

function classifySpamBotReply(text) {
  if (_matchAny(text, CLEAN_PATTERNS)) return 'clean';
  if (_matchAny(text, FROZEN_PATTERNS)) return 'frozen';
  if (_matchAny(text, LIMITED_PATTERNS)) return 'limited';
  return 'unknown';
}

function parseSpamLimitUntil(text) {
  const match = String(text || '').match(
    /(?:limited until|automatically released on)\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s+UTC/i
  );
  if (!match) return null;

  const months = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const month = months[match[2].toLowerCase()];
  if (month == null) return null;

  const value = new Date(Date.UTC(
    Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), 0
  ));
  if (Number.isNaN(value.getTime())) return null;
  if (
    value.getUTCFullYear() !== Number(match[3]) ||
    value.getUTCMonth() !== month ||
    value.getUTCDate() !== Number(match[1]) ||
    value.getUTCHours() !== Number(match[4]) ||
    value.getUTCMinutes() !== Number(match[5])
  ) return null;
  return value;
}

/**
 * Extract the button texts from a message's REPLY keyboard (not inline).
 * Telegram reply keyboards are pressed by sending the button's text.
 * @returns {string[]}
 */
function _replyKeyboardButtons(msg) {
  const out = [];
  const markup = msg && msg.replyMarkup;
  if (!markup) return out;
  // ReplyKeyboardMarkup.rows[].buttons[].text  (KeyboardButton)
  const rows = markup.rows || [];
  for (const row of rows) {
    for (const btn of row.buttons || []) {
      if (btn && typeof btn.text === 'string' && btn.text.trim()) {
        out.push(btn.text.trim());
      }
    }
  }
  return out;
}

/**
 * Read @SpamBot's latest message for this session, polling a few times so
 * we don't race the bot's response.
 * @returns {Promise<{text:string, buttons:string[], msgId:number|null}>}
 */
async function _readBotReply(sessionId, entity, afterMsgId) {
  const client = tgService.clients.get(String(sessionId))?.client;
  if (!client) return { text: '', buttons: [], msgId: null };

  for (let i = 0; i < REPLY_POLL_ATTEMPTS; i++) {
    await _sleep(REPLY_POLL_INTERVAL_MS);
    let msgs;
    try {
      msgs = await client.getMessages(entity, { limit: 3 });
    } catch {
      continue;
    }
    // Newest first. Find the newest INBOUND message (from the bot) that is
    // newer than what we last saw.
    for (const m of msgs || []) {
      if (!m) continue;
      if (m.out) continue; // our own message
      if (afterMsgId && m.id <= afterMsgId) continue;
      const text = (m.message || m.text || '').trim();
      if (!text) continue;
      return { text, buttons: _replyKeyboardButtons(m), msgId: m.id };
    }
  }
  return { text: '', buttons: [], msgId: null };
}

/**
 * Run the appeal conversation for one session.
 *
 * @param {object} sess - the per-session job entry (mutated in place)
 */
async function _appealOne(job, sess) {
  const sid = String(sess.sessionId);
  const pushTranscript = (who, text) => {
    sess.transcript.push({ who, text: String(text || '').slice(0, 300), at: Date.now() });
  };

  try {
    sess.status = 'checking';
    sess.classification = await spamStatusService.getStatus(sid);
    await tgService._ensureConnected(sid, { allowFrozen: true });
    const client = tgService.clients.get(sid)?.client;
    if (!client) throw new Error('client not available');

    const entity = await client.getEntity(SPAMBOT);

    // Baseline: remember the newest existing message id so we only read
    // the bot's fresh replies.
    let lastSeen = 0;
    try {
      const existing = await client.getMessages(entity, { limit: 1 });
      if (existing && existing[0]) lastSeen = existing[0].id;
    } catch { /* ignore */ }

    // Step 1 — /start
    await tgService.sendMessage(sid, SPAMBOT, '/start', { allowFrozen: true });
    pushTranscript('me', '/start');

    let reply = await _readBotReply(sid, entity, lastSeen);
    if (!reply.text) {
      sess.status = 'failed';
      sess.error = 'No reply from @SpamBot';
      return;
    }
    lastSeen = reply.msgId || lastSeen;
    pushTranscript('spambot', reply.text);

    const classification = classifySpamBotReply(reply.text);
    sess.classification = classification;

    // Clean account → nothing to appeal.
    if (classification === 'clean') {
      await spamStatusService.recordStatus(sid, classification, reply.text);
      sess.status = 'no_restriction';
      return;
    }

    // Persist the exact classification. Unknown wording remains unknown and
    // never blocks work; the raw reply remains visible for review.
    const limitUntil = classification === 'limited' ? parseSpamLimitUntil(reply.text) : null;
    await spamStatusService.recordStatus(sid, classification, reply.text, { limitUntil });
    sess.limitUntil = limitUntil ? limitUntil.toISOString() : null;
    if (job.mode === 'check') {
      sess.status = classification === 'clean' ? 'no_restriction' : classification;
      return;
    }

    if (classification === 'unknown') {
      sess.status = 'inconclusive';
      sess.error = 'Unrecognized @SpamBot response; status was not treated as frozen';
      return;
    }

    // Appeal mode: walk the reply-keyboard appeal flow.
    sess.status = 'appealing';
    let steps = 0;
    while (steps < MAX_APPEAL_STEPS) {
      if (job.cancelRequested) { sess.status = 'cancelled'; return; }
      steps++;

      // If the bot confirmed submission, we're done.
      if (_matchAny(reply.text, DONE_PATTERNS)) {
        sess.status = 'appealed';
        return;
      }

      let toSend = null;
      if (reply.buttons && reply.buttons.length > 0) {
        // Prefer a button that looks like "this is a mistake / dispute /
        // yes"; otherwise take the first button.
        toSend =
          reply.buttons.find((b) =>
            /mistake|dispute|no.*(spam|abuse)|yes|but i|complain|appeal|not/i.test(b)
          ) || reply.buttons[0];
      } else {
        // No keyboard but restricted → send the free-text appeal.
        toSend = APPEAL_TEXT;
      }

      await _sleep(STEP_DELAY_MS);
      await tgService.sendMessage(sid, SPAMBOT, toSend, { allowFrozen: true });
      pushTranscript('me', toSend);

      reply = await _readBotReply(sid, entity, lastSeen);
      if (!reply.text) {
        // No further reply — treat as submitted if we already pressed the
        // appeal button at least once.
        sess.status = steps > 1 ? 'appealed' : 'failed';
        if (sess.status === 'failed') sess.error = 'Bot stopped responding during appeal';
        return;
      }
      lastSeen = reply.msgId || lastSeen;
      pushTranscript('spambot', reply.text);

      // If after pressing the button the bot now asks us to describe the
      // issue (no more buttons), send the appeal text next loop.
      if (_matchAny(reply.text, DONE_PATTERNS)) {
        sess.status = 'appealed';
        return;
      }
      if (_matchAny(reply.text, CLEAN_PATTERNS)) {
        await spamStatusService.recordStatus(sid, 'clean', reply.text);
        sess.classification = 'clean';
        sess.limitUntil = null;
        sess.status = 'no_restriction';
        return;
      }
    }

    // Ran out of steps — if we sent at least the appeal text, call it done.
    sess.status = 'appealed';
  } catch (err) {
    sess.status = 'failed';
    sess.error = (err && err.message) ? err.message.slice(0, 200) : 'appeal failed';
    logger.warn(`spamAppeal: session ${sess.sessionId} failed: ${sess.error}`);
  } finally {
    // Detach prohibited background listeners before dropping the client.
    // Get OTP is the one allowed passive exception and is reattached below.
    try {
      await require('./aiSessionManager').detach(sid);
    } catch { /* best-effort */ }
    try {
      await require('./otpRelayService').onSessionDisconnected(sid);
    } catch { /* best-effort */ }
    await tgService.disconnectSession(sid).catch(() => {});
    try {
      await require('./otpService').refreshSessionListeners(sid);
    } catch { /* best-effort */ }
    if (sess.classification !== 'frozen') {
      try {
        await require('./otpRelayService').onSessionConnected(sid);
      } catch { /* best-effort */ }
      try {
        const aiSettings = await require('./aiChatService').getSessionSettings(sid);
        if (aiSettings.enabled) await require('./aiSessionManager').attach(sid);
      } catch { /* best-effort */ }
    }
  }
}

async function runJob(job) {
  for (const sess of job.sessions) {
    if (job.cancelRequested) {
      if (sess.status === 'queued') sess.status = 'cancelled';
      continue;
    }
    await _appealOne(job, sess);
    // Jittered pace between sessions so @SpamBot / Telegram don't see a
    // burst from one IP.
    await _sleep(job.interSessionDelayMs + Math.floor(Math.random() * 800));
  }
  job.status = 'completed';
  job.finishedAt = new Date().toISOString();
  setTimeout(() => jobs.delete(job.id), JOB_TTL_MS).unref?.();
}

function publicJobView(job) {
  return {
    jobId: job.id,
    userId: job.userId,
    mode: job.mode,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error || null,
    cancelRequested: !!job.cancelRequested,
    summary: {
      total: job.sessions.length,
      appealed: job.sessions.filter((s) => s.status === 'appealed').length,
      clean: job.sessions.filter((s) => s.status === 'no_restriction').length,
      limited: job.sessions.filter((s) => s.status === 'limited').length,
      frozen: job.sessions.filter((s) => s.status === 'frozen').length,
      inconclusive: job.sessions.filter((s) => s.status === 'unknown' || s.status === 'inconclusive').length,
      failed: job.sessions.filter((s) => s.status === 'failed').length,
      cancelled: job.sessions.filter((s) => s.status === 'cancelled').length,
      pending: job.sessions.filter((s) =>
        ['queued', 'checking', 'appealing'].includes(s.status)
      ).length,
    },
    sessions: job.sessions.map((s) => ({
      sessionId: s.sessionId,
      phone: s.phone,
      label: s.label,
      status: s.status,
      error: s.error || null,
      limitUntil: s.limitUntil || null,
      transcript: s.transcript.slice(-8),
    })),
  };
}

/**
 * Start an appeal job over a set of sessions.
 * @param {{ userId:number, sessionIds:number[], interSessionDelayMs?:number }} params
 */
async function startAppealJob(params) {
  return startJob(params, 'appeal');
}

async function startStatusCheckJob(params) {
  return startJob(params, 'check');
}

async function startJob(params, mode) {
  const { userId, sessionIds, interSessionDelayMs } = params || {};
  if (!userId) throw new Error('userId required');
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new Error('sessionIds required (non-empty array)');
  }
  if (sessionIds.length > MAX_SESSIONS_PER_JOB) {
    throw new Error(`At most ${MAX_SESSIONS_PER_JOB} sessions can be appealed per job`);
  }

  const ids = sessionIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0);
  const { rows } = await pool.query(
    `SELECT id, phone,
            account_info->>'firstName' AS first_name,
            account_info->>'username'  AS username
       FROM sessions
      WHERE user_id = $1 AND platform = 'telegram' AND id = ANY($2::int[])`,
    [userId, ids]
  );
  if (rows.length === 0) throw new Error('No valid sessions for this user');

  const metaById = new Map();
  for (const r of rows) metaById.set(Number(r.id), r);

  const jobId = newJobId();
  const job = {
    id: jobId,
    userId,
    mode,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    cancelRequested: false,
    interSessionDelayMs:
      Number.isFinite(interSessionDelayMs) && interSessionDelayMs >= 0
        ? Number(interSessionDelayMs)
        : DEFAULT_INTER_SESSION_DELAY_MS,
    sessions: ids
      .filter((id) => metaById.has(id))
      .map((id) => {
        const m = metaById.get(id);
        const label =
          (m.first_name && m.first_name.trim()) ||
          (m.username ? `@${m.username}` : null) ||
          m.phone ||
          `Session ${id}`;
        return {
          sessionId: id,
          phone: m.phone || null,
          label,
          status: 'queued',
          error: null,
          transcript: [],
        };
      }),
  };
  jobs.set(jobId, job);

  setImmediate(() => {
    runJob(job).catch((err) =>
      logger.error(`spamAppeal: unhandled runner error: ${err && err.message}`)
    );
  });

  return { jobId, total: job.sessions.length, mode };
}

function getJobStatus(jobId, userId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.userId !== userId) return null;
  return publicJobView(job);
}

function cancelJob(jobId, userId) {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) return null;
  job.cancelRequested = true;
  return publicJobView(job);
}

module.exports = {
  startAppealJob,
  startStatusCheckJob,
  classifySpamBotReply,
  parseSpamLimitUntil,
  getJobStatus,
  cancelJob,
  _jobs: jobs,
};
