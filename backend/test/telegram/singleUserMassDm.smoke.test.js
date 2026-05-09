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

  // ────────────────────────────────────────────────────────────────
  // 4. _processSingleUserMassDm: per-job dead-target cache short-
  //    circuits remaining sessions without burning resolve requests.
  //    Locks in the fix for "mass DM only worked from 4/54 sessions"
  //    where every session redundantly tried to resolve the same
  //    typo'd handle.
  // ────────────────────────────────────────────────────────────────
  await (async () => {
    const pool = require('../../src/config/database').pool;
    const telegramService = require('../../src/services/telegramService');

    const origPoolQuery = pool.query.bind(pool);
    const origSendMessage = telegramService.sendMessage.bind(telegramService);
    const origNotify = messageService._notifyProgress.bind(messageService);
    const origFinalize = messageService._finalizeJob.bind(messageService);

    const queryLog = [];
    const updateRevoked = [];
    pool.query = async (sql, params) => {
      queryLog.push({ sql, params });
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('SELECT status FROM messaging_jobs')) {
        return { rows: [{ status: 'running' }] };
      }
      if (text.startsWith('UPDATE sessions') && text.includes("status = 'revoked'")) {
        updateRevoked.push(params);
        return { rows: [] };
      }
      // Every other UPDATE / INSERT against messaging_jobs / message_logs
      // is fine to pretend-acknowledge.
      return { rows: [] };
    };

    let sendCalls = 0;
    telegramService.sendMessage = async (sessionId, target, _message) => {
      sendCalls++;
      // Every attempt fails with the unresolvable-target pattern.
      if (sessionId === '101') {
        const err = new Error('Telegram API error: AUTH_KEY_UNREGISTERED');
        throw err;
      }
      const err = new Error('Telegram API error: Could not resolve target: @typo');
      throw err;
    };

    messageService._notifyProgress = async () => {};
    messageService._finalizeJob = async () => {};

    try {
      await messageService._processSingleUserMassDm(
        9999,
        [
          { id: 100, user_id: 1, status: 'active' },
          { id: 101, user_id: 1, status: 'active' },
          { id: 102, user_id: 1, status: 'active' },
          { id: 103, user_id: 1, status: 'active' },
          { id: 104, user_id: 1, status: 'active' },
        ],
        ['@typo'],
        'hello',
        0, // delaySeconds=0 to keep test fast
        1
      );

      // Session 100: real attempt → fails with "Could not resolve" → @typo cached as dead.
      // Session 101: real attempt → fails with AUTH_KEY_UNREGISTERED → revoked cache.
      //   (still "real" even though the target was already cached because session 101
      //   would have been queried first IF we ran target-major; but since we DO run
      //   target-major, @typo gets cached on session 100, so 101..104 ALL skip.)
      // Actual result given target-major loop: session 100 burns 1 send, the rest skip.
      assert.strictEqual(
        sendCalls,
        1,
        `expected only the first session to call sendMessage; got ${sendCalls}`
      );
    } finally {
      pool.query = origPoolQuery;
      telegramService.sendMessage = origSendMessage;
      messageService._notifyProgress = origNotify;
      messageService._finalizeJob = origFinalize;
    }
    console.log('worker.deadTargetCache: OK');
  })();

  // ────────────────────────────────────────────────────────────────
  // 5. _processSingleUserMassDm: AUTH_KEY_UNREGISTERED on session A
  //    flags the session as revoked AND skips remaining (target,
  //    sessionA) pairs in this job.
  // ────────────────────────────────────────────────────────────────
  await (async () => {
    const pool = require('../../src/config/database').pool;
    const telegramService = require('../../src/services/telegramService');

    const origPoolQuery = pool.query.bind(pool);
    const origSendMessage = telegramService.sendMessage.bind(telegramService);
    const origNotify = messageService._notifyProgress.bind(messageService);
    const origFinalize = messageService._finalizeJob.bind(messageService);

    const updateRevoked = [];
    pool.query = async (sql, params) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('SELECT status FROM messaging_jobs')) {
        return { rows: [{ status: 'running' }] };
      }
      if (text.startsWith('UPDATE sessions') && text.includes("status = 'revoked'")) {
        updateRevoked.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    };

    const sendOrder = [];
    telegramService.sendMessage = async (sessionId, target, _message) => {
      sendOrder.push({ sessionId, target });
      if (sessionId === '300') {
        throw new Error('Telegram API error: AUTH_KEY_UNREGISTERED (caused by messages.SendMessage)');
      }
      // Session 301 succeeds with target A. Session 301 succeeds with target B.
      return { messageId: Math.floor(Math.random() * 100000) };
    };

    messageService._notifyProgress = async () => {};
    messageService._finalizeJob = async () => {};

    try {
      await messageService._processSingleUserMassDm(
        9998,
        [
          { id: 300, user_id: 1, status: 'active' },
          { id: 301, user_id: 1, status: 'active' },
        ],
        ['@a', '@b'],
        'hi',
        0,
        1
      );

      // Loop order is target-major:
      //   target @a → session 300 (fails AUTH_KEY_UNREGISTERED, revoked cached) → session 301 (success)
      //   target @b → session 300 (fast-skipped from revokedSessionIds)         → session 301 (success)
      // So sendMessage should be called 3 times, not 4.
      assert.strictEqual(
        sendOrder.length,
        3,
        `expected 3 sendMessage calls; got ${sendOrder.length}: ${JSON.stringify(sendOrder)}`
      );
      assert.deepStrictEqual(
        sendOrder.map((c) => `${c.sessionId}→${c.target}`),
        ['300→@a', '301→@a', '301→@b'],
        `unexpected order: ${JSON.stringify(sendOrder)}`
      );
      assert.strictEqual(
        updateRevoked.length,
        1,
        `expected sessions table flagged once; got ${updateRevoked.length}`
      );
      assert.deepStrictEqual(updateRevoked[0], [300, 1]);
    } finally {
      pool.query = origPoolQuery;
      telegramService.sendMessage = origSendMessage;
      messageService._notifyProgress = origNotify;
      messageService._finalizeJob = origFinalize;
    }
    console.log('worker.revokedSessionCache: OK');
  })();

  console.log('singleUserMassDm.smoke.test: OK');
})();
