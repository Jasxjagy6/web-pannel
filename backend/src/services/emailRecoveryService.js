'use strict';

const { Api } = require('telegram');
const { computeCheck: gramjsComputeCheck } = require('telegram/Password');
const tgService = require('./telegramService');
const logger = require('../utils/logger');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (email.length > 254) return false;
  return EMAIL_REGEX.test(email.trim());
}

async function sendCode(sessionId, email, twoFAPassword) {
  if (!validateEmail(email)) {
    const err = new Error('Invalid email address');
    err.code = 'INVALID_EMAIL';
    err.statusCode = 400;
    throw err;
  }

  await tgService._ensureConnected(sessionId);
  const entry = tgService.clients.get(String(sessionId));
  if (!entry || !entry.client) {
    const err = new Error(`Session ${sessionId} has no live client`);
    err.code = 'NO_CLIENT';
    err.statusCode = 400;
    throw err;
  }
  const client = entry.client;

  const passwordRequest = await tgService._withFloodRetry(sessionId, async () => {
    return await client.invoke(new Api.account.GetPassword());
  });

  const has2FA = !!(passwordRequest && passwordRequest.currentAlgo);

  let passwordSrp;
  if (has2FA) {
    if (!twoFAPassword) {
      const err = new Error('This session has 2FA enabled. A cloud password is required.');
      err.code = 'TWO_FA_PASSWORD_REQUIRED';
      err.statusCode = 400;
      throw err;
    }
    try {
      passwordSrp = await gramjsComputeCheck(passwordRequest, twoFAPassword);
    } catch (e) {
      const err = new Error(`2FA password verification failed: ${e.message}`);
      err.code = 'TWO_FA_PASSWORD_INVALID';
      err.statusCode = 400;
      throw err;
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
    const err = new Error('Invalid email address');
    err.code = 'INVALID_EMAIL';
    err.statusCode = 400;
    throw err;
  }

  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    const err = new Error('Verification code is required');
    err.code = 'CODE_REQUIRED';
    err.statusCode = 400;
    throw err;
  }

  await tgService._ensureConnected(sessionId);
  const entry = tgService.clients.get(String(sessionId));
  if (!entry || !entry.client) {
    const err = new Error(`Session ${sessionId} has no live client`);
    err.code = 'NO_CLIENT';
    err.statusCode = 400;
    throw err;
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
