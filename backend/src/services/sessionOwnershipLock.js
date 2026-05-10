/**
 * sessionOwnershipLock — Redis-backed mutex over a single Telegram
 * session's MTProto auth_key.
 *
 * ============================================================
 *   Why this exists
 * ============================================================
 *
 * Telegram identifies a logged-in client by the auth_key bytes
 * embedded in its StringSession. If two processes (or two workers
 * inside the same process) simultaneously connect with the *same*
 * auth_key, Telegram's spam server treats that as anomalous activity
 * and frequently *invalidates* the auth_key out-of-band — every
 * subsequent RPC then comes back as `AUTH_KEY_UNREGISTERED` and the
 * session is gone for good (StringSession can't be re-issued, only
 * re-uploaded by the human).
 *
 * Today the panel runs as a single Node process so this never
 * happens. The 1000+ session scale-up wants to fan workers out to
 * sharded processes — at that point we *must* coordinate connections
 * via something stronger than in-process locks. This service is
 * that coordination primitive.
 *
 * ============================================================
 *   Semantics
 * ============================================================
 *
 *   acquire(sessionId, holderId)
 *     - SETNX `tgsessionlock:{id}` to `{holderId}` with a TTL.
 *     - Returns a "fencing token" the caller must use for refresh /
 *       release. Stale holders that lost the lock cannot accidentally
 *       release a newer holder's lock.
 *     - Returns `null` if the lock is held by someone else.
 *
 *   refresh(sessionId, fencingToken)
 *     - PEXPIRE the key only if it still belongs to us, otherwise
 *       returns `false` so the caller can shut down its Telegram
 *       connection (we are no longer the rightful owner).
 *
 *   release(sessionId, fencingToken)
 *     - DEL the key only if it still belongs to us.
 *
 *   withSessionLock(sessionId, holderId, fn)
 *     - Convenience wrapper that acquires, runs `fn(token)`,
 *       releases (with a heartbeat keeping the lock alive while
 *       `fn` runs).
 *
 * ============================================================
 *   Fail-open by design
 * ============================================================
 *
 * If Redis is unreachable we DO NOT block session connections —
 * making the panel unusable on a Redis blip is worse than the small
 * race window we're guarding against. The lock returns a sentinel
 * "no-op token" in this case; refresh / release become no-ops; the
 * existing in-process Map in `telegramService.clients` continues to
 * provide single-process safety as it does today. Operations relog
 * the Redis failure so it's visible.
 *
 * Same posture as `utils/jobLock.js` — the panel has been running
 * with that policy in production for the bulk-DM serializer and it's
 * proven safer than fail-closed.
 */

'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');
const { redisClient } = require('../config/redis');

// Reasonably tight TTL: long enough to survive normal RPC bursts /
// network jitter, short enough that a worker that hard-crashes
// without a clean release frees the session within ~1min.
const DEFAULT_LOCK_TTL_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

// Sentinel returned when Redis is unavailable — refresh / release
// understand it as "nothing to do".
const NOOP_TOKEN = '__noop__';

// Shared key prefix so an operator can `redis-cli KEYS tgsessionlock:*`
// to inspect held locks, similar to `joblock:*`.
const KEY_PREFIX = 'tgsessionlock:';

function sessionKey(sessionId) {
  if (sessionId === undefined || sessionId === null) {
    throw new Error('sessionOwnershipLock: sessionId is required');
  }
  return `${KEY_PREFIX}${sessionId}`;
}

function isRedisReady() {
  return Boolean(redisClient && redisClient.isReady);
}

