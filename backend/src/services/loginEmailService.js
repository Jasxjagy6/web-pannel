/**
 * LoginEmailService
 * --------------------------------------------------------------------
 * Sets a **login email** on Telegram sessions via MTProto.
 *
 * Login email ≠ recovery email. Telegram's "login email" feature
 * (introduced late 2023) lets the account receive login-verification
 * codes via email instead of SMS. When set, any new sign-in attempt
 * triggers an OTP delivery to the configured email address.
 *
 * MTProto flow:
 *   1. `account.SendVerifyEmailCode` with purpose = EmailVerifyPurposeLoginSetup
 *      → Telegram emails a numeric verification code to the address.
 *   2. `account.VerifyEmail` with purpose = EmailVerifyPurposeLoginSetup
 *      and verification = EmailVerificationCode({ code })
 *      → Confirms the email; on success the login email is active.
 *
 * This service also exposes a helper to read the currently configured
 * login email from the account's password state (if returned by
 * `account.GetPassword`).
 *
 * Public API:
 *   sendCode(sessionId, email)                   → { codeLength }
 *   verifyCode(sessionId, email, code)            → { verified: true }
 *   getLoginEmailStatus(sessionId)                → { hasLoginEmail, email? }
 *   validateEmail(email)                          → boolean
 */

'use strict';

const { Api } = require('telegram/tl');
const tgService = require('./telegramService');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (email.length > 254) return false;
  return EMAIL_REGEX.test(email.trim());
}

/**
 * Wrap GramJS / Telegram error into an AppError with a human-readable
 * message and an error code the frontend can react to.
 */
function wrapTelegramError(err, context) {
  const tgMessage = (err && (err.errorMessage || err.message)) || String(err);
  const tgCode = (err && err.errorMessage) || 'TELEGRAM_ERROR';

  if (/FLOOD_WAIT/i.test(tgMessage)) {
    const match = tgMessage.match(/(\d+)/);
    const seconds = match ? parseInt(match[1], 10) : 0;
    return new AppError(
      `Rate limited by Telegram. Wait ${seconds} seconds before retrying.`,
      429,
      'FLOOD_WAIT'
    );
  }

  if (/EMAIL_NOT_ALLOWED/i.test(tgMessage)) {
    return new AppError(
      'Telegram does not allow setting a login email on this account (may require a phone number).',
      400,
      'EMAIL_NOT_ALLOWED'
    );
  }

  if (/EMAIL_INVALID/i.test(tgMessage)) {
    return new AppError('Telegram rejected this email address.', 400, 'EMAIL_INVALID');
  }

  if (/CODE_INVALID/i.test(tgMessage) || /EMAIL_VERIFY_EXPIRED/i.test(tgMessage)) {
    return new AppError(
      'The verification code is invalid or expired.',
      400,
      'CODE_INVALID'
    );
  }

  if (/EMAIL_VERIFY_FAILED/i.test(tgMessage)) {
    return new AppError(
      'Email verification failed. The code may be wrong or expired.',
      400,
      'VERIFY_FAILED'
    );
  }

  return new AppError(
    `Telegram error during ${context}: ${tgMessage}`,
    502,
    tgCode.length > 60 ? tgCode.slice(0, 60) : tgCode
  );
}

/**
 * Ensure the session is connected and return the GramJS client.
 * @param {number|string} sessionId
 * @returns {Promise<import('telegram').TelegramClient>}
 */
async function _getClient(sessionId) {
  await tgService._ensureConnected(sessionId);
  const entry = tgService.clients.get(String(sessionId));
  if (!entry || !entry.client) {
    throw new AppError(`Session ${sessionId} has no live client`, 400, 'NO_CLIENT');
  }
  return entry.client;
}

/**
 * Step 1: Send a verification code to the given email address for
 * login-email setup.
 *
 * @param {number|string} sessionId
 * @param {string} email
 * @returns {Promise<{ codeLength: number }>}
 */
async function sendCode(sessionId, email) {
  if (!validateEmail(email)) {
    throw new AppError('Invalid email address', 400, 'INVALID_EMAIL');
  }

  const client = await _getClient(sessionId);

  try {
    const result = await tgService._withFloodRetry(sessionId, async () => {
      return await client.invoke(
        new Api.account.SendVerifyEmailCode({
          purpose: new Api.EmailVerifyPurposeLoginSetup(),
          email: email.trim(),
        })
      );
    });

    const codeLength = result && result.length ? result.length : 6;
    logger.info(
      `Login email verification code sent for session ${sessionId} to ${email} (codeLength=${codeLength})`
    );
    return { codeLength };
  } catch (err) {
    throw wrapTelegramError(err, 'SendVerifyEmailCode');
  }
}

/**
 * Step 2: Verify the code that Telegram emailed to the address.
 * On success the email is set as the login email for this account.
 *
 * @param {number|string} sessionId
 * @param {string} email
 * @param {string} code
 * @returns {Promise<{ verified: true }>}
 */
async function verifyCode(sessionId, email, code) {
  if (!validateEmail(email)) {
    throw new AppError('Invalid email address', 400, 'INVALID_EMAIL');
  }
  if (!code || typeof code !== 'string' || !code.trim()) {
    throw new AppError('Verification code is required', 400, 'CODE_REQUIRED');
  }

  const client = await _getClient(sessionId);

  try {
    await tgService._withFloodRetry(sessionId, async () => {
      return await client.invoke(
        new Api.account.VerifyEmail({
          purpose: new Api.EmailVerifyPurposeLoginSetup(),
          verification: new Api.EmailVerificationCode({ code: code.trim() }),
        })
      );
    });

    logger.info(`Login email verified for session ${sessionId}: ${email}`);
    return { verified: true };
  } catch (err) {
    throw wrapTelegramError(err, 'VerifyEmail');
  }
}

/**
 * Check whether the session already has a login email configured.
 * Uses `account.GetPassword` which returns the email pattern if set.
 *
 * @param {number|string} sessionId
 * @returns {Promise<{ hasLoginEmail: boolean, emailPattern: string|null }>}
 */
async function getLoginEmailStatus(sessionId) {
  const client = await _getClient(sessionId);

  try {
    const pwd = await tgService._withFloodRetry(sessionId, async () => {
      return await client.invoke(new Api.account.GetPassword());
    });

    // Telegram exposes the login email pattern (e.g. "j***@gmail.com")
    // through the password response when one is configured.
    const loginEmailPattern = pwd && pwd.loginEmailPattern
      ? String(pwd.loginEmailPattern)
      : null;

    return {
      hasLoginEmail: !!loginEmailPattern,
      emailPattern: loginEmailPattern,
    };
  } catch (err) {
    throw wrapTelegramError(err, 'GetPassword (login email check)');
  }
}

module.exports = {
  sendCode,
  verifyCode,
  getLoginEmailStatus,
  validateEmail,
};
