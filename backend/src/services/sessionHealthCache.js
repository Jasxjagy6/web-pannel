/**
 * sessionHealthCache — cache `getMe()` results so the panel doesn't
 * hammer Telegram with 1 RPC per request per session at high session
 * counts.
 *
 * ============================================================
 *   Why
 * ============================================================
 *
 * Every UI tab refresh, every status poll, every "is this session
 * still alive" check today calls `client.getMe()`. With 1000
 * sessions and a polling UI that's tens of thousands of getMe calls
 * per minute. Telegram spam servers don't like that pattern from one
 * IP either.
 *
 * `getMe()` data (telegramId, username, firstName, photo, isPremium)
 * doesn't change second-to-second. Caching it for 30s for "active"
 * checks and re-fetching only when the in-process MTProto socket
 * actually emits a sign of death (auth_key error, parse error,
 * disconnect) is dramatically cheaper without sacrificing accuracy.
 *
 * The cache is process-local on purpose — it's just memoization, not
 * a coordination mechanism. Different processes hold their own
 * MTProto connections and naturally have their own caches.
 *
 * The lock side of "should this session connect at all" is in
 * `sessionOwnershipLock.js`. This module is just about reducing
 * traffic to Telegram for already-connected sessions.
 *
 * ============================================================
 *   Negative caching
 * ============================================================
 *
 * If `getMe` throws a *permanent* error (AUTH_KEY_UNREGISTERED,
 * SESSION_REVOKED, USER_DEACTIVATED) we cache the failure briefly
 * and re-throw — re-trying the same dead session in a tight loop is
 * a pure FLOOD_WAIT magnet. Caller-visible behaviour is unchanged
 * (we re-throw the original error).
 */

'use strict';

const logger = require('../utils/logger');

const POSITIVE_TTL_MS = 30_000;            // 30s: identity rarely changes
const NEGATIVE_TTL_MS = 5 * 60 * 1000;     // 5min: don't re-poll dead sessions
// Don't ever use a stale entry past this point even if we couldn't
// reach Telegram — operators want to know about a dead session
// faster than this.
const HARD_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const cache = new Map();
// In-flight de-duplication: if two callers ask for getMe on the
// same session at the same moment we want to send ONE Telegram
// request, not two. Map<sessionId, Promise>.
const inflight = new Map();

function _now() { return Date.now(); }

function _setEntry(sessionId, value, isError = false) {
  cache.set(String(sessionId), {
    at: _now(),
    value,
    isError,
  });
}

function _getEntry(sessionId) {
  const entry = cache.get(String(sessionId));
  if (!entry) return null;
  const age = _now() - entry.at;
  const ttl = entry.isError ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
  if (age > Math.min(ttl, HARD_MAX_AGE_MS)) {
    cache.delete(String(sessionId));
    return null;
  }
  return entry;
}

/**
 * Get a cached identity for `sessionId`, falling back to `fetcher`.
 * `fetcher` is the actual `getMe` invocation; we pass it in instead
 * of importing telegramService to avoid a circular dependency.
 *
 * @param {number|string} sessionId
 * @param {() => Promise<any>} fetcher
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh=false]  ignore cache for this call
 * @returns {Promise<any>}
 */
async function getCachedMe(sessionId, fetcher, opts = {}) {
  if (typeof fetcher !== 'function') {
    throw new Error('sessionHealthCache.getCachedMe: fetcher must be a function');
  }
  const sid = String(sessionId);

  if (!opts.forceRefresh) {
    const entry = _getEntry(sid);
    if (entry) {
      if (entry.isError) {
        // Re-throw the cached error so callers see identical
        // semantics to a fresh failure.
        const e = new Error(entry.value.message);
        e.code = entry.value.code;
        e.cached = true;
        throw e;
      }
      return entry.value;
    }
  }

  const existing = inflight.get(sid);
  if (existing) return existing;

  const p = (async () => {
    try {
      const me = await fetcher();
      _setEntry(sid, me, false);
      return me;
    } catch (err) {
      // Only negative-cache errors that are obviously permanent — a
      // transient TypeNotFoundError or NETWORK shouldn't sentence
      // the session to 5 minutes of "dead".
      const msg = String(err && err.message || err);
      const permanent =
        /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|SESSION_EXPIRED/i.test(msg);
      if (permanent) {
        _setEntry(sid, { message: msg, code: err && err.code }, true);
      }
      throw err;
    } finally {
      inflight.delete(sid);
    }
  })();

  inflight.set(sid, p);
  return p;
}

/**
 * Forget the cache for a session. Call this from any place that knows
 * the identity has changed (re-login, profile edit, manual refresh
 * button).
 */
function invalidate(sessionId) {
  cache.delete(String(sessionId));
}

/**
 * Forget every cache entry. Used by `verify-sessions.js` so the
 * pre-deploy snapshot always reflects fresh data.
 */
function invalidateAll() {
  cache.clear();
}

/**
 * Inspect the cache — used by `/health/sessions` ops endpoint and
 * the test suite.
 */
function stats() {
  const now = _now();
  let positive = 0;
  let negative = 0;
  for (const v of cache.values()) {
    if (v.isError) negative++;
    else positive++;
  }
  return {
    size: cache.size,
    positive,
    negative,
    inflight: inflight.size,
    now,
  };
}

module.exports = {
  getCachedMe,
  invalidate,
  invalidateAll,
  stats,
  POSITIVE_TTL_MS,
  NEGATIVE_TTL_MS,
  HARD_MAX_AGE_MS,
  // Exposed only for tests.
  _internal: {
    cache,
    inflight,
  },
};

// On hot reload of this module (rare in dev, never in prod) make sure
// nothing dangling stays. process.on('exit') is fine here — Node won't
// double-register because the module is cached after first require.
process.on('exit', () => {
  try { cache.clear(); inflight.clear(); } catch { /* ignore */ }
});

logger.info(
  `sessionHealthCache initialized (positiveTTL=${POSITIVE_TTL_MS}ms, negativeTTL=${NEGATIVE_TTL_MS}ms)`
);