function makeFencingToken(holderId) {
  // 16 bytes of randomness is plenty to make collisions impossible
  // and keeps the value small enough to grep in redis-cli output.
  const rand = crypto.randomBytes(8).toString('hex');
  // Holder ID makes operator forensics easier ("which worker held
  // session 73 at 02:14?") without needing a separate audit log.
  const safeHolder = String(holderId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  return `${safeHolder}#${rand}#${Date.now()}`;
}

/**
 * Try to acquire the lock for `sessionId` on behalf of `holderId`.
 *
 * @param {number|string} sessionId
 * @param {string}        holderId   - process identity (e.g. `worker-3.pid-1842`)
 * @param {object}        [opts]
 * @param {number}        [opts.ttlMs]
 * @returns {Promise<{token:string, fresh:boolean} | null>}
 *          - `token` is the fencing token (or NOOP_TOKEN when Redis is
 *            unavailable, in which case `fresh` is undefined).
 *          - `fresh=true` means we were the first to claim this lock.
 *          - `fresh=false` means we already held it (re-entrant call).
 *          - `null` means another holder owns it.
 */
async function acquire(sessionId, holderId, opts = {}) {
  const ttlMs = opts.ttlMs || DEFAULT_LOCK_TTL_MS;
  if (!isRedisReady()) {
    // Fail-open. Logged at debug to avoid spamming on long Redis
    // outages; the connect-side logger will still record the bigger
    // problem (Redis down).
    return { token: NOOP_TOKEN, fresh: true };
  }
  const key = sessionKey(sessionId);
  const token = makeFencingToken(holderId);
  try {
    // node-redis v4 SET options: NX (only if absent), PX (ttl in ms).
    const ok = await redisClient.set(key, token, { NX: true, PX: ttlMs });
    if (ok) {
      return { token, fresh: true };
    }
    // Lock is held — check if it's already us (re-entrant via same
    // holderId). This avoids spurious "owned by another holder"
    // errors when, e.g., the same worker calls _ensureConnected
    // twice in a row.
    const current = await redisClient.get(key);
    if (current && current.startsWith(`${String(holderId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64)}#`)) {
      // Refresh the TTL so the existing token doesn't time out
      // mid-operation just because the operator re-entered.
      try { await redisClient.pExpire(key, ttlMs); } catch { /* ignore */ }
      return { token: current, fresh: false };
    }
    return null;
  } catch (err) {
    // Same fail-open posture as the no-Redis case. Note in the log
    // so the operator knows the lock isn't actually doing anything
    // until Redis recovers.
    logger.warn(`sessionOwnershipLock.acquire(${sessionId}) failed: ${err.message}`);
    return { token: NOOP_TOKEN, fresh: true };
  }
}

/**
 * Renew the TTL on a lock we already hold. Returns false if the lock
 * has been taken away from us in the meantime (caller MUST disconnect
 * its Telegram client immediately when this happens).
 *
 * @param {number|string} sessionId
 * @param {string}        token       fencing token returned by acquire()
 * @param {object}        [opts]
 * @param {number}        [opts.ttlMs]
 * @returns {Promise<boolean>}
 */
async function refresh(sessionId, token, opts = {}) {
  if (!token || token === NOOP_TOKEN || !isRedisReady()) return true;
  const ttlMs = opts.ttlMs || DEFAULT_LOCK_TTL_MS;
  const key = sessionKey(sessionId);
  // Atomic: only refresh if value still matches our token. Otherwise
  // someone else has the lock and we must back off.
  //
  // node-redis v4 supports `EVAL`. We use a tiny CAS Lua script
  // because GET-then-PEXPIRE has a race window where another worker
  // could acquire between the GET and the PEXPIRE.
  const lua = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('PEXPIRE', KEYS[1], ARGV[2])
    else
      return 0
    end
  `;
  try {
    const result = await redisClient.eval(lua, {
      keys: [key],
      arguments: [token, String(ttlMs)],
    });
    return Number(result) === 1;
  } catch (err) {
    logger.warn(`sessionOwnershipLock.refresh(${sessionId}) failed: ${err.message}`);
    return true; // fail-open
  }
}

/**
 * Release a lock we own. No-op if the lock is held by someone else
 * or has already expired.
 */
async function release(sessionId, token) {
  if (!token || token === NOOP_TOKEN || !isRedisReady()) return;
  const key = sessionKey(sessionId);
  // CAS delete — same reason as refresh.
  const lua = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    else
      return 0
    end
  `;
  try {
    await redisClient.eval(lua, { keys: [key], arguments: [token] });
  } catch (err) {
    logger.warn(`sessionOwnershipLock.release(${sessionId}) failed: ${err.message}`);
  }
}

/**
 * Convenience wrapper: acquire the lock, run `fn(token)` while
 * keeping the TTL alive via a periodic heartbeat, and release on the
 * way out (success OR failure). If the heartbeat detects the lock
 * was taken away, it cancels the heartbeat — but does NOT abort
 * `fn`. Aborting in flight Telegram RPCs is dangerous (half-sent
 * messages); the *caller* is responsible for checking
 * `wasOwnershipLost()` between RPCs and bailing cleanly.
 */
async function withSessionLock(sessionId, holderId, fn, opts = {}) {
  const ttlMs = opts.ttlMs || DEFAULT_LOCK_TTL_MS;
  const heartbeatMs = opts.heartbeatMs || DEFAULT_HEARTBEAT_MS;
  const acq = await acquire(sessionId, holderId, { ttlMs });
  if (!acq) {
    const err = new Error(
      `Session ${sessionId} is currently owned by another worker. Refusing to open a second MTProto connection on the same auth_key.`
    );
    err.code = 'SESSION_LOCKED_BY_OTHER_WORKER';
    err.statusCode = 409;
    throw err;
  }

  let lostOwnership = false;
  let stopped = false;
  const heartbeat = setInterval(async () => {
    if (stopped) return;
    const stillOurs = await refresh(sessionId, acq.token, { ttlMs });
    if (!stillOurs) {
      lostOwnership = true;
      clearInterval(heartbeat);
    }
  }, heartbeatMs);
  // Ensure the heartbeat doesn't keep the process alive on its own.
  if (heartbeat.unref) heartbeat.unref();

  try {
    return await fn(acq.token, () => lostOwnership);
  } finally {
    stopped = true;
    clearInterval(heartbeat);
    await release(sessionId, acq.token);
  }
}

/**
 * Quick-look helper for the verify-sessions script and ops endpoints:
 * who currently holds the lock on this session, if anyone?
 */
async function inspect(sessionId) {
  if (!isRedisReady()) return { available: false };
  try {
    const v = await redisClient.get(sessionKey(sessionId));
    if (!v) return { available: true, held: false };
    return { available: true, held: true, holderToken: v };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

module.exports = {
  acquire,
  refresh,
  release,
  withSessionLock,
  inspect,
  // Internal helpers exported for the smoke test.
  _internal: {
    sessionKey,
    KEY_PREFIX,
    NOOP_TOKEN,
    DEFAULT_LOCK_TTL_MS,
    DEFAULT_HEARTBEAT_MS,
  },
};
