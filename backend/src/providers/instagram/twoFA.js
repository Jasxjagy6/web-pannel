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

/**
 * Best-effort status read. Most builds of instagram-private-api expose
 * `account.twoFactorAccountSettings()` which returns a snapshot like:
 *   { is_two_factor_enabled, totp_two_factor_enabled,
 *     sms_two_factor_enabled, whatsapp_two_factor_enabled,
 *     trusted_devices: [...] }
 * If the version on disk doesn't expose that we fall back to a derived
 * state inferred from `account.currentUser()` (which carries
 * `is_2fa_enabled` on newer responses).
 *
 * Always returns a normalised object so the frontend can render a
 * deterministic UI:
 *   {
 *     is_enabled,
 *     totp_enabled,
 *     sms_enabled,
 *     whatsapp_enabled,
 *     methods,         // ['totp','sms','whatsapp']
 *     trusted_devices, // count
 *     supported,       // false when the SDK can't read status at all
 *     raw,             // the SDK response, for debugging
 *   }
 */
async function status({ userId, sessionId }) {
  const session = await _session({ userId, sessionId });
  const client = await igClient.getClient(session);
  const out = {
    is_enabled: false,
    totp_enabled: false,
    sms_enabled: false,
    whatsapp_enabled: false,
    methods: [],
    trusted_devices: 0,
    supported: false,
    raw: null,
  };

  if (typeof client.account.twoFactorAccountSettings === 'function') {
    try {
      const r = await client.account.twoFactorAccountSettings();
      out.raw = r;
      out.totp_enabled = !!r.totp_two_factor_enabled;
      out.sms_enabled = !!r.sms_two_factor_enabled;
      out.whatsapp_enabled = !!r.whatsapp_two_factor_enabled;
      out.is_enabled =
        !!r.is_two_factor_enabled ||
        out.totp_enabled || out.sms_enabled || out.whatsapp_enabled;
      if (out.totp_enabled) out.methods.push('totp');
      if (out.sms_enabled) out.methods.push('sms');
      if (out.whatsapp_enabled) out.methods.push('whatsapp');
      out.trusted_devices = Array.isArray(r.trusted_devices)
        ? r.trusted_devices.length : 0;
      out.supported = true;
      return out;
    } catch (err) {
      logger.warn(`IG.twoFA.status.twoFactorAccountSettings failed: ${err.message}`);
    }
  }

  // Fallback — read account.currentUser() which carries is_2fa_enabled
  // on some builds. Best effort only.
  try {
    const me = await client.account.currentUser();
    out.raw = { from: 'currentUser', is_2fa_enabled: !!me.is_2fa_enabled };
    out.is_enabled = !!me.is_2fa_enabled;
    out.supported = true;
    return out;
  } catch (err) {
    logger.warn(`IG.twoFA.status.currentUser fallback failed: ${err.message}`);
    return out; // supported=false
  }
}

async function enable({ userId, sessionId }) {
  const session = await _session({ userId, sessionId });
  const client = await igClient.getClient(session);
  if (typeof client.account.enableTwoFactor !== 'function') {
    const e = new Error(
      'This build of instagram-private-api does not expose TOTP enable. ' +
      'Enable 2FA from inside the official Instagram app, then reload this page — ' +
      'the panel will surface the trusted-devices list and disable button as soon ' +
      'as IG returns the seed.'
    );
    e.statusCode = 501;
    e.code = 'NOT_SUPPORTED';
    throw e;
  }
  const out = await client.account.enableTwoFactor();
  logger.info(`IG.twoFA.enable user=${userId} session=${sessionId}`);
  return out;
}

async function disable({ userId, sessionId }) {
  const session = await _session({ userId, sessionId });
  const client = await igClient.getClient(session);
  if (typeof client.account.disableTwoFactor !== 'function') {
    const e = new Error(
      'This build of instagram-private-api does not expose TOTP disable. ' +
      'Disable 2FA from inside the official Instagram app instead.'
    );
    e.statusCode = 501;
    e.code = 'NOT_SUPPORTED';
    throw e;
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
  status,
  enable,
  disable,
  change,
  listJobs,
  startJob,
  cancelJob,
};
