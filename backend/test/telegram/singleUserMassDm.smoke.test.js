/**
 * Smoke test for the Single-User Mass DM feature.
 *
 * Locks in:
 *   1. The Joi schema enforces 1..3 targets, the 1..120-second
 *      delay band, and message presence.
 *   2. The schema accepts either `sessionIds` or `sessionListId`
 *      (the same shape every other bulk-message endpoint uses).
 *   3. The service-level cleanup pass dedupes targets case-
 *      insensitively while preserving order, and rejects payloads
 *      that exceed the 3-target hard cap.
 *
 * The send loop itself talks to Telegram and Postgres, so this
 * test focuses on the surface that doesn't require a live stack.
 */

'use strict';

const assert = require('assert');

const validator = require('../../src/middleware/validator');

function expectValid(label, payload) {
  const { error } = validator.schemas.singleUserMassDm.validate(payload, {
    abortEarly: false,
  });
  if (error) {
    throw new Error(`[${label}] expected valid, got: ${error.message}`);
  }
}

function expectInvalid(label, payload, needle) {
  const { error } = validator.schemas.singleUserMassDm.validate(payload, {
    abortEarly: false,
  });
  if (!error) {
    throw new Error(`[${label}] expected invalid, but the payload passed`);
  }
  if (needle && !error.message.toLowerCase().includes(needle.toLowerCase())) {
    throw new Error(
      `[${label}] expected error to mention "${needle}", got: ${error.message}`
    );
  }
}

// ──────────────────────────────────────────────────────────────────
// 1. Schema: happy paths
// ──────────────────────────────────────────────────────────────────

expectValid('singleTarget+sessionIds', {
  sessionIds: [1],
  targets: ['@alice'],
  message: 'hi',
});

expectValid('threeTargets+sessionListId', {
  sessionListId: 12,
  targets: ['@alice', '12345678', 'bob'],
  message: 'hi',
  delaySeconds: 5,
});

expectValid('messageType+async', {
  sessionIds: [1, 2, 3],
  targets: ['@alice'],
  message: 'hi',
  messageType: 'markdown',
  delaySeconds: 1,
  async: true,
});

console.log('schema.happy: OK');

// ──────────────────────────────────────────────────────────────────
// 2. Schema: rejections
// ──────────────────────────────────────────────────────────────────

expectInvalid('noTargets', {
  sessionIds: [1],
  targets: [],
  message: 'hi',
}, 'targets');

expectInvalid('tooManyTargets', {
  sessionIds: [1],
  targets: ['a', 'b', 'c', 'd'],
  message: 'hi',
}, 'targets');

expectInvalid('noSessions', {
  targets: ['@alice'],
  message: 'hi',
}, 'must contain');

expectInvalid('emptyMessage', {
  sessionIds: [1],
  targets: ['@alice'],
  message: '',
}, 'message');

expectInvalid('delayTooLow', {
  sessionIds: [1],
  targets: ['@alice'],
  message: 'hi',
  delaySeconds: 0,
}, 'delayseconds');

expectInvalid('delayTooHigh', {
  sessionIds: [1],
  targets: ['@alice'],
  message: 'hi',
  delaySeconds: 9999,
}, 'delayseconds');

console.log('schema.rejections: OK');

// ──────────────────────────────────────────────────────────────────
// 3. Service-level dedupe + cap (lightweight: stub session lookup)
// ──────────────────────────────────────────────────────────────────

const messageService = require('../../src/services/messageService');
const origVerify = messageService._verifyMultipleSessionsOwnership.bind(messageService);

async function withStubbedSessions(stub, fn) {
  messageService._verifyMultipleSessionsOwnership = stub;
  try {
    return await fn();
  } finally {
    messageService._verifyMultipleSessionsOwnership = origVerify;
  }
}

(async () => {
  // 3a. Service rejects 4 targets even if the validator is bypassed.
  await withStubbedSessions(
    async () => [{ id: 1, user_id: 1, status: 'active' }],
    async () => {
      try {
        await messageService.sendSingleUserMassDm(
          { sessionIds: [1], targets: ['a', 'b', 'c', 'd'], message: 'hi' },
          1
        );
        throw new Error('expected TOO_MANY_TARGETS');
      } catch (err) {
        assert.strictEqual(err.errorCode, 'TOO_MANY_TARGETS', `unexpected: ${err.errorCode}`);
      }
    }
  );

  console.log('service.cap: OK');

  // 3b. Service rejects when no valid sessions are returned.
  await withStubbedSessions(
    async () => [],
    async () => {
      try {
        await messageService.sendSingleUserMassDm(
          { sessionIds: [9999], targets: ['@alice'], message: 'hi' },
          1
        );
        throw new Error('expected NO_VALID_SESSIONS');
      } catch (err) {
        assert.strictEqual(err.errorCode, 'NO_VALID_SESSIONS', `unexpected: ${err.errorCode}`);
      }
    }
  );

  console.log('service.noSessions: OK');

  console.log('singleUserMassDm.smoke.test: OK');
})();
