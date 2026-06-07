'use strict';

const { Api } = require('telegram');
const { computeCheck: gramjsComputeCheck } = require('telegram/Password');
const tgService = require('./telegramService');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (email.length > 254) return false;
  return EMAIL_REGEX.test(email.trim());
}

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

  if (/EMAIL_UNCONFIRMED/i.test(tgMessage)) {
    return new AppError(
      'There is a pending unconfirmed email on this account. It will be cancelled automatically — please retry.',
      400,
      'EMAIL_UNCONFIRMED_PENDING'
    );
  }

  if (/EMAIL_INVALID/i.test(tgMessage)) {
    return new AppError('Telegram rejected this email address.', 400, 'EMAIL_INVALID');
  }

  if (/CODE_INVALID/i.test(tgMessage) || /PHONE_CODE_INVALID/i.test(tgMessage)) {
    return new AppError('The verification code is invalid or expired.', 400, 'CODE_INVALID');
  }

  if (/PASSWORD_HASH_INVALID/i.test(tgMessage)) {
    return new AppError('The 2FA cloud password is incorrect.', 400, 'TWO_FA_PASSWORD_INVALID');
  }

  return new AppError(`Telegram error during ${context}: ${tgMessage}`, 502, tgCode.slice(0, 60));
}

async function sendCode(sessionId, email, twoFAPassword) {
  if (!validateEmail(email)) {
    throw new AppError('Invalid email address', 400, 'INVALID_EMAIL');
  }

  await tgService._ensureConnected(sessionId);
  const entry = tgService.clients.get(String(sessionId));
  if (!entry || !entry.client) {
    throw new AppError(`Session ${sessionId} has no live client`, 400, 'NO_CLIENT');
  }
  const client = entry.client;

  let passwordRequest;
  try {
    passwordRequest = await tgService._withFloodRetry(sessionId, async () => {
      return await client.invoke(new Api.account.GetPassword());
    });
  } catch (err) {
    throw wrapTelegramError(err, 'GetPassword');
  }

  const has2FA = !!(passwordRequest && passwordRequest.currentAlgo);

  if (passwordRequest && passwordRequest.emailUnconfirmedPattern) {
    logger.info(
      `Session ${sessionId} has unconfirmed email (${passwordRequest.emailUnconfirmedPattern}), cancelling it before setting new email`
    );
    try {
      await tgService._withFloodRetry(sessionId, async () => {
        return await client.invoke(new Api.account.CancelPasswordEmail());
      });
      // Re-fetch password state after cancellation
      passwordRequest = await tgService._withFloodRetry(sessionId, async () => {
        return await client.invoke(new Api.account.GetPassword());
      });
    } catch (err) {
      throw wrapTelegramError(err, 'CancelPasswordEmail');
    }
  }

  let passwordSrp;
  if (has2FA) {
    if (!twoFAPassword) {
      throw new AppError(
        'This session has 2FA enabled. Enter the cloud password to proceed.',
        400,
        'TWO_FA_PASSWORD_REQUIRED'
      );
    }
    try {
      passwordSrp = await gramjsComputeCheck(passwordRequest, twoFAPassword);
    } catch (e) {
      throw new AppError(
        `2FA password verification failed: ${e.message}`,
        400,
        'TWO_FA_PASSWORD_INVALID'
      );
    }
  } else {
    passwordSrp = new Api.InputCheckPasswordEmpty();
  }

  try {
    await tgService._withFloodRetry(sessionId, async () => {
      return await client.invoke(
        new Api.account.UpdatePasswordSettings({
          password: passwordSrp,
          newSettings: new Api.account.PasswordInputSettings({
            newAlgo: undefined,
            newPasswordHash: undefined,
            hint: undefined,
            email: email.trim(),
          }),
        })
      );
    });
  } catch (err) {
    throw wrapTelegramError(err, 'UpdatePasswordSettings');
  }

  logger.info(`Recovery email code sent for session ${sessionId} to ${email}`);
  return { success: true, awaitingCode: true, has2FA };
}

async function verifyCode(sessionId, email, code) {
  if (!validateEmail(email)) {
    throw new AppError('Invalid email address', 400, 'INVALID_EMAIL');
  }

  if (!code || typeof code !== 'string' || code.trim().length === 0) {
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
          email: email.trim(),
          code: code.trim(),
        })
      );
    });
  } catch (err) {
    throw wrapTelegramError(err, 'VerifyEmail');
  }

  logger.info(`Recovery email verified for session ${sessionId}: ${email}`);
  return { success: true, verified: true };
}

module.exports = {
  sendCode,
  verifyCode,
  validateEmail,
};
