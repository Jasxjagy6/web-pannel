const { pool } = require('../config/database');

/**
 * Tiny in-process cache. The settings table is read on every request that
 * gates a feature, so we don't want a roundtrip per call. The TTL is
 * intentionally very short — 30 s is more than fast enough for an admin
 * to see a price change reflected.
 */
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // key -> { value, fetchedAt }

const DEFAULTS = {
  'billing.subscription_price_usd': 9.99,
  'billing.subscription_period_days': 30,
  'billing.currency': 'USD',
  'billing.trial_enabled': true,
  'billing.trial_duration_minutes': 5,
  'billing.trial_allowed_features': [
    'dashboard', 'sessions', 'scrape', 'messaging', 'groups', 'lists',
    'reports', 'get_otp', 'change_2fa', 'proxies', 'anti_detect', 'privacy',
  ],
};

/**
 * Get a single setting by key. Returns the default if no row exists.
 */
async function getSetting(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }
  const result = await pool.query(
    'SELECT value FROM system_settings WHERE key = $1',
    [key]
  );
  let value;
  if (result.rows.length === 0) {
    value = DEFAULTS[key] !== undefined ? DEFAULTS[key] : null;
  } else {
    value = result.rows[0].value;
  }
  cache.set(key, { value, fetchedAt: Date.now() });
  return value;
}

/**
 * Get many settings at once, returning an object { key: value }.
 */
async function getSettings(keys) {
  const out = {};
  for (const k of keys) {
    out[k] = await getSetting(k);
  }
  return out;
}

/**
 * Get the canonical billing config block used by user/admin pages.
 */
async function getBillingConfig() {
  return getSettings([
    'billing.subscription_price_usd',
    'billing.subscription_period_days',
    'billing.currency',
    'billing.trial_enabled',
    'billing.trial_duration_minutes',
    'billing.trial_allowed_features',
  ]);
}

/**
 * Update one or more settings. The caller is expected to have already
 * authorized the request (admin only).
 */
async function setSettings(patch, updatedBy) {
  const keys = Object.keys(patch);
  for (const k of keys) {
    const v = patch[k];
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
      [k, JSON.stringify(v), updatedBy || null]
    );
    cache.delete(k);
  }
  return getSettings(keys);
}

function invalidate(key) {
  if (key) cache.delete(key);
  else cache.clear();
}

module.exports = {
  getSetting,
  getSettings,
  getBillingConfig,
  setSettings,
  invalidate,
  DEFAULTS,
};
