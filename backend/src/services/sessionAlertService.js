/**
 * SessionAlertService — Anti-revoke Phase 4
 *
 * Sends a real-time Telegram DM to whoever owns a panel session
 * whenever something dangerous happens to it (strike recorded,
 * session entered the unconfirmed window, session marked revoked,
 * session recovered). Reuses the existing TELEGRAM_ADMIN_BOT_TOKEN
 * that already runs the upgrade-orchestrator bot, so no new
 * dependencies and no new chat rotations.
 *
 * Routing logic:
 *
 *   1. If tg_session_health.alert_chat_id is set on the session
 *      row, use that. (Per-session override.)
 *   2. Otherwise, if the session's owning user has linked their
 *      Telegram chat ID (users.telegram_chat_id), send to that.
 *   3. Otherwise, broadcast to every chat ID listed in
 *      TELEGRAM_ADMIN_IDS so the operator at least sees the alert.
 *   4. If TELEGRAM_ADMIN_BOT_TOKEN is unset, log a warning and
 *      drop the alert silently — we don't want to crash sessionService.
 *
 * Cooldown: per (sessionId, kind) — minimum
 * ANTI_REVOKE_PHASE_4_ALERT_COOLDOWN_MS between two alerts of the
 * same kind for the same session, enforced via tg_session_health
 * (last_alert_at, last_alert_kind). Prevents the heartbeat from
 * spamming the user when the same problem fires every tick.
 */

const { request } = require('undici');
const logger = require('../utils/logger');
const { pool } = require('../config/database');
const cfg = require('../config/telegram');

const TOKEN_ENV = 'TELEGRAM_ADMIN_BOT_TOKEN';
const ADMINS_ENV = 'TELEGRAM_ADMIN_IDS';

function getToken() {
  return (process.env[TOKEN_ENV] || '').trim();
}

