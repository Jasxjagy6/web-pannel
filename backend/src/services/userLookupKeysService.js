/**
 * Per-user lookup-key vault — PR #5 / PR #6 / PR #7.
 *
 * The IG lookup pipeline reaches out to a number of paid APIs:
 *
 *   Breach DBs  — Dehashed, LeakCheck, Snusbase, IntelligenceX, HIBP
 *   Reverse-img — SerpAPI (Yandex/Google), PimEyes, TinEye
 *   WHOIS / DNS — whoisxmlapi.com, whoxy.com
 *   CAPTCHA     — 2captcha.com
 *
 * Each operator stores their own keys (multi-tenant panel) so quotas /
 * billing stay isolated. Keys land in `user_lookup_keys` encrypted with the
 * same AES-GCM helper used for session strings. Service falls back to
 * matching `process.env.*` so a single-tenant dev deploy can populate
 * .env without DB writes.
 *
 * The provider list and env-fallback mapping is centralised here so
 * each consumer (breachCorrelator, reverseImage, linkExpander,
 * twoCaptcha) doesn't re-implement key resolution.
 */

'use strict';

const { pool } = require('../config/database');
const { encrypt, decrypt } = require('../utils/crypto');
const { AppError } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const PROVIDERS = Object.freeze([
  'dehashed',
  'leakcheck',
  'snusbase',
  'intelligencex',
  'hibp',
  'serpapi',
  'pimeyes',
  'tineye',
  'whoisxml',
  'whoxy',
  '2captcha',
]);

// Env-var fallbacks for single-tenant / dev deploys. Each value is a tuple
// of [keyEnv, metaEnv?] — Dehashed needs username + key, the rest just key.
const ENV_FALLBACK = Object.freeze({
  dehashed:      ['DEHASHED_API_KEY',      'DEHASHED_USERNAME'],
  leakcheck:     ['LEAKCHECK_API_KEY',     null],
  snusbase:      ['SNUSBASE_API_KEY',      null],
  intelligencex: ['INTELLIGENCEX_API_KEY', null],
  hibp:          ['HIBP_API_KEY',          null],
  serpapi:       ['SERPAPI_KEY',           null],
  pimeyes:       ['PIMEYES_API_KEY',       null],
  tineye:        ['TINEYE_API_KEY',        null],
  whoisxml:      ['WHOISXML_API_KEY',      null],
  whoxy:         ['WHOXY_API_KEY',         null],
  '2captcha':    ['TWOCAPTCHA_API_KEY',    null],
});

function _normaliseProvider(p) {
  const v = String(p || '').trim().toLowerCase();
  if (!PROVIDERS.includes(v)) {
    throw new AppError(
      `Unknown lookup provider "${p}". Supported: ${PROVIDERS.join(', ')}.`,
      400,
      'INVALID_PROVIDER'
    );
  }
  return v;
}

/**
 * Resolve the key for one provider for a given user_id. Returns
 *   { key, meta }  on success
 *   null           when neither the DB nor .env has a key
 *
 * The DB row wins over .env so an operator can override the system
 * default with their own quota.
 */
async function getKey(userId, provider) {
  const prov = _normaliseProvider(provider);
  let row = null;
  if (userId) {
    const { rows } = await pool.query(
      `SELECT key_enc, meta FROM user_lookup_keys
        WHERE user_id = $1 AND provider = $2 AND is_active = TRUE
        ORDER BY id DESC LIMIT 1`,
      [userId, prov]
    );
    row = rows[0] || null;
  }
  if (row) {
    try {
      return {
        provider: prov,
        key: decrypt(row.key_enc),
        meta: row.meta || {},
        source: 'db',
      };
    } catch (err) {
      logger.warn(`userLookupKeys: decrypt failed for user=${userId} provider=${prov}: ${err.message}`);
      return null;
    }
  }
  const [keyEnv, metaEnv] = ENV_FALLBACK[prov] || [null, null];
  const envKey = keyEnv ? process.env[keyEnv] : null;
  if (envKey) {
    const meta = {};
    if (metaEnv && process.env[metaEnv]) meta.username = process.env[metaEnv];
    return { provider: prov, key: envKey, meta, source: 'env' };
  }
  return null;
}

/**
 * Bulk-fetch resolution map. Returns {provider: {key, meta, source} | null}.
 */
async function getAllKeys(userId) {
  const out = {};
  for (const p of PROVIDERS) {
    // eslint-disable-next-line no-await-in-loop
    out[p] = await getKey(userId, p).catch(() => null);
  }
  return out;
}

async function listKeys(userId) {
  const { rows } = await pool.query(
    `SELECT id, provider, label, meta, is_active, created_at, updated_at
       FROM user_lookup_keys
      WHERE user_id = $1
      ORDER BY provider ASC`,
    [userId]
  );
  // For env-only providers, surface a synthetic "env" row so the
  // operator UI can show which keys are configured globally.
  const haveDb = new Set(rows.map((r) => r.provider));
  const out = rows.map((r) => ({ ...r, source: 'db' }));
  for (const p of PROVIDERS) {
    const [keyEnv] = ENV_FALLBACK[p] || [null];
    if (!haveDb.has(p) && keyEnv && process.env[keyEnv]) {
      out.push({
        id: null,
        provider: p,
        label: `${keyEnv} (env)`,
        meta: {},
        is_active: true,
        created_at: null,
        updated_at: null,
        source: 'env',
      });
    }
  }
  return out;
}

async function upsertKey({ userId, provider, key, meta = null, label = null }) {
  const prov = _normaliseProvider(provider);
  if (!key || typeof key !== 'string' || key.trim().length < 4) {
    throw new AppError('key is required (>=4 chars)', 400, 'VALIDATION_ERROR');
  }
  if (!userId) throw new AppError('userId required', 400, 'VALIDATION_ERROR');
  const enc = encrypt(key.trim());
  const metaJson = meta && typeof meta === 'object' ? meta : {};
  const { rows } = await pool.query(
    `INSERT INTO user_lookup_keys (user_id, provider, key_enc, meta, label, is_active)
     VALUES ($1, $2, $3, $4::jsonb, $5, TRUE)
     ON CONFLICT (user_id, provider)
     DO UPDATE SET key_enc    = EXCLUDED.key_enc,
                   meta       = EXCLUDED.meta,
                   label      = COALESCE(EXCLUDED.label, user_lookup_keys.label),
                   is_active  = TRUE,
                   updated_at = NOW()
     RETURNING id, provider, label, meta, is_active, created_at, updated_at`,
    [userId, prov, enc, JSON.stringify(metaJson), label || null]
  );
  return { ...rows[0], source: 'db' };
}

async function deleteKey({ userId, provider }) {
  const prov = _normaliseProvider(provider);
  await pool.query(
    `DELETE FROM user_lookup_keys
      WHERE user_id = $1 AND provider = $2`,
    [userId, prov]
  );
  return { ok: true };
}

/**
 * Diagnostic helper — returns which providers are currently usable for
 * the given user (DB row OR env fallback). Used by the operator UI to
 * grey-out unconfigured probes.
 */
async function configuredProviders(userId) {
  const all = await getAllKeys(userId);
  const out = {};
  for (const p of PROVIDERS) out[p] = !!all[p];
  return out;
}

module.exports = {
  PROVIDERS,
  ENV_FALLBACK,
  getKey,
  getAllKeys,
  listKeys,
  upsertKey,
  deleteKey,
  configuredProviders,
};
