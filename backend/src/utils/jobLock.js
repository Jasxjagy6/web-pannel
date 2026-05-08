/**
 * jobLock — per-user, per-job-category serialization for BullMQ workers.
 *
 * Why: when an operator clicks "start" on three add-members jobs in a row
 * the worker would happily run them in parallel, multiplying the number of
 * Telegram RPCs in flight from one user's sessions. Each session quickly
 * hits PEER_FLOOD because Telegram tracks rate per account, not per job.
 *
 * Design (BullMQ-compatible, no Pro features required):
 *
 *   1. The worker callback wraps its real work in `withJobLock(job, key, fn)`.
 *   2. We try to set a Redis key `joblock:{key}` with NX + EX (TTL = job lease).
 *      If we succeed we own the lock, run `fn()`, and on completion (success
 *      or failure) DEL the key.
 *   3. If we DON'T own the lock another job is already running for this
 *      `(user, category)`. We re-enqueue this job to BullMQ as a delayed
 *      job (default: 30s) and return a sentinel so the caller exits cleanly.
 *      BullMQ will pick the delayed job up again later — at which point we
 *      try the lock again.
 *
 * Effect: jobs of the same category for the same user run STRICTLY one at
 * a time. Jobs of different categories or different users run independently.
 *
 * Lock TTL is intentionally long (default 6h) so a worker crashing
 * mid-job can't hold the lock forever — the TTL eventually expires and the
 * next queued job acquires.
 */

const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');

const DEFAULT_LOCK_TTL_SECONDS = 6 * 60 * 60; // 6h
const DEFAULT_BACKOFF_MS = 30_000;            // 30s

const QUEUED_BEHIND_LOCK = Symbol('joblock.queued_behind_lock');

function lockKey({ userId, category }) {
  if (!category) throw new Error('jobLock: category is required');
  return `joblock:${userId || 'global'}:${category}`;
}

/**
 * Try to acquire the lock without blocking. Returns true on success.
 */
async function tryAcquire(key, ttlSeconds = DEFAULT_LOCK_TTL_SECONDS) {
  if (!redisClient || !redisClient.isReady) {
    // Redis is the source of truth here; if it's down we can't safely
    // serialize, so don't gate the worker on it (failing open is better
    // than every job getting stuck queued).
    return true;
  }
  const ok = await redisClient.set(key, '1', { NX: true, EX: ttlSeconds });
  return Boolean(ok);
}

async function release(key) {
  if (!redisClient || !redisClient.isReady) return;
  try { await redisClient.del(key); } catch { /* ignore */ }
}

/**
 * Wrap a BullMQ worker callback in a lock. If the lock is held the job is
 * re-queued as a delayed job and `QUEUED_BEHIND_LOCK` is returned so the
 * caller can short-circuit.
 *
 * @param {import('bullmq').Job} job             BullMQ Job instance
 * @param {object}               opts
 * @param {string}               opts.userId     user the job belongs to
 * @param {string}               opts.category   logical category, e.g. 'group:add-members'
 * @param {number}               [opts.ttlSeconds]
 * @param {number}               [opts.backoffMs]
 * @param {Function}             fn              async () => result
 * @returns {Promise<any>}
 */
async function withJobLock(job, opts, fn) {
  const { userId, category } = opts;
  const ttlSeconds = opts.ttlSeconds || DEFAULT_LOCK_TTL_SECONDS;
  const backoffMs = opts.backoffMs || DEFAULT_BACKOFF_MS;
  const key = lockKey({ userId, category });

  const acquired = await tryAcquire(key, ttlSeconds);
  if (!acquired) {
    logger.info(
      `[jobLock] ${key} held; deferring job ${job?.id || '<no-id>'} by ${backoffMs}ms`
    );
    if (job && typeof job.moveToDelayed === 'function') {
      try {
        await job.moveToDelayed(Date.now() + backoffMs);
      } catch (err) {
        // BullMQ throws DelayedError to indicate "this job has been
        // deferred". That is the expected control-flow signal; let it
        // bubble so the worker treats the run as "still in queue".
        if (err && err.name === 'DelayedError') throw err;
        logger.warn(`[jobLock] moveToDelayed failed: ${err.message}`);
      }
    }
    return QUEUED_BEHIND_LOCK;
  }

  try {
    return await fn();
  } finally {
    await release(key);
  }
}

module.exports = {
  withJobLock,
  tryAcquire,
  release,
  lockKey,
  QUEUED_BEHIND_LOCK,
  DEFAULT_LOCK_TTL_SECONDS,
  DEFAULT_BACKOFF_MS,
};
