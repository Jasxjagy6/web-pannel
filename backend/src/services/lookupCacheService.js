/**
 * Lookup paid-API response cache — PR #5 / PR #6.
 *
 * Two-layer cache for the breach DBs, reverse-image services, and
 * WHOIS lookups. Both layers are best-effort:
 *
 *   L1 — Redis (`ig:lookup:cache:{provider}:{hash}`) — TTL 7d.
 *   L2 — `lookup_api_cache` PG row — TTL 7d (`expires_at`).
 *
 * The Redis layer is the hot path; the PG layer survives a Redis
 * eviction / restart so the watch worker doesn't re-spend USD after
 * a cold boot. Callers should treat both layers as soft caches —
 * a cache miss is never an error, just "no warm copy available".
 *
 * Query keying — the cache is keyed on a SHA-256 of the JSON-stable
 * representation of the query shape. Callers should pass a small,
 * normalised query object so e.g. {username:'ALICE'} and
 * {username:'alice'} share a slot.
 */

'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');
const { pool } = require('../config/database');
const { redisClient } = require('../config/redis');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function _isRedisReady() {
  return !!(redisClient && redisClient.isReady);
}

function _stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(_stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${_stableStringify(value[k])}`).join(',')}}`;
}

function hashQuery(provider, shape) {
  const s = `${provider}|${_stableStringify(shape)}`;
  return crypto.createHash('sha256').update(s).digest('hex');
}

function _redisKey(provider, hash) {
  return `ig:lookup:cache:${provider}:${hash}`;
}

async function get(provider, shape) {
  const hash = hashQuery(provider, shape);
  if (_isRedisReady()) {
    try {
      const raw = await redisClient.get(_redisKey(provider, hash));
      if (raw) return JSON.parse(raw);
    } catch (err) {
      logger.warn(`lookupCache: redis read failed for ${provider}: ${err.message}`);
    }
  }
  try {
    const { rows } = await pool.query(
      `SELECT response FROM lookup_api_cache
        WHERE provider = $1 AND query_hash = $2 AND expires_at > NOW()
        ORDER BY id DESC LIMIT 1`,
      [provider, hash]
    );
    if (rows[0]) return rows[0].response;
  } catch (err) {
    logger.warn(`lookupCache: pg read failed for ${provider}: ${err.message}`);
  }
  return null;
}

async function set(provider, shape, response, opts = {}) {
  const hash = hashQuery(provider, shape);
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
  const costUsd = Number(opts.costUsd) || 0;
  const payload = JSON.stringify(response);
  if (_isRedisReady()) {
    try {
      await redisClient.set(_redisKey(provider, hash), payload, { PX: ttlMs });
    } catch (err) {
      logger.warn(`lookupCache: redis write failed for ${provider}: ${err.message}`);
    }
  }
  try {
    await pool.query(
      `INSERT INTO lookup_api_cache
         (provider, query_hash, query_shape, response, cost_usd, expires_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, NOW() + ($6 || ' milliseconds')::interval)
       ON CONFLICT (provider, query_hash)
       DO UPDATE SET response   = EXCLUDED.response,
                     query_shape= EXCLUDED.query_shape,
                     cost_usd   = EXCLUDED.cost_usd,
                     expires_at = EXCLUDED.expires_at`,
      [provider, hash, JSON.stringify(shape || {}), payload, costUsd, String(ttlMs)]
    );
  } catch (err) {
    logger.warn(`lookupCache: pg write failed for ${provider}: ${err.message}`);
  }
}

async function purgeExpired() {
  try {
    const res = await pool.query(`DELETE FROM lookup_api_cache WHERE expires_at < NOW()`);
    return res.rowCount || 0;
  } catch (err) {
    logger.warn(`lookupCache: purgeExpired failed: ${err.message}`);
    return 0;
  }
}

module.exports = {
  get,
  set,
  hashQuery,
  purgeExpired,
  DEFAULT_TTL_MS,
};
