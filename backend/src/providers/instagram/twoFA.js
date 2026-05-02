/**
 * Instagram 2FA management (provider.twoFA.*).
 *
 * Supports TOTP enable/disable/regenerate via instagram-private-api's
 * `accountSecurity` feed.
 *
 *   await provider.twoFA.enable({ userId, sessionId })
 *     → { totp_seed, recovery_codes, ... }
 *
 *   await provider.twoFA.disable({ userId, sessionId, code })
 *     → { ok: true }
 *
 *   await provider.twoFA.change({ userId, sessionId, code })
 *     → equivalent to disable+enable.
 *
 * 2FA jobs (queued/scheduled bulk enable across many sessions) keep using
 * the TG-shared `twoFAJobService` table; the executor will dispatch by
 * platform when the worker picks up the job.
 */

const { pool } = require('../../config/database');
const igClient = require('./client');
const twoFAJobService = require('../../services/twoFAJobService');
const logger = require('../../utils/logger');

async function _session({ userId, sessionId }) {
  const r = await pool.query(
    `SELECT id, user_id, username, proxy_url, session_data, platform_state
       FROM sessions
      WHERE id = $1 AND user_id = $2 AND platform = 'instagram'
        AND is_logged_in = TRUE`,
    [sessionId, userId]
  );
  if (r.rows.length === 0) {
    const e = new Error('Instagram session not found or not logged-in');
    e.statusCode = 404;
    throw e;
  }
  return r.rows[0];
}

async function enable({ userId, sessionId }) {
  const session = await _session({ userId, sessionId });
  const client = await igClient.getClient(session);
  if (typeof client.account.enableTwoFactor !== 'function') {
    throw new Error('instagram-private-api does not expose 2FA TOTP enable yet on this version');
  }
  const out = await client.account.enableTwoFactor();
  logger.info(`IG.twoFA.enable user=${userId} session=${sessionId}`);
  return out;
}

async function disable({ userId, sessionId }) {
  const session = await _session({ userId, sessionId });
  const client = await igClient.getClient(session);
  if (typeof client.account.disableTwoFactor !== 'function') {
    throw new Error('instagram-private-api does not expose 2FA TOTP disable yet on this version');
  }
  const out = await client.account.disableTwoFactor();
  logger.info(`IG.twoFA.disable user=${userId} session=${sessionId}`);
  return out;
}

async function change(args) {
  await disable(args).catch(() => { /* tolerate */ });
  return enable(args);
}

// Job APIs delegate to the shared twoFAJobService (which is platform-aware
// via the platform column on twofa_jobs from migration v9).
function listJobs(...args) { return twoFAJobService.listJobs(...args); }
function startJob(...args) { return twoFAJobService.startJob(...args); }
function cancelJob(...args) { return twoFAJobService.cancelJob ? twoFAJobService.cancelJob(...args) : null; }

module.exports = {
  enable,
  disable,
  change,
  listJobs,
  startJob,
  cancelJob,
};
