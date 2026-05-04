/**
 * Per-session daily scrape quota.
 *
 * Why this exists:
 * `sessionLimiter` (Phase 1, B7) caps the *rate* at which a session
 * can hit IG (~6 reads/min), but not the *total volume* per day. A
 * patient operator could still pull 8 000+ users a day on a single
 * session by sustaining the rate-limited cadence for hours, which is
 * far above what a real human ever browses. IG eventually flags that
 * with `feedback_required` even when each individual call passes the
 * burst filter.
 *
 * This module enforces a sliding 24 h cap on the number of users
 * inserted by scrape jobs running on a given session, surfaced as a
 * recoverable error so the worker can either fail the job cleanly or
 * pivot to a different session within a multi-session job.
 *
 * Backed by Redis with an in-memory fallback so dev/test setups keep
 * working without Redis.
 */

'use strict';

const logger = require('../../utils/logger');
const { redisClient } = require('../../config/redis');
const systemSettings = require('../../services/systemSettingsService');

// Default daily cap per session. Operators can override via the
// `scrape.instagram.daily_user_cap_per_session` system setting.
const _DEFAULT_DAILY_USER_CAP = 4000;
const _WINDOW_SECONDS = 24 * 60 * 60;

const _memCounters = new Map(); // key=sessionId|YYYYMMDD -> {count, resetAt}

function _todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

function _redisKey(sessionId) {
  return `ig:scrape_daily:${sessionId}:${_todayKey()}`;
}

function _isRedisReady() {
  return !!(redisClient && redisClient.isReady);
}

async function _getCap() {
  try {
    const v = await systemSettings.getSetting('scrape.instagram.daily_user_cap_per_session');
    if (v == null) return _DEFAULT_DAILY_USER_CAP;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : _DEFAULT_DAILY_USER_CAP;
  } catch (_err) {
    return _DEFAULT_DAILY_USER_CAP;
  }
}

/**
 * Returns the current 24 h count for `sessionId` (used by tests and
 * the admin dashboard).
 */
async function getCount(sessionId) {
  if (!sessionId) return 0;
  if (_isRedisReady()) {
    try {
      const v = await redisClient.get(_redisKey(sessionId));
      return v == null ? 0 : Number(v) || 0;
    } catch (err) {
      logger.warn(`IG.scrapeQuota.getCount redis fail: ${err.message}`);
    }
  }
  const memKey = `${sessionId}|${_todayKey()}`;
  const slot = _memCounters.get(memKey);
  return slot ? slot.count : 0;
}

/**
 * Increment the per-session daily counter by `delta`. Returns the
 * post-increment count.
 */
async function increment(sessionId, delta) {
  if (!sessionId || !delta || delta <= 0) return getCount(sessionId);
  if (_isRedisReady()) {
    try {
      const k = _redisKey(sessionId);
      const next = await redisClient.incrBy(k, delta);
      // Make sure the key actually expires; INCR alone preserves TTL
      // only if the key already existed. EXPIRE NX is idempotent.
      try { await redisClient.expire(k, _WINDOW_SECONDS, 'NX'); } catch (_e) {
        // Older redis clients don't support NX flag — fall back.
        await redisClient.expire(k, _WINDOW_SECONDS);
      }
      return Number(next) || 0;
    } catch (err) {
      logger.warn(`IG.scrapeQuota.increment redis fail: ${err.message}`);
    }
  }
  const memKey = `${sessionId}|${_todayKey()}`;
  const slot = _memCounters.get(memKey) || { count: 0, resetAt: Date.now() + _WINDOW_SECONDS * 1000 };
  slot.count += delta;
  _memCounters.set(memKey, slot);
  return slot.count;
}

/**
 * Throws RISK_DAILY_CAP if `sessionId` would breach its daily cap by
 * inserting `delta` more users. Caller-side check — increment AFTER
 * the actual insert so we don't over-count on retries.
 */
async function assertWithinCap(sessionId, delta) {
  if (!sessionId) return { allowed: true, cap: 0, remaining: 0 };
  const cap = await _getCap();
  const cur = await getCount(sessionId);
  if (cur + delta > cap) {
    const e = new Error(
      `Daily scrape cap reached for IG session ${sessionId} ` +
      `(${cur}/${cap} users in last 24 h). Cooldown automatically; ` +
      `override via scrape.instagram.daily_user_cap_per_session.`
    );
    e.code = 'RISK_DAILY_CAP';
    e.kind = 'daily_cap';
    e.statusCode = 429;
    e.cap = cap;
    e.current = cur;
    throw e;
  }
  return { allowed: true, cap, remaining: cap - cur - delta };
}

/**
 * Atomic-ish "consume up to N users" helper used by the scrape
 * worker: returns how many of the requested `desired` users we are
 * allowed to actually insert before the cap, then increments the
 * counter by exactly that amount.
 *
 *   const slice = await scrapeQuota.consume(sessionId, batch.length);
 *   if (slice <= 0) throw RISK_DAILY_CAP;
 *   batch = batch.slice(0, slice);
 *   await insert(batch);
 */
async function consume(sessionId, desired) {
  if (!sessionId || desired <= 0) return 0;
  const cap = await _getCap();
  const cur = await getCount(sessionId);
  const headroom = Math.max(0, cap - cur);
  const allowed = Math.min(desired, headroom);
  if (allowed > 0) {
    await increment(sessionId, allowed);
  }
  return allowed;
}

module.exports = {
  getCount,
  increment,
  consume,
  assertWithinCap,
  _DEFAULT_DAILY_USER_CAP,
};
