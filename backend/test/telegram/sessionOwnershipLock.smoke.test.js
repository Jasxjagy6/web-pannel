/**
 * Smoke test for the Redis-backed session ownership lock.
 *
 * Covers:
 *   - Fail-open when Redis is unreachable (no-op token).
 *   - SETNX semantics: only the first acquirer wins.
 *   - Re-entrant acquire by the SAME holder succeeds.
 *   - Refresh CAS: only the holder of the current token can renew.
 *   - Release CAS: only the holder of the current token can delete.
 *   - withSessionLock heartbeat keeps the TTL alive.
 *
 * Uses an in-memory mock that mimics the subset of node-redis v4
 * surface area the lock module touches. We replace `redisClient` on
 * the imported `../config/redis` module BEFORE requiring the lock so
 * the module sees our mock.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- in-memory redis mock --------------------------------------------------

function makeRedisMock({ ready = true } = {}) {
  const store = new Map();
  const ttls = new Map(); // key → expiry ms

  function purgeIfExpired(k) {
    const exp = ttls.get(k);
    if (exp && Date.now() > exp) {
      store.delete(k);
      ttls.delete(k);
    }
  }

  return {
    isReady: ready,
    async set(key, value, opts = {}) {
      purgeIfExpired(key);
      if (opts.NX && store.has(key)) return null;
      store.set(key, value);
      if (opts.PX) ttls.set(key, Date.now() + opts.PX);
      else if (opts.EX) ttls.set(key, Date.now() + opts.EX * 1000);
      else ttls.delete(key);
      return 'OK';
    },
    async get(key) {
      purgeIfExpired(key);
      return store.get(key) ?? null;
    },
    async del(key) {
      const had = store.has(key);
      store.delete(key);
      ttls.delete(key);
      return had ? 1 : 0;
    },
    async pExpire(key, ttlMs) {
      purgeIfExpired(key);
      if (!store.has(key)) return 0;
      ttls.set(key, Date.now() + Number(ttlMs));
      return 1;
    },
    // node-redis v4 EVAL: { keys, arguments }.
    async eval(script, { keys = [], arguments: args = [] } = {}) {
      // We only use two scripts in the lock module: refresh-CAS and
      // release-CAS. Detect by string match.
      const isRefresh = /PEXPIRE/.test(script);
      const isRelease = /\bDEL\b/.test(script);
      const k = keys[0];
      const wantToken = args[0];
      const cur = await this.get(k);
      if (cur !== wantToken) return 0;
      if (isRelease) {
        return this.del(k);
      }
      if (isRefresh) {
        const ttlMs = Number(args[1] || 60_000);
        return this.pExpire(k, ttlMs);
      }
      return 0;
    },
    // Helper for assertions.
    _store: store,
    _ttls: ttls,
  };
}

// --- swap in the mock before requiring the lock ----------------------------

const redisCfgPath = path.resolve(__dirname, '../../src/config/redis.js');
const realRedisCfg = require('../../src/config/redis');
const mock = makeRedisMock();
realRedisCfg.redisClient = mock;
require.cache[require.resolve('../../src/config/redis')].exports.redisClient = mock;

const sessionLock = require('../../src/services/sessionOwnershipLock');

(async () => {
  // 1. fail-open when redis isn't ready
  mock.isReady = false;
  const failopen = await sessionLock.acquire('s1', 'holder-A');
  assert.ok(failopen && failopen.token === '__noop__', 'fail-open returns NOOP_TOKEN');
  // refresh / release on a NOOP_TOKEN must be silent no-ops
  assert.strictEqual(await sessionLock.refresh('s1', '__noop__'), true, 'noop refresh -> true');
  await sessionLock.release('s1', '__noop__'); // must not throw
  console.log('OK fail-open');

  mock.isReady = true;

  // 2. first acquirer wins, second loses
  const a = await sessionLock.acquire('s2', 'holder-A');
  assert.ok(a && a.fresh === true, 'A acquires fresh');
  const b = await sessionLock.acquire('s2', 'holder-B');
  assert.strictEqual(b, null, 'B cannot acquire (held by A)');
  console.log('OK SETNX semantics: only one acquirer wins');

  // 3. re-entrant acquire by the SAME holder succeeds (extends TTL,
  //    returns existing token + fresh=false)
  const aAgain = await sessionLock.acquire('s2', 'holder-A');
  assert.ok(aAgain && aAgain.fresh === false, 're-entrant acquire by same holder');
  assert.strictEqual(aAgain.token, a.token, 'same fencing token returned');
  console.log('OK re-entrant acquire returns existing token');

  // 4. refresh CAS: only holder of current token can renew
  assert.strictEqual(await sessionLock.refresh('s2', a.token), true, 'A refresh succeeds');
  assert.strictEqual(await sessionLock.refresh('s2', 'wrong-token'), false, 'refresh with wrong token fails');
  console.log('OK refresh CAS');

  // 5. release CAS: wrong token doesn't delete; correct token does
  await sessionLock.release('s2', 'wrong-token');
  let stillThere = await mock.get('tgsessionlock:s2');
  assert.ok(stillThere, 'wrong-token release left key in place');
  await sessionLock.release('s2', a.token);
  stillThere = await mock.get('tgsessionlock:s2');
  assert.strictEqual(stillThere, null, 'correct-token release deleted key');
  console.log('OK release CAS');

  // 6. After A releases, B can now acquire
  const bAfter = await sessionLock.acquire('s2', 'holder-B');
  assert.ok(bAfter && bAfter.fresh === true, 'B acquires after release');
  await sessionLock.release('s2', bAfter.token);
  console.log('OK release-then-acquire by new holder');

  // 7. inspect()
  await sessionLock.acquire('s3', 'holder-C');
  const insp = await sessionLock.inspect('s3');
  assert.ok(insp.held === true, 'inspect() reports held lock');
  assert.ok(insp.holderToken && insp.holderToken.startsWith('holder-C#'), 'token format');
  console.log('OK inspect()');

  // 8. holder-id sanitisation: weird chars must not break the lookup
  const weirdHolder = 'pid 17/node:5..3';
  await sessionLock.release('s4', '__noop__');
  const w = await sessionLock.acquire('s4', weirdHolder);
  assert.ok(w && w.token && /^pid_17_node_5\.\.3#/.test(w.token), 'sanitised holder prefix');
  // Re-entrant by the same weird holder still resolves
  const w2 = await sessionLock.acquire('s4', weirdHolder);
  assert.ok(w2 && w2.fresh === false, 're-entrant works for sanitised holder');
  await sessionLock.release('s4', w.token);
  console.log('OK holder-id sanitisation');

  // 9. withSessionLock: heartbeat keeps TTL alive while fn runs.
  //    We can't intercept the lock module's internal `refresh` from
  //    outside (closure scope), so we count CAS-refresh EVALs via
  //    the mock — that's the only place a heartbeat can manifest.
  let evalRefreshes = 0;
  const realEval = mock.eval.bind(mock);
  mock.eval = async (script, opts) => {
    if (/PEXPIRE/.test(script)) evalRefreshes++;
    return realEval(script, opts);
  };
  await sessionLock.withSessionLock(
    's5',
    'holder-D',
    async () => {
      // Wait long enough for ≥1 heartbeat tick. The default heartbeat
      // is 20s; we override to 20ms for the test.
      await new Promise((r) => setTimeout(r, 80));
    },
    { ttlMs: 1000, heartbeatMs: 20 }
  );
  mock.eval = realEval;
  assert.ok(evalRefreshes >= 1, `heartbeat refreshed at least once during fn (got ${evalRefreshes})`);
  // Lock must be released after withSessionLock returns
  const after = await mock.get('tgsessionlock:s5');
  assert.strictEqual(after, null, 'withSessionLock released on the way out');
  console.log(`OK withSessionLock heartbeat + release (${evalRefreshes} refreshes during fn)`);

  // 10. SESSION_LOCKED_BY_OTHER_WORKER thrown when another holder owns it
  await sessionLock.acquire('s6', 'holder-E');
  try {
    await sessionLock.withSessionLock('s6', 'holder-F', async () => {
      throw new Error('should not run');
    });
    throw new Error('expected withSessionLock to throw');
  } catch (e) {
    assert.strictEqual(e.code, 'SESSION_LOCKED_BY_OTHER_WORKER');
    assert.strictEqual(e.statusCode, 409);
  }
  console.log('OK withSessionLock throws SESSION_LOCKED_BY_OTHER_WORKER');

  console.log('\nsessionOwnershipLock.smoke.test: OK');
})().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
