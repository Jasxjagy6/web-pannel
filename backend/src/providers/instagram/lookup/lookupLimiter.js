/**
 * Lookup-stack rate limiter (instagram_upgrade.txt §6.4).
 *
 * Separate from `sessionLimiter` because the lookup workload is per
 * (method, target_username) — not per-session. The mask-recovery probe
 * is the same regardless of which operator runs it, so the bucket key
 * is `lookup:{method}:{username}`. This makes a million-operator-deep
 * panel collapse onto a single cadence per target instead of N
 * parallel probes that all trip IG's rate gate at once.
 *
 * Class budgets are tighter than scrape because IG's reset-flow page
 * is the surface most aggressively rate-limited by their bot model.
 *
 * Two classes:
 *   - 'read'  — public/no-cookie probes (web_profile_info, sherlock,
 *               google dork, geo). 1 token / 2s per target.
 *   - 'probe' — recovery-mask + reset-oracle calls (cookie or burner
 *               required). 1 token / 8s per target.
 *
 * Redis-backed with the same 250 ms fail-open fallback as
 * sessionLimiter, so a Redis hiccup never blocks the lookup worker.
 */

'use strict';

const logger = require('../../../utils/logger');
const { redisClient } = require('../../../config/redis');

const _CLASS_INTERVAL_MS = {
  read:  2_000,
  probe: 8_000,
};

const _DEFAULT_JITTER_MS = 750;
const _memBuckets = new Map();

function _key(target, klass) {
  return `ig:lookup:limit:${klass}:${(target || 'global').toLowerCase()}`;
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
  return Promise.race([
    promise,
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('redis timeout')), 250)
    ),
  ]);
}

async function acquire(target, opts = {}) {
  const klass = opts.class || 'read';
  const block = opts.block !== false;
  const interval = _intervalFor(klass);
  const jitterCap = opts.jitterMs == null ? _DEFAULT_JITTER_MS : Number(opts.jitterMs);
  const jitter = jitterCap > 0 ? Math.floor(Math.random() * jitterCap) : 0;
  const totalCooldown = interval + jitter;

  const k = _key(target, klass);

  if (_isRedisReady()) {
    try {
      const pttl = await _redisCall(redisClient.pTTL(k));
      if (pttl != null && pttl > 0) {
        if (!block) return { allowed: false, waitMs: pttl, source: 'redis' };
        await _sleep(pttl);
        return acquire(target, opts);
      }
      const set = await _redisCall(
        redisClient.set(k, '1', { NX: true, PX: totalCooldown })
      );
      if (set !== 'OK') {
        if (!block) return { allowed: false, waitMs: totalCooldown, source: 'redis' };
        await _sleep(totalCooldown);
        return acquire(target, opts);
      }
      return { allowed: true, waitMs: 0, source: 'redis' };
    } catch (err) {
      logger.warn(`IG.lookupLimiter: redis fail-open for target=${target} class=${klass}: ${err.message}`);
    }
  }

  const memKey = `${target}|${klass}`;
  const slot = _memBuckets.get(memKey);
  const availableAt = slot ? slot.availableAt : 0;
  const now = Date.now();
  if (availableAt > now) {
    const wait = availableAt - now;
    if (!block) return { allowed: false, waitMs: wait, source: 'memory' };
    await _sleep(wait);
  }
  _memBuckets.set(memKey, { availableAt: Date.now() + totalCooldown });
  return { allowed: true, waitMs: 0, source: 'memory' };
}

module.exports = {
  acquire,
  _CLASS_INTERVAL_MS,
};
