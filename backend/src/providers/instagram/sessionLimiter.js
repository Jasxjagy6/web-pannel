/**
 * Per-session token-bucket rate limiter (Phase 1, B7).
 *
 * Why this exists:
 * Instagram's rate model is per-session, not per-process. If the panel
 * runs N concurrent features against the same session (a scrape job,
 * a DM batch, a warm-up probe, an account-settings get) without a
 * shared throttle, IG sees a single sessionid produce a request burst
 * that no human ever does. The cost is a permanent action_block on
 * the account.
 *
 * `acquire(sessionId, { class, weight? })` blocks until a token of
 * the requested class is available for that session, then consumes
 * one. Three classes:
 *   - 'read'  — 1 token per ~10s  (profile fetch, friend-list page)
 *   - 'write' — 1 token per ~45s  (DM send, follow, like)
 *   - 'risky' — 1 token per ~10min (profile edit, username rename,
 *                                   PFP change)
 * Numbers chosen empirically from the IG provider's own jitter
 * settings (`messaging.instagram.send_jitter_ms_min` 4-12s) but
 * widened so we trail human cadence rather than match it.
 *
 * Implementation:
 *   - Redis key: `ig:limit:{class}:{sessionId}`
 *   - Atomic via INCR + EXPIRE NX (no Lua needed for simple token
 *     bucket: each request waits until the key TTL passes).
 *   - Surviving across restarts is the whole point — a process
 *     restart MUST NOT drop the limiter.
 *   - In-memory fallback when Redis is unavailable (dev / test).
 *
 * Failure mode: if Redis times out for >250ms, fall back to
 * in-memory limiting on this process. Better to single-process
 * throttle than block all IG egress.
 */

'use strict';

const logger = require('../../utils/logger');
const { redisClient } = require('../../config/redis');

// ---------------------------------------------------------------------
// Class budgets — interval between two adjacent acquires (ms).
// Each acquire adds a small jitter on top so two parallel callers
// don't fire on identical second boundaries.
// ---------------------------------------------------------------------

const _CLASS_INTERVAL_MS = {
  read:  10_000,   // ~6 reads/min
  write: 45_000,   // ~80 writes/hour
  risky: 600_000,  // ~6 risky/hour
};

const _DEFAULT_JITTER_MS = 1500;

// In-memory fallback table: sessionId|class -> { availableAt }
const _memBuckets = new Map();

function _key(sessionId, klass) {
  return `ig:limit:${klass}:${sessionId}`;
}

function _intervalFor(klass) {
  return _CLASS_INTERVAL_MS[klass] || _CLASS_INTERVAL_MS.read;
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function _isRedisReady() {
  return !!(redisClient && redisClient.isReady);
}

async function _redisCall(promise) {
  // Cap any Redis call at 250ms — past that we'd rather fall through
  // to in-memory than block all IG egress on a flapping Redis.
  return Promise.race([
    promise,
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('redis timeout')), 250)
    ),
  ]);
}

/**
 * Acquire a token. Blocks until allowed.
 *
 *   await sessionLimiter.acquire(sessionId, { class: 'read' })
 *
 * Class-aware so a write doesn't burn read budget and vice-versa.
 * If `block:false` is passed, returns immediately with `{allowed:false,
 * waitMs}` instead of sleeping — useful from schedulers that want to
 * pick a different session.
 */
async function acquire(sessionId, opts = {}) {
  const klass = opts.class || 'read';
  const block = opts.block !== false;
  const interval = _intervalFor(klass);
  const jitterCap = opts.jitterMs == null ? _DEFAULT_JITTER_MS : Number(opts.jitterMs);
  const jitter = jitterCap > 0 ? Math.floor(Math.random() * jitterCap) : 0;
  const totalCooldown = interval + jitter;

  if (!sessionId) {
    return { allowed: true, waitMs: 0, source: 'no-session' };
  }

  const k = _key(sessionId, klass);
  const now = Date.now();

  if (_isRedisReady()) {
    try {
      // Redis-backed: PEXPIRE+SET-NX. Pattern:
      //   - if key exists, fetch its TTL — that's the wait
      //   - otherwise SET with PX=cooldown so the next request waits
      const pttl = await _redisCall(redisClient.pTTL(k));
      if (pttl != null && pttl > 0) {
        if (!block) return { allowed: false, waitMs: pttl, source: 'redis' };
        await _sleep(pttl);
        // Re-loop: another caller might have stolen the slot we just
        // waited for. Recursion depth is bounded by the cooldown
        // never being 0.
        return acquire(sessionId, opts);
      }
      // Slot is free. Take it by setting the cooldown key with NX so
      // a racing caller can't both take the same slot.
      const set = await _redisCall(
        redisClient.set(k, '1', { NX: true, PX: totalCooldown })
      );
      if (set !== 'OK') {
        // Lost the race — fall back to waiting.
        if (!block) return { allowed: false, waitMs: totalCooldown, source: 'redis' };
        await _sleep(totalCooldown);
        return acquire(sessionId, opts);
      }
      return { allowed: true, waitMs: 0, source: 'redis' };
    } catch (err) {
      logger.warn(`IG.sessionLimiter: redis fail-open for sessionId=${sessionId} class=${klass}: ${err.message}`);
      // fall through to in-memory
    }
  }

  // In-memory fallback (single-process, dev/test, or Redis down).
  const memKey = `${sessionId}|${klass}`;
  const slot = _memBuckets.get(memKey);
  const availableAt = slot ? slot.availableAt : 0;
  if (availableAt > now) {
    const wait = availableAt - now;
    if (!block) return { allowed: false, waitMs: wait, source: 'memory' };
    await _sleep(wait);
  }
  _memBuckets.set(memKey, { availableAt: Date.now() + totalCooldown });
  return { allowed: true, waitMs: 0, source: 'memory' };
}

/**
 * Force-clear all buckets for a session (e.g. when the session row
 * is deleted, or after an admin "rotate identity" action).
 */
async function clear(sessionId) {
  if (!sessionId) return;
  if (_isRedisReady()) {
    try {
      await Promise.all(
        Object.keys(_CLASS_INTERVAL_MS).map((k) =>
          _redisCall(redisClient.del(_key(sessionId, k)))
        )
      );
    } catch (err) {
      logger.warn(`IG.sessionLimiter.clear redis fail: ${err.message}`);
    }
  }
  for (const klass of Object.keys(_CLASS_INTERVAL_MS)) {
    _memBuckets.delete(`${sessionId}|${klass}`);
  }
}

/**
 * Test/inspection helper.
 */
function _interval(klass) {
  return _intervalFor(klass);
}

module.exports = {
  acquire,
  clear,
  _interval,
  _CLASS_INTERVAL_MS,
};
