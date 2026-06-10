/**
 * LoginMailService
 * --------------------------------------------------------------------
 * Sets a *login email* on Telegram accounts via MTProto.
 *
 * This is distinct from the recovery-email flow (which goes through
 * account.UpdatePasswordSettings). The login email is the address
 * Telegram sends a verification code to when you log in — set via:
 *
 *   1. account.SendVerifyEmailCode({ purpose: EmailVerifyPurposeLoginSetup, email })
 *      → SentEmailCode { emailPattern, length }
 *
 *   2. account.VerifyEmail({ purpose: EmailVerifyPurposeLoginSetup,
 *                            verification: EmailVerificationCode({ code }) })
 *      → account.EmailVerified
 *
 * Public API:
 *   sendLoginEmailCode(sessionId, email)    → { emailPattern, codeLength }
 *   verifyLoginEmailCode(sessionId, code)   → { verified: true }
 */

'use strict';

const { Api } = require('telegram');
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
 * Map common Telegram MTProto error strings to user-friendly AppErrors.
 */
function wrapTelegramError(err, context) {
  const tgMessage = (err && (err.errorMessage || err.message)) || String(err);
  const tgCode = (err && err.errorMessage) || 'TELEGRAM_ERROR';

  if (/FLOOD_WAIT/i.test(tgMessage)) {
    const match = tgMessage.match(/(\d+)/);
    const seconds = match ? parseInt(match[1], 10) : 0;
    return new AppError(
      `Rate limited by Telegram. Wait ${seconds}s before retrying.`,
      429,
      'FLOOD_WAIT'
    );
  }

  if (/EMAIL_NOT_ALLOWED/i.test(tgMessage)) {
    return new AppError(
      'Telegram does not allow setting a login email on this account.',
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

  if (/EMAIL_VERIFY_EXPIRED/i.test(tgMessage)) {
    return new AppError(
      'The verification code has expired. Please re-send.',
      400,
      'CODE_EXPIRED'
    );
  }

  return new AppError(
    `Telegram error during ${context}: ${tgMessage}`,
    502,
    tgCode.slice(0, 60)
  );
}

/**
 * Send a verification code to `email` for setting it as the login
 * email on the Telegram account behind `sessionId`.
 *
 * @param {number|string} sessionId
 * @param {string} email
 * @returns {Promise<{ emailPattern: string, codeLength: number }>}
 */
async function sendLoginEmailCode(sessionId, email) {
  if (!validateEmail(email)) {
    throw new AppError('Invalid email address', 400, 'INVALID_EMAIL');
  }

  await tgService._ensureConnected(sessionId);
  const entry = tgService.clients.get(String(sessionId));
  if (!entry || !entry.client) {
    throw new AppError(`Session ${sessionId} has no live client`, 400, 'NO_CLIENT');
  }
  const client = entry.client;

  try {
    const result = await tgService._withFloodRetry(sessionId, async () => {
      return await client.invoke(
        new Api.account.SendVerifyEmailCode({
          purpose: new Api.EmailVerifyPurposeLoginSetup(),
          email: email.trim(),
        })
      );
    });

    logger.info(
      `Login email code sent for session ${sessionId} to ${email} ` +
      `(pattern=${result.emailPattern}, length=${result.length})`
    );

    return {
      emailPattern: result.emailPattern || '',
      codeLength: result.length || 6,
    };
  } catch (err) {
    throw wrapTelegramError(err, 'SendVerifyEmailCode');
  }
}

/**
 * Verify the login-email code.
 *
 * @param {number|string} sessionId
 * @param {string} code  — the numeric code from the email
 * @returns {Promise<{ verified: true }>}
 */
async function verifyLoginEmailCode(sessionId, code) {
  if (!code || typeof code !== 'string' || !code.trim()) {
    throw new AppError('Verification code is required', 400, 'CODE_REQUIRED');
  }

  await tgService._ensureConnected(sessionId);
  const entry = tgService.clients.get(String(sessionId));
  if (!entry || !entry.client) {
    throw new AppError(`Session ${sessionId} has no live client`, 400, 'NO_CLIENT');
  }
  const client = entry.client;

  try {
    await tgService._withFloodRetry(sessionId, async () => {
      return await client.invoke(
        new Api.account.VerifyEmail({
          purpose: new Api.EmailVerifyPurposeLoginSetup(),
          verification: new Api.EmailVerificationCode({
            code: code.trim(),
          }),
        })
      );
    });

    logger.info(`Login email verified for session ${sessionId}`);
    return { verified: true };
  } catch (err) {
    throw wrapTelegramError(err, 'VerifyEmail');
  }
}

module.exports = {
  sendLoginEmailCode,
  verifyLoginEmailCode,
  validateEmail,
};
