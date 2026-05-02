/**
 * Instagram OTP (provider.otp.*).
 *
 * IG's flow is the inverse of TG's: instead of passively listening for an
 * incoming "Telegram Login Code" message, IG ACTIVELY pushes an OTP to
 * the user's SMS / email when a challenge is hit. The session creation
 * flow already handles that path (see ./create.js, requires:'challenge').
 *
 * What this module exposes is a thin "request a fresh challenge code" API
 * for cases where the original code expires or arrives mangled.
 */

const { pool } = require('../../config/database');
const igClient = require('./client');
const logger = require('../../utils/logger');

async function _session({ userId, sessionId }) {
  const r = await pool.query(
    `SELECT id, user_id, username, proxy_url, session_data, platform_state
       FROM sessions
      WHERE id = $1 AND user_id = $2 AND platform = 'instagram'`,
    [sessionId, userId]
  );
  if (r.rows.length === 0) {
    const e = new Error('Instagram session not found');
    e.statusCode = 404;
    throw e;
  }
  return r.rows[0];
}

async function startScan(_args) {
  // IG doesn't have the TG-style "monitor incoming OTP from a special
  // chat" flow — return a stub-shape result so callers can degrade.
  const e = new Error('Passive OTP scan is TG-only. Use the active challenge resend in /sessions/create/resend.');
  e.code = 'NOT_SUPPORTED_ON_INSTAGRAM';
  throw e;
}

async function requestCode({ userId, sessionId, method = 'sms' }) {
  const session = await _session({ userId, sessionId });
  const client = await igClient.getClient(session);
  // method: 0 = sms, 1 = email
  const choice = method === 'email' ? 1 : 0;
  try {
    const reply = await client.challenge.selectVerifyMethod(choice);
    logger.info(`IG.otp.requestCode session=${sessionId} method=${method}`);
    return reply || { ok: true };
  } catch (err) {
    logger.warn(`IG.otp.requestCode session=${sessionId}: ${err.message}`);
    throw err;
  }
}

async function listScans(_userId) {
  return { scans: [], total: 0 };
}

async function pollScan(_args) {
  return { ok: false, reason: 'not_supported_on_instagram' };
}

async function cancelScan(_args) {
  return { ok: false, reason: 'not_supported_on_instagram' };
}

module.exports = {
  startScan,
  requestCode,
  listScans,
  list: listScans,
  pollScan,
  poll: pollScan,
  cancelScan,
  cancel: cancelScan,
};