function getDefaultAdminIds() {
  return (process.env[ADMINS_ENV] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the chat IDs to send a session-related alert to.
 * @param {number|string} sessionId
 * @returns {Promise<string[]>}
 */
async function resolveChatIds(sessionId) {
  const ids = new Set();
  try {
    const r = await pool.query(
      `SELECT h.alert_chat_id
         FROM tg_session_health h
        WHERE h.session_id = $1`,
      [sessionId]
    );
    const chat = r.rows[0] && r.rows[0].alert_chat_id;
    if (chat) ids.add(String(chat));
  } catch { /* tg_session_health may not exist yet */ }

  if (ids.size === 0) {
    try {
      // users.telegram_chat_id is added opportunistically (some
      // forks of the panel have it, some don't) — be tolerant.
      const r = await pool.query(
        `SELECT u.id, u.telegram_chat_id
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.id = $1`,
        [sessionId]
      );
      const chat = r.rows[0] && r.rows[0].telegram_chat_id;
      if (chat) ids.add(String(chat));
    } catch (err) {
      // column missing — fall through to TELEGRAM_ADMIN_IDS
      logger.debug(`resolveChatIds: users.telegram_chat_id missing (${err.message})`);
    }
  }

  if (ids.size === 0) {
    for (const id of getDefaultAdminIds()) {
      ids.add(id);
    }
  }

  return Array.from(ids);
}

/**
 * Check whether enough time has passed since the last alert of the
 * given kind to send a new one. Mutates the row to record this attempt.
 * @returns {Promise<boolean>} true if the alert is allowed to proceed
 */
async function reserveAlertSlot(sessionId, kind) {
  const cooldownMs = Math.max(0, cfg.ANTI_REVOKE_PHASE_4_ALERT_COOLDOWN_MS || 0);
  if (cooldownMs <= 0) return true;
  try {
    const r = await pool.query(
      `INSERT INTO tg_session_health (session_id, last_alert_at, last_alert_kind, updated_at)
       VALUES ($1, NOW(), $2, NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         last_alert_at   = CASE
           WHEN tg_session_health.last_alert_kind IS DISTINCT FROM EXCLUDED.last_alert_kind
                OR tg_session_health.last_alert_at IS NULL
                OR EXTRACT(EPOCH FROM (NOW() - tg_session_health.last_alert_at)) * 1000 >= $3
             THEN NOW()
           ELSE tg_session_health.last_alert_at
         END,
         last_alert_kind = CASE
           WHEN tg_session_health.last_alert_kind IS DISTINCT FROM EXCLUDED.last_alert_kind
                OR tg_session_health.last_alert_at IS NULL
                OR EXTRACT(EPOCH FROM (NOW() - tg_session_health.last_alert_at)) * 1000 >= $3
             THEN EXCLUDED.last_alert_kind
           ELSE tg_session_health.last_alert_kind
         END,
         updated_at      = NOW()
       RETURNING last_alert_at = NOW() AS allowed`,
      [sessionId, kind, cooldownMs]
    );
    return !!(r.rows[0] && r.rows[0].allowed);
  } catch (err) {
    // tg_session_health missing — better to send than silently drop
    logger.debug(`reserveAlertSlot: ${err.message}`);
    return true;
  }
}

/**
 * Lowest-level send. Uses the admin bot's HTTP API; never throws.
 */
async function sendOne(chatId, text) {
  const token = getToken();
  if (!token) {
    logger.debug('sessionAlertService: TELEGRAM_ADMIN_BOT_TOKEN unset; skipping');
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const body = await res.body.json().catch(() => ({}));
    if (!body || !body.ok) {
      logger.warn(
        `sessionAlertService: sendMessage(${chatId}) failed: ${JSON.stringify(body)}`
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(`sessionAlertService: sendMessage error: ${err.message}`);
    return false;
  }
}

async function fanOut(sessionId, kind, text) {
  if (!cfg.ANTI_REVOKE_PHASE_4_ENABLED) return false;
  const allowed = await reserveAlertSlot(sessionId, kind);
  if (!allowed) {
    logger.debug(
      `sessionAlertService: cooldown active for session ${sessionId} kind=${kind}; suppressed`
    );
    return false;
  }
  const chatIds = await resolveChatIds(sessionId);
  if (chatIds.length === 0) {
    logger.debug(`sessionAlertService: no chat ids resolvable for session ${sessionId}`);
    return false;
  }
  let sent = 0;
  for (const id of chatIds) {
    if (await sendOne(id, text)) sent++;
  }
  return sent > 0;
}

async function loadPhone(sessionId) {
  try {
    const r = await pool.query(`SELECT phone FROM sessions WHERE id = $1`, [sessionId]);
    return (r.rows[0] && r.rows[0].phone) || `#${sessionId}`;
  } catch {
    return `#${sessionId}`;
  }
}

module.exports = {
  /**
   * Below-threshold strike alert. Fired by `_recordRevokeSignal` and
   * `_recordExternalRevokeSignal`.
   */
  async alertStrike(sessionId, info) {
    const phone = await loadPhone(sessionId);
    const code = (info && info.code) || 'unknown';
    const streak = (info && info.streak) || 1;
    const threshold = (info && info.threshold) || 2;
    const kind = (info && info.kind) === 'external' ? 'external-strike' : 'strike';
    const text =
      `⚠️ <b>Panel session warning</b>\n\n` +
      `Session: <code>${phone}</code>\n` +
      `Signal:  <code>${code}</code> (${streak}/${threshold})\n\n` +
      `Telegram returned a permanent-auth error but we have NOT marked the session ` +
      `revoked yet. We'll wait for one more strike before disconnecting. ` +
      `If this turns into a real revocation, you'll get a 🚨 follow-up.`;
    return fanOut(sessionId, kind, text);
  },

  /**
   * Final revocation alert. Fired from `_markSessionAuthRevoked`.
   */
  async alertRevoked(sessionId, reason) {
    const phone = await loadPhone(sessionId);
    const text =
      `🚨 <b>Panel session REVOKED</b>\n\n` +
      `Session: <code>${phone}</code>\n` +
      `Reason:  <code>${reason || 'unknown'}</code>\n\n` +
      `The most common cause is "Terminate all other sessions" being tapped on ` +
      `your phone. Try clicking <b>Recover</b> on the Sessions page — if the ` +
      `auth key is still valid, the panel will rejoin without a new SMS.`;
    return fanOut(sessionId, 'revoked', text);
  },

  /**
   * Recovered-from-backup notice. Fired from `recoverSession`.
   */
  async alertRecovered(sessionId, source) {
    const phone = await loadPhone(sessionId);
    const text =
      `✅ <b>Panel session recovered</b>\n\n` +
      `Session: <code>${phone}</code>\n` +
      `Source:  <code>${source || 'on-disk'}</code>\n\n` +
      `getMe succeeded; the session is back to status='active' and the ` +
      `heartbeat will resume on the next tick.`;
    return fanOut(sessionId, 'recovered', text);
  },

  /**
   * Test hook for the controller route. Doesn't touch the cooldown
   * counter so a developer can hammer it without waiting.
   */
  async sendTest(sessionId, message) {
    const chatIds = await resolveChatIds(sessionId);
    if (chatIds.length === 0) return { sent: 0, total: 0 };
    let sent = 0;
    for (const id of chatIds) {
      if (await sendOne(id, message)) sent++;
    }
    return { sent, total: chatIds.length };
  },
};
