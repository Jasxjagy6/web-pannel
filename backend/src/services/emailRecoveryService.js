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

  const passwordRequest = await tgService._withFloodRetry(sessionId, async () => {
    return await client.invoke(new Api.account.GetPassword());
  });

  const has2FA = !!(passwordRequest && passwordRequest.currentAlgo);

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

  await tgService._withFloodRetry(sessionId, async () => {
    return await client.invoke(
      new Api.account.VerifyEmail({
        email: email.trim(),
        code: code.trim(),
      })
    );
  });

  logger.info(`Recovery email verified for session ${sessionId}: ${email}`);
  return { success: true, verified: true };
}

module.exports = {
  sendCode,
  verifyCode,
  validateEmail,
};
