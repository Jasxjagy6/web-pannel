/**
 * Smoke test for scrapeMonitorService._recordProfile dedup behaviour.
 *
 * Verifies that the dedup-on path now uses a single atomic
 * `INSERT … ON CONFLICT … DO UPDATE` query against the v29 partial
 * UNIQUE, rather than the v10 SELECT-then-INSERT pattern that races
 * when N sessions on the same chat each fire the NewMessage handler
 * for the same telegram_id in parallel.
 *
 * We don't need a real database — we mock `pool.query` to capture
 * every SQL the service runs, then assert on:
 *   - One INSERT statement (no separate SELECT for dedup-on path)
 *   - The INSERT carries `ON CONFLICT (monitor_job_id, telegram_id)`
 *     `WHERE dedup_locked … DO UPDATE`
 *   - The dedup-off path still produces an INSERT without ON CONFLICT
 *   - `_resolveFromDialogs` matches URL slug → entity from a fake
 *     dialog list
 *
 * Pure logic; no Redis / Postgres / Telegram connections.
 */

'use strict';

const assert = require('assert');
const Module = require('module');

// Stub out pool + telegramService so requiring the service is cheap.
const recordedQueries = [];
const fakePool = {
  query: async (sql, params) => {
    recordedQueries.push({ sql, params });
    // First call from _recordProfile is the events_observed counter update.
    if (/UPDATE scrape_monitor_jobs/i.test(sql) && /events_observed/.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    // Atomic upsert returns one row with the (xmax = 0) "inserted" flag.
    if (/INSERT INTO scrape_monitor_users/i.test(sql) && /ON CONFLICT/i.test(sql)) {
      return { rows: [{ inserted: true }], rowCount: 1 };
    }
    // Dedup-off insert: no RETURNING expected.
    if (/INSERT INTO scrape_monitor_users/i.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    // The scraped_count bump.
    if (/scraped_count/i.test(sql) && /UPDATE scrape_monitor_jobs/i.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    // Progress emit fetch.
    if (/SELECT scraped_count, events_observed/i.test(sql)) {
      return { rows: [{ scraped_count: 1, events_observed: 1 }] };
    }
    return { rows: [], rowCount: 0 };
  },
};

const moduleStubs = new Map([
  ['../config/database', { pool: fakePool }],
  ['../config/redis', {
    redisClient: null,
    isRedisReady: () => false,
  }],
  ['./telegramService', {
    clients: new Map(),
    _resolveEntity: async () => null,
    addNewMessageHandler: async () => () => {},
    addRawUpdateHandler: async () => () => {},
  }],
  ['../sockets', { emit: () => {} }],
  ['./socketEmitter', { emit: () => {} }],
]);

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (parent && parent.filename
      && parent.filename.endsWith('scrapeMonitorService.js')) {
    if (moduleStubs.has(request)) {
      return request; // we'll intercept in require below
    }
  }
  return originalResolve.call(this, request, parent, ...rest);
};
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

// Re-prime _active with a fake context — we go straight at _recordProfile
// and skip the full _attach() flow which would need Telegram clients.
monitorService._active.set(1, {
  unsubs: new Map(),
  timer: setTimeout(() => {}, 0),
  ticker: setInterval(() => {}, 60_000),
  userId: 7,
  lastEmitAt: 0,
  dedupEnabled: true,
  allowedChatIds: new Set(),
  enrich: {
    profileCache: new Map(),
    inflight: new Set(),
    queue: [],
    activeLookups: 0,
    sessionIds: ['101'],
    participantCache: new Map(),
  },
});

(async function dedupOnUsesAtomicUpsert() {
  recordedQueries.length = 0;
  const profile = {
    telegramId: '999000111',
    username: 'alice',
    firstName: 'Alice',
    lastName: null,
    phone: null,
    isBot: false,
    isPremium: false,
  };
  await monitorService._recordProfile(1, 7, 101, profile, 'message');

  const inserts = recordedQueries.filter(
    (q) => /INSERT INTO scrape_monitor_users/i.test(q.sql)
  );
  assert.strictEqual(inserts.length, 1,
    `dedup-on should do exactly 1 INSERT, did ${inserts.length}`);
  const insertSql = inserts[0].sql;
  assert.ok(/ON CONFLICT/i.test(insertSql),
    'dedup-on INSERT must use ON CONFLICT');
  assert.ok(/dedup_locked/i.test(insertSql),
    'dedup-on INSERT must carry the dedup_locked column');
  assert.ok(/WHERE\s+dedup_locked\s*=\s*TRUE\s+AND\s+monitor_chat_id\s+IS\s+NULL/i
    .test(insertSql),
    'dedup-on ON CONFLICT must scope to the legacy partial UNIQUE');
  assert.ok(/DO UPDATE/i.test(insertSql),
    'dedup-on must DO UPDATE so message_count climbs');

  // Critical regression check: no separate SELECT before the INSERT.
  const selectsBefore = recordedQueries
    .slice(0, recordedQueries.indexOf(inserts[0]))
    .filter((q) => /^SELECT/i.test(q.sql.trim()));
  assert.strictEqual(selectsBefore.length, 0,
    'dedup-on path must not run a SELECT before the INSERT (race condition)');

  console.log('OK dedup-on uses atomic INSERT … ON CONFLICT … DO UPDATE');
})()
.then(async () => {
  // Flip dedup off and confirm the dedup-locked-FALSE plain INSERT path.
  monitorService._active.get(1).dedupEnabled = false;
  recordedQueries.length = 0;
  await monitorService._recordProfile(1, 7, 101, {
    telegramId: '999000222',
    username: 'bob',
    firstName: 'Bob',
    lastName: null,
    phone: null,
    isBot: false,
    isPremium: false,
  }, 'message');

  const inserts = recordedQueries.filter(
    (q) => /INSERT INTO scrape_monitor_users/i.test(q.sql)
  );
  assert.strictEqual(inserts.length, 1,
    `dedup-off should do exactly 1 INSERT, did ${inserts.length}`);
  assert.ok(!/ON CONFLICT/i.test(inserts[0].sql),
    'dedup-off INSERT must NOT use ON CONFLICT (raw activity log mode)');
  assert.ok(/dedup_locked/i.test(inserts[0].sql)
    && /FALSE/i.test(inserts[0].sql),
    'dedup-off INSERT must set dedup_locked = FALSE');
  console.log('OK dedup-off does plain INSERT with dedup_locked = FALSE');
})
.then(async () => {
  // _resolveFromDialogs should match against the public-username form
  // even when the operator pasted the t.me URL.
  const channel = {
    className: 'Channel',
    id: BigInt(1234567890),
    username: 'greedyconf',
    title: 'Greedy Conf',
  };
  const stubClient = {
    getDialogs: async () => [
      { entity: { className: 'User', id: BigInt(11) } },
      { entity: channel },
      { entity: { className: 'Chat', id: BigInt(22), title: 'Unrelated' } },
    ],
  };
  moduleStubs.get('./telegramService').clients.set('101', { client: stubClient });

  const found1 = await monitorService._resolveFromDialogs('101', 'https://t.me/greedyconf');
  assert.strictEqual(found1, channel, 'should match t.me/<slug> against entity.username');

  const found2 = await monitorService._resolveFromDialogs('101', '@greedyconf');
  assert.strictEqual(found2, channel, 'should match @username form');

  const found3 = await monitorService._resolveFromDialogs(
    '101', '-1001234567890'
  );
  assert.strictEqual(found3, channel,
    'should match Channel by "-100<id>" Bot-API form');

  const found4 = await monitorService._resolveFromDialogs(
    '101', 'GreedyConf'
  );
  assert.strictEqual(found4, channel,
    'should fall back to normalized title equality');

  const notFound = await monitorService._resolveFromDialogs('101', 'doesnotexist');
  assert.strictEqual(notFound, null,
    'unknown slug should return null, not match by accident');

  console.log('OK _resolveFromDialogs matches across URL / @username / id / title');
})
.then(() => {
  // Cleanup so the process exits cleanly.
  for (const ctx of monitorService._active.values()) {
    try { clearTimeout(ctx.timer); } catch { /* ignore */ }
    try { clearInterval(ctx.ticker); } catch { /* ignore */ }
  }
  console.log('monitorDedupUpsert.smoke.test: OK');
  process.exit(0);
})
.catch((err) => {
  console.error('monitorDedupUpsert.smoke.test: FAILED', err);
  process.exit(1);
});
