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
  // 4. _processSingleUserMassDm: NO target-side blacklist. Per the
  //    operator's "no session should skip the job unless session is
  //    not active" rule, every alive session attempts every target
  //    even when previous sessions returned a target-side error like
  //    USERNAME_NOT_OCCUPIED. The only allowed mid-job skip is the
  //    revoked-session cache (AUTH_KEY_UNREGISTERED → flag session
  //    revoked → skip its remaining iterations).
  // ────────────────────────────────────────────────────────────────
  await (async () => {
    const pool = require('../../src/config/database').pool;
    const telegramService = require('../../src/services/telegramService');

    const origPoolQuery = pool.query.bind(pool);
    const origSendMessage = telegramService.sendMessage.bind(telegramService);
    const origPreWarm = telegramService.preWarmSessions.bind(telegramService);
    const origNotify = messageService._notifyProgress.bind(messageService);
    const origFinalize = messageService._finalizeJob.bind(messageService);

    // Stub preWarmSessions so V2 runner doesn't try real MTProto connects.
    telegramService.preWarmSessions = async (ids) => ({
      ok: ids.map(String),
      failed: [],
      durationMs: 0,
    });

    const queryLog = [];
    const updateRevoked = [];
    pool.query = async (sql, params) => {
      queryLog.push({ sql, params });
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('SELECT status FROM messaging_jobs')) {
        return { rows: [{ status: 'running' }] };
      }
      // sessionService.flagSessionRevoked first reads the row to
      // build the account_info JSONB; return a minimal row so it
      // proceeds to the UPDATE branch.
      if (text.startsWith('SELECT id, user_id, status, is_logged_in, account_info FROM sessions')) {
        return {
          rows: [
            { id: params[0], user_id: 1, status: 'active', is_logged_in: true, account_info: {} },
          ],
        };
      }
      if (text.startsWith('UPDATE sessions') && text.includes("status = 'revoked'")) {
        updateRevoked.push(params);
        return { rows: [] };
      }
      // Every other UPDATE / INSERT against messaging_jobs / message_logs
      // is fine to pretend-acknowledge.
      return { rows: [] };
    };

    // Sub-test 4a: NO target-side short-circuit. Every alive session
    // attempts the target. Session 101 is revoked (AUTH_KEY) — that's
    // the only legal skip. Sessions 100, 102, 103, 104 all attempt
    // even though earlier ones returned USERNAME_NOT_OCCUPIED.
    let sendCallsA = 0;
    telegramService.sendMessage = async (sessionId, target, _message) => {
      sendCallsA++;
      if (sessionId === '101') {
        throw new Error('Telegram API error: AUTH_KEY_UNREGISTERED');
      }
      // Target-side error — a real Telegram USERNAME_NOT_OCCUPIED.
      throw new Error('Telegram API error: USERNAME_NOT_OCCUPIED');
    };

    messageService._notifyProgress = async () => {};
    messageService._finalizeJob = async () => {};

    try {
      await messageService._processSingleUserMassDm(
        9999,
        [
          { id: 100, user_id: 1, status: 'active' }, // attempts → USERNAME_NOT_OCCUPIED (no skip propagation)
          { id: 101, user_id: 1, status: 'active' }, // AUTH_KEY → revoked
          { id: 102, user_id: 1, status: 'active' }, // attempts (no cache to short-circuit)
          { id: 103, user_id: 1, status: 'active' }, // attempts
          { id: 104, user_id: 1, status: 'active' }, // attempts
        ],
        ['@typo'],
        'hello',
        0, // delaySeconds=0 to keep test fast
        1
      );

      // All 5 sessions called sendMessage — no target-side cache exists anymore.
      assert.strictEqual(
        sendCallsA,
        5,
        `expected 5 sendMessage calls (every alive session must attempt); got ${sendCallsA}`
      );
      // AUTH_KEY_UNREGISTERED should have flagged session 101 in DB.
      assert.ok(
        updateRevoked.some((p) => p && p[0] === 101),
        'expected session 101 to be flagged revoked'
      );
    } finally {
      pool.query = origPoolQuery;
      telegramService.sendMessage = origSendMessage;
      telegramService.preWarmSessions = origPreWarm;
      messageService._notifyProgress = origNotify;
      messageService._finalizeJob = origFinalize;
    }
    console.log('worker.noTargetSkip.everySessionAttempts: OK');
  })();

  // ────────────────────────────────────────────────────────────────
  // 4b. _processSingleUserMassDm: a generic "Could not resolve target"
  //     error (the pattern that previously blacklisted real handles)
  //     does NOT trigger the dead-target cache by itself. Every session
  //     gets a real attempt — operators can rely on per-session
  //     entity resolution to tell them whether the user truly exists.
  // ────────────────────────────────────────────────────────────────
  await (async () => {
    const pool = require('../../src/config/database').pool;
    const telegramService = require('../../src/services/telegramService');

    const origPoolQuery = pool.query.bind(pool);
    const origSendMessage = telegramService.sendMessage.bind(telegramService);
    const origPreWarm2 = telegramService.preWarmSessions.bind(telegramService);
    const origNotify = messageService._notifyProgress.bind(messageService);
    const origFinalize = messageService._finalizeJob.bind(messageService);

    telegramService.preWarmSessions = async (ids) => ({
      ok: ids.map(String),
      failed: [],
      durationMs: 0,
    });

    pool.query = async (sql) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('SELECT status FROM messaging_jobs')) {
        return { rows: [{ status: 'running' }] };
      }
      return { rows: [] };
    };

    let sendCallsB = 0;
    telegramService.sendMessage = async () => {
      sendCallsB++;
      // Generic resolution-failure shape the OLD classifier matched.
      throw new Error('Telegram API error: Could not resolve target: @binolt');
    };

    messageService._notifyProgress = async () => {};
    messageService._finalizeJob = async () => {};

    try {
      await messageService._processSingleUserMassDm(
        9999,
        [
          { id: 200, user_id: 1, status: 'active' },
          { id: 201, user_id: 1, status: 'active' },
          { id: 202, user_id: 1, status: 'active' },
          { id: 203, user_id: 1, status: 'active' },
          { id: 204, user_id: 1, status: 'active' },
        ],
        ['@binolt'],
        'hello',
        0,
        1
      );

      assert.strictEqual(
        sendCallsB,
        5,
        `expected every session to attempt the manual @binolt target — generic "Could not resolve" should NOT pre-blacklist; got ${sendCallsB}`
      );
    } finally {
      pool.query = origPoolQuery;
      telegramService.sendMessage = origSendMessage;
      telegramService.preWarmSessions = origPreWarm2;
      messageService._notifyProgress = origNotify;
      messageService._finalizeJob = origFinalize;
    }
    console.log('worker.deadTargetCache.genericResolveDoesNotBlacklist: OK');
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
    const origPreWarm3 = telegramService.preWarmSessions.bind(telegramService);
    const origNotify = messageService._notifyProgress.bind(messageService);
    const origFinalize = messageService._finalizeJob.bind(messageService);

    telegramService.preWarmSessions = async (ids) => ({
      ok: ids.map(String),
      failed: [],
      durationMs: 0,
    });

    const updateRevoked = [];
    pool.query = async (sql, params) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('SELECT status FROM messaging_jobs')) {
        return { rows: [{ status: 'running' }] };
      }
      if (text.startsWith('SELECT id, user_id, status, is_logged_in, account_info FROM sessions')) {
        return {
          rows: [
            { id: params[0], user_id: 1, status: 'active', is_logged_in: true, account_info: {} },
          ],
        };
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
      // sessionService.flagSessionRevoked now does the write — its
      // UPDATE takes [sessionId, account_info_json], so we just check
      // the session id (first arg) and that the account_info payload
      // carries the original AUTH_KEY_UNREGISTERED message.
      assert.strictEqual(updateRevoked[0][0], 300, 'session 300 flagged revoked');
      const accountInfo = JSON.parse(updateRevoked[0][1]);
      assert.ok(
        /AUTH_KEY_UNREGISTERED/.test(accountInfo.lastError || ''),
        `account_info.lastError carries the auth error: ${accountInfo.lastError}`
      );
      assert.strictEqual(accountInfo.revocationReason, 'AUTH_KEY_UNREGISTERED');
    } finally {
      pool.query = origPoolQuery;
      telegramService.sendMessage = origSendMessage;
      telegramService.preWarmSessions = origPreWarm3;
      messageService._notifyProgress = origNotify;
      messageService._finalizeJob = origFinalize;
    }
    console.log('worker.revokedSessionCache: OK');
  })();

  console.log('singleUserMassDm.smoke.test: OK');
})();
