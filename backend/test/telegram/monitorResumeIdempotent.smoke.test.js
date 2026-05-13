/**
 * Smoke test for scrapeMonitorService.resumeActiveJobs idempotency.
 *
 * `index.js` runs `resumeActiveJobs` every 60 s as a safety sweep.
 * Pre-fix, the sweep blindly re-attached every running job, tearing
 * down healthy listeners and re-running `_resolveEntity` against
 * targets that we already know fail (private chats).
 *
 * This test:
 *   1. Seeds one running job in the in-memory `_active` map.
 *   2. Mocks pool.query to return that running job from the DB poll.
 *   3. Calls resumeActiveJobs and asserts `_attach` was NOT called.
 *   4. Removes the job from `_active` and asserts the next call DOES
 *      re-attach it.
 *
 * No DB / Telegram / Redis connections — only the service plus a
 * pool stub.
 */

'use strict';

const assert = require('assert');
const Module = require('module');

const recordedQueries = [];
const runningJobs = [
  {
    id: 42, user_id: 7,
    session_ids: ['101'],
    target_id: '@example',
    expires_at: new Date(Date.now() + 60 * 60_000),
    dedup_enabled: true,
  },
];

const fakePool = {
  query: async (sql, params) => {
    recordedQueries.push({ sql, params });
    if (/FROM scrape_monitor_jobs/i.test(sql) && /status = 'running'/i.test(sql)) {
      return { rows: runningJobs };
    }
    return { rows: [] };
  },
};

const moduleStubs = new Map([
  ['../config/database', { pool: fakePool }],
  ['../config/redis', { redisClient: null, isRedisReady: () => false }],
  ['./telegramService', {
    clients: new Map(),
    _resolveEntity: async () => null,
    addNewMessageHandler: async () => () => {},
    addRawUpdateHandler: async () => () => {},
  }],
  ['../sockets', { emit: () => {} }],
  ['./socketEmitter', { emit: () => {} }],
]);

const originalLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent && parent.filename
      && parent.filename.endsWith('scrapeMonitorService.js')
      && moduleStubs.has(request)) {
    return moduleStubs.get(request);
  }
  return originalLoad.call(this, request, parent, ...rest);
};

const monitorService = require('../../src/services/scrapeMonitorService');

let attachCalls = 0;
monitorService._attach = async () => {
  attachCalls += 1;
};

(async function alreadyAttachedJobIsSkipped() {
  // Job 42 is in _active → resumeActiveJobs must skip it.
  monitorService._active.set(42, {
    unsubs: new Map(), timer: setTimeout(() => {}, 0),
    ticker: setInterval(() => {}, 60_000),
    userId: 7, lastEmitAt: 0, dedupEnabled: true,
    allowedChatIds: new Set(),
    enrich: {
      profileCache: new Map(), inflight: new Set(),
      queue: [], activeLookups: 0, sessionIds: ['101'],
      participantCache: new Map(),
    },
  });

  attachCalls = 0;
  await monitorService.resumeActiveJobs();
  assert.strictEqual(attachCalls, 0,
    'sweep must NOT re-attach already-attached jobs');
  console.log('OK already-attached jobs are skipped');

  // Now drop the in-memory state and confirm the next sweep DOES re-attach.
  monitorService._active.delete(42);
  attachCalls = 0;
  await monitorService.resumeActiveJobs();
  assert.strictEqual(attachCalls, 1,
    'sweep must re-attach jobs whose in-memory state was lost');
  console.log('OK lost-state jobs are re-attached');

  // Cleanup
  for (const ctx of monitorService._active.values()) {
    try { clearTimeout(ctx.timer); } catch { /* ignore */ }
    try { clearInterval(ctx.ticker); } catch { /* ignore */ }
  }
  console.log('monitorResumeIdempotent.smoke.test: OK');
  process.exit(0);
})().catch((err) => {
  console.error('monitorResumeIdempotent.smoke.test: FAILED', err);
  process.exit(1);
});
