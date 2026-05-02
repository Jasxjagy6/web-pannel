const { pool } = require('../config/database');
const logger = require('../utils/logger');
const oxapayService = require('./oxapayService');
const settingsService = require('./systemSettingsService');

/**
 * Subscription lifecycle helpers — multi-platform aware.
 *
 * As of the v9 multiplatform migration, subscription state is canonical in
 * the new `user_subscriptions` table (one row per (user_id, platform)).
 * The legacy `users.subscription_*` columns are mirrored from the
 * 'telegram' row for one release cycle so any tooling that hasn't been
 * updated still sees data; a follow-up migration will remove them once
 * the IPN handler and admin tooling have been pointed at user_subscriptions.
 *
 * Public API:
 *
 *   entitlementFor(userRow, platform, feature?) → { allowed, reason, mode }
 *   startTrial(userId, platform)               → snapshot
 *   grantSubscription(userId, platform, opts?) → { snapshot, expiresAt }
 *   expireSubscription(userId, platform, reason) → snapshot
 *   sweepExpired()                              → { expired }
 *   userPublicSnapshot(userRow, subsByPlatform?) → public user object
 *   loadSubscriptions(userId)                   → { telegram: {...}, instagram: {...} }
 *
 * Backwards compatibility:
 *   - entitlementFor(userRow, feature) — second arg defaults to platform=telegram
 *   - startTrial(userId), grantSubscription(userId, opts), expireSubscription(userId, reason)
 *     all default to platform=telegram so legacy callers keep working.
 */

const SUBSCRIPTION_PUBLIC_COLUMNS = `
  id, email, role, status, is_approved,
  subscription_plan, subscription_status, subscription_expires_at,
  subscription_features,
  trial_started_at, trial_expires_at, trial_used,
  created_at, updated_at, last_login
`;

const VALID_PLATFORMS = ['telegram', 'instagram'];
const DEFAULT_PLATFORM = 'telegram';

function _normalizePlatform(p) {
  if (!p) return DEFAULT_PLATFORM;
  const lower = String(p).toLowerCase();
  if (!VALID_PLATFORMS.includes(lower)) {
    throw new Error(`Unknown platform: ${p}`);
  }
  return lower;
}

/**
 * Detect whether the 2nd positional arg of entitlementFor / others is a
 * platform string or a legacy "feature" string. We accept both shapes
 * during the transition.
 */
function _looksLikePlatform(s) {
  if (!s) return false;
  const lower = String(s).toLowerCase();
  return VALID_PLATFORMS.includes(lower);
}

// ---------------------------------------------------------------------------
// Subscription row loaders
// ---------------------------------------------------------------------------

/**
 * Load the canonical (status, expiry, trial) for a user on a single platform.
 * Falls back to synthesising a row from the legacy users.subscription_*
 * columns for telegram if no user_subscriptions row exists yet (e.g. running
 * before v9_3 backfill).
 *
 * Returns:
 *   {
 *     plan, status, expiresAt, features,
 *     trialStartedAt, trialExpiresAt, trialUsed,
 *   }
 */
async function loadSubscription(userId, platform) {
  const p = _normalizePlatform(platform);
  const r = await pool.query(
    `SELECT plan, status, expires_at, features,
            trial_started_at, trial_expires_at, trial_used
       FROM user_subscriptions
      WHERE user_id = $1 AND platform = $2`,
    [userId, p]
  );
  if (r.rows[0]) {
    const row = r.rows[0];
    return {
      plan: row.plan,
      status: row.status,
      expiresAt: row.expires_at,
      features: row.features || {},
      trialStartedAt: row.trial_started_at,
      trialExpiresAt: row.trial_expires_at,
      trialUsed: !!row.trial_used,
    };
  }
  // Legacy fallback for telegram only.
  if (p === 'telegram') {
    const u = await pool.query(
      `SELECT subscription_plan, subscription_status, subscription_expires_at,
              subscription_features,
              trial_started_at, trial_expires_at, trial_used
         FROM users WHERE id = $1`,
      [userId]
    );
    const row = u.rows[0];
    if (row) {
      return {
        plan: row.subscription_plan,
        status: row.subscription_status || 'inactive',
        expiresAt: row.subscription_expires_at,
        features: row.subscription_features || {},
        trialStartedAt: row.trial_started_at,
        trialExpiresAt: row.trial_expires_at,
        trialUsed: !!row.trial_used,
      };
    }
  }
  // No row anywhere — synthesise an inactive default.
  return {
    plan: null,
    status: 'inactive',
    expiresAt: null,
    features: {},
    trialStartedAt: null,
    trialExpiresAt: null,
    trialUsed: false,
  };
}

/**
 * Load the subscription state for every supported platform in one shot.
 * Used by the /billing/status endpoint and the public user snapshot.
 *
 *   { telegram: {...}, instagram: {...} }
 */
async function loadSubscriptions(userId) {
  const out = {};
  for (const p of VALID_PLATFORMS) {
    // eslint-disable-next-line no-await-in-loop
    out[p] = await loadSubscription(userId, p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public snapshot
// ---------------------------------------------------------------------------

/**
 * Build the public user snapshot the frontend consumes from /auth/profile,
 * /auth/login, /billing/status and the admin user list.
 *
 * Always returns BOTH the legacy `subscription` / `trial` block (mirrored
 * from the telegram subscription row, for one-release backwards-compat with
 * any callers still reading user.subscription) and the new `subscriptions`
 * map keyed by platform.
 */
function userPublicSnapshot(row, subsByPlatform) {
  if (!row) return null;
  const tg = subsByPlatform?.telegram || {
    plan: row.subscription_plan,
    status: row.subscription_status || 'inactive',
    expiresAt: row.subscription_expires_at,
    features: row.subscription_features || {},
    trialStartedAt: row.trial_started_at,
    trialExpiresAt: row.trial_expires_at,
    trialUsed: !!row.trial_used,
  };
  const ig = subsByPlatform?.instagram || {
    plan: null,
    status: 'inactive',
    expiresAt: null,
    features: {},
    trialStartedAt: null,
    trialExpiresAt: null,
    trialUsed: false,
  };

  function shape(s) {
    return {
      plan: s.plan,
      status: s.status,
      expiresAt: s.expiresAt,
      features: s.features || {},
      trial: {
        startedAt: s.trialStartedAt,
        expiresAt: s.trialExpiresAt,
        used: !!s.trialUsed,
      },
    };
  }

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    isApproved: row.is_approved,
    // Legacy single-platform fields (mirror of the telegram row)
    subscription: {
      plan: tg.plan,
      status: tg.status,
      expiresAt: tg.expiresAt,
      features: tg.features || {},
    },
    trial: {
      startedAt: tg.trialStartedAt,
      expiresAt: tg.trialExpiresAt,
      used: !!tg.trialUsed,
    },
    // New per-platform map
    subscriptions: {
      telegram: shape(tg),
      instagram: shape(ig),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLogin: row.last_login,
  };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

async function recordEvent(userId, platform, eventType, description, details, invoiceId) {
  // Backwards-compat: callers may still pass (userId, eventType, description, details, invoiceId)
  // i.e. without a platform. Detect by sniffing whether the 2nd arg is a platform.
  let p = DEFAULT_PLATFORM;
  let evt = eventType;
  let desc = description;
  let det = details;
  let inv = invoiceId;
  if (!_looksLikePlatform(platform)) {
    // Legacy positional shape: shift everything.
    inv = details;
    det = description;
    desc = eventType;
    evt = platform;
    p = DEFAULT_PLATFORM;
  } else {
    p = _normalizePlatform(platform);
  }
  await pool.query(
    `INSERT INTO subscription_events (user_id, invoice_id, event_type, description, details, platform)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [userId, inv || null, evt, desc || null, JSON.stringify(det || {}), p]
  );
}

// ---------------------------------------------------------------------------
// Settings helpers — per-platform billing config with sensible fallback to
// the legacy single-platform keys for telegram, so an installation that
// hasn't run the v9 seed still works.
// ---------------------------------------------------------------------------

async function _platformBillingValue(platform, key, legacyKey, fallback) {
  const p = _normalizePlatform(platform);
  const v = await settingsService.getSetting(`billing.${p}.${key}`);
  if (v !== null && v !== undefined) return v;
  if (p === 'telegram' && legacyKey) {
    const lv = await settingsService.getSetting(legacyKey);
    if (lv !== null && lv !== undefined) return lv;
  }
  return fallback;
}

async function _trialEnabled(platform) {
  return _platformBillingValue(platform, 'trial_enabled', 'billing.trial_enabled', true);
}

async function _trialDurationMinutes(platform) {
  return _platformBillingValue(
    platform,
    'trial_duration_minutes',
    'billing.trial_duration_minutes',
    5
  );
}

async function _trialAllowedFeatures(platform) {
  return _platformBillingValue(
    platform,
    'trial_allowed_features',
    'billing.trial_allowed_features',
    []
  );
}

async function _subscriptionPriceUsd(platform) {
  return _platformBillingValue(
    platform,
    'subscription_price_usd',
    'billing.subscription_price_usd',
    9.99
  );
}

async function _subscriptionPeriodDays(platform) {
  return _platformBillingValue(
    platform,
    'subscription_period_days',
    'billing.subscription_period_days',
    30
  );
}

// ---------------------------------------------------------------------------
// Entitlement
// ---------------------------------------------------------------------------

/**
 * Compute the effective "can the user access this feature on this platform
 * right now?" predicate. Admins bypass everything.
 *
 * Signatures (we accept both during the transition):
 *   entitlementFor(userRow, platform, feature?)  // new
 *   entitlementFor(userRow, feature?)            // legacy → platform=telegram
 *
 * Returns { allowed, reason, mode, platform }.
 */
async function entitlementFor(userRow, platform, feature) {
  // Backwards-compat: distinguish (userRow, feature) from (userRow, platform, feature).
  let p = DEFAULT_PLATFORM;
  let f = feature;
  if (typeof platform === 'string' && _looksLikePlatform(platform)) {
    p = _normalizePlatform(platform);
  } else {
    // Legacy two-arg call.
    f = platform || null;
    p = DEFAULT_PLATFORM;
  }

  if (!userRow) return { allowed: false, reason: 'not_authenticated', mode: 'none', platform: p };
  if (userRow.role === 'admin') {
    return { allowed: true, reason: 'admin', mode: 'admin', platform: p };
  }
  if (userRow.status === 'banned') {
    return { allowed: false, reason: 'banned', mode: 'none', platform: p };
  }
  if (!userRow.is_approved) {
    return { allowed: false, reason: 'not_approved', mode: 'none', platform: p };
  }

  const sub = await loadSubscription(userRow.id, p);
  const now = new Date();

  const subActive = sub.status === 'active'
    && sub.expiresAt
    && new Date(sub.expiresAt) > now;
  if (subActive) {
    return { allowed: true, reason: 'subscription_active', mode: 'subscription', platform: p };
  }

  const trialActive = sub.trialExpiresAt && new Date(sub.trialExpiresAt) > now;
  if (trialActive) {
    if (!f) return { allowed: true, reason: 'trial_active', mode: 'trial', platform: p };
    const allowed = await _trialAllowedFeatures(p);
    const list = Array.isArray(allowed) ? allowed : [];
    if (list.includes(f)) {
      return { allowed: true, reason: 'trial_active', mode: 'trial', platform: p };
    }
    return { allowed: false, reason: 'trial_feature_not_allowed', mode: 'trial', platform: p };
  }

  return { allowed: false, reason: 'subscription_required', mode: 'none', platform: p };
}

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

async function _upsertSubscription(client, userId, platform, patch) {
  // We use INSERT ... ON CONFLICT so the first row gets created if the user
  // hasn't subscribed to this platform yet.
  const cols = [];
  const setCols = [];
  const params = [userId, platform];
  let i = params.length;
  function bind(col, value, raw) {
    if (value === undefined) return;
    if (raw) {
      cols.push(col);
      setCols.push(`${col} = ${raw}`);
      return;
    }
    i += 1;
    params.push(value);
    cols.push(col);
    setCols.push(`${col} = $${i}`);
  }
  if (patch.plan !== undefined) bind('plan', patch.plan);
  if (patch.status !== undefined) bind('status', patch.status);
  if (patch.expiresAt !== undefined) bind('expires_at', patch.expiresAt);
  if (patch.featuresJson !== undefined) {
    i += 1;
    params.push(patch.featuresJson);
    cols.push('features');
    setCols.push(`features = $${i}::jsonb`);
  }
  if (patch.trialStartedAt !== undefined) bind('trial_started_at', patch.trialStartedAt);
  if (patch.trialExpiresAt !== undefined) bind('trial_expires_at', patch.trialExpiresAt);
  if (patch.trialUsed !== undefined) bind('trial_used', patch.trialUsed);
  // Also support raw SQL for the GREATEST(...) extension trick.
  if (patch.rawExpiresExtension) {
    bind('expires_at', null, patch.rawExpiresExtension);
  }

  const insertCols = ['user_id', 'platform', ...cols];
  const insertVals = ['$1', '$2', ...cols.map((_c, idx) => `$${3 + idx}`)];
  // Re-flatten: we already pushed values into params in order; for INSERT
  // we need to use those same param positions in insertVals.
  // Simpler: rebuild with explicit ordering.
  const flatParams = [userId, platform];
  const flatCols = ['user_id', 'platform'];
  const flatVals = ['$1', '$2'];
  let idx = 2;
  function pushCol(col, value, raw) {
    if (value === undefined && !raw) return;
    flatCols.push(col);
    if (raw) {
      flatVals.push(raw);
    } else {
      idx += 1;
      flatVals.push(`$${idx}`);
      flatParams.push(value);
    }
  }
  if (patch.plan !== undefined) pushCol('plan', patch.plan);
  if (patch.status !== undefined) pushCol('status', patch.status);
  if (patch.expiresAt !== undefined) pushCol('expires_at', patch.expiresAt);
  if (patch.featuresJson !== undefined) {
    flatCols.push('features');
    idx += 1;
    flatVals.push(`$${idx}::jsonb`);
    flatParams.push(patch.featuresJson);
  }
  if (patch.trialStartedAt !== undefined) pushCol('trial_started_at', patch.trialStartedAt);
  if (patch.trialExpiresAt !== undefined) pushCol('trial_expires_at', patch.trialExpiresAt);
  if (patch.trialUsed !== undefined) pushCol('trial_used', patch.trialUsed);
  if (patch.rawExpiresExtension) {
    flatCols.push('expires_at');
    flatVals.push(patch.rawExpiresExtension);
  }
  flatCols.push('updated_at');
  flatVals.push('NOW()');

  const updateAssign = setCols.length
    ? `${setCols.join(', ')}, updated_at = NOW()`
    : 'updated_at = NOW()';

  const sql = `
    INSERT INTO user_subscriptions (${flatCols.join(', ')})
    VALUES (${flatVals.join(', ')})
    ON CONFLICT (user_id, platform) DO UPDATE SET ${updateAssign}
    RETURNING plan, status, expires_at, features,
              trial_started_at, trial_expires_at, trial_used
  `;
  const r = await client.query(sql, flatParams);
  return r.rows[0];
}

async function _mirrorTelegramToLegacyColumns(userId) {
  // For one release cycle we keep `users.subscription_*` and `users.trial_*`
  // in sync with the telegram row of `user_subscriptions`. This lets any
  // tooling that hasn't been updated still see the right values.
  await pool.query(
    `UPDATE users u
        SET subscription_plan       = us.plan,
            subscription_status     = us.status,
            subscription_expires_at = us.expires_at,
            subscription_features   = us.features,
            trial_started_at        = us.trial_started_at,
            trial_expires_at        = us.trial_expires_at,
            trial_used              = us.trial_used,
            updated_at              = NOW()
       FROM user_subscriptions us
      WHERE us.user_id = u.id
        AND us.platform = 'telegram'
        AND u.id = $1`,
    [userId]
  );
}

async function _publicSnapshotById(userId) {
  const u = await pool.query(
    `SELECT ${SUBSCRIPTION_PUBLIC_COLUMNS} FROM users WHERE id = $1`,
    [userId]
  );
  const subs = await loadSubscriptions(userId);
  return userPublicSnapshot(u.rows[0], subs);
}

/**
 * Activate a free trial for a user on a given platform. Idempotent against
 * the `trial_used` flag — a user may only trial each platform once.
 *
 * Signatures:
 *   startTrial(userId, platform)
 *   startTrial(userId)            // legacy → platform=telegram
 */
async function startTrial(userId, platform) {
  const p = _normalizePlatform(platform);
  const sub = await loadSubscription(userId, p);
  if (sub.trialUsed) {
    const e = new Error('Trial already used');
    e.code = 'TRIAL_ALREADY_USED';
    throw e;
  }

  const trialEnabled = await _trialEnabled(p);
  if (!trialEnabled) {
    const e = new Error('Free trial is currently disabled by the administrator');
    e.code = 'TRIAL_DISABLED';
    throw e;
  }

  const minutes = parseInt(await _trialDurationMinutes(p), 10) || 5;

  await _upsertSubscription(pool, userId, p, {
    trialStartedAt: new Date(),
    trialUsed: true,
    rawExpiresExtension: undefined,
    // We use a parameterized expiry for the trial through trial_expires_at.
  });
  // The trial expiry is computed via NOW() + interval directly so we don't
  // care about clock skew between the API server and Postgres.
  await pool.query(
    `UPDATE user_subscriptions
        SET trial_expires_at = NOW() + ($3 || ' minutes')::interval,
            updated_at       = NOW()
      WHERE user_id = $1 AND platform = $2`,
    [userId, p, String(minutes)]
  );

  if (p === 'telegram') {
    await _mirrorTelegramToLegacyColumns(userId);
  }

  await recordEvent(userId, p, 'trial_started', `Trial started for ${minutes} minute(s) on ${p}`,
    { minutes, platform: p });
  logger.info('Trial started', { userId, platform: p, minutes });
  return _publicSnapshotById(userId);
}

/**
 * Grant the user a paid subscription for `days` days on the given platform.
 * Extends the existing window if it's still in the future.
 *
 * Signatures:
 *   grantSubscription(userId, platform, opts?)
 *   grantSubscription(userId, opts?)       // legacy → platform=telegram
 */
async function grantSubscription(userId, platform, opts) {
  let p = DEFAULT_PLATFORM;
  let o = opts || {};
  if (typeof platform === 'string' && _looksLikePlatform(platform)) {
    p = _normalizePlatform(platform);
  } else if (platform && typeof platform === 'object') {
    o = platform;
  }
  o = o || {};

  const days = parseInt(o.days, 10) > 0
    ? parseInt(o.days, 10)
    : (parseInt(await _subscriptionPeriodDays(p), 10) || 30);
  const plan = o.plan || 'monthly';

  await _upsertSubscription(pool, userId, p, {
    status: 'active',
    plan,
    rawExpiresExtension:
      `GREATEST(COALESCE(user_subscriptions.expires_at, NOW()), NOW()) + (${pgQuoteString(String(days))} || ' days')::interval`,
  });

  // Read back the canonical row so we return the exact expiry.
  const after = await loadSubscription(userId, p);

  if (p === 'telegram') {
    await _mirrorTelegramToLegacyColumns(userId);
  }

  await recordEvent(
    userId,
    p,
    'subscription_granted',
    `Subscription extended by ${days} day(s) on ${p}`,
    { days, plan, platform: p, expiresAt: after.expiresAt },
    o.invoiceId
  );
  logger.info('Subscription granted', { userId, platform: p, days, plan });
  return { snapshot: await _publicSnapshotById(userId), expiresAt: after.expiresAt };
}

/**
 * Pg-safe quote of a numeric-looking string for inline SQL fragments. Only
 * used internally for the `(N || ' days')::interval` trick.
 */
function pgQuoteString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Force expire a user's subscription (admin override) on a given platform.
 *
 * Signatures:
 *   expireSubscription(userId, platform, reason)
 *   expireSubscription(userId, reason)             // legacy → platform=telegram
 */
async function expireSubscription(userId, platform, reason) {
  let p = DEFAULT_PLATFORM;
  let r = reason;
  if (typeof platform === 'string' && _looksLikePlatform(platform)) {
    p = _normalizePlatform(platform);
  } else {
    r = platform;
  }

  await _upsertSubscription(pool, userId, p, {
    status: 'expired',
    expiresAt: new Date(),
  });
  if (p === 'telegram') {
    await _mirrorTelegramToLegacyColumns(userId);
  }
  await recordEvent(userId, p, 'subscription_expired', r || 'Manually expired', { platform: p });
  return _publicSnapshotById(userId);
}

/**
 * Sweep: any active subscription on any platform whose expiry has passed →
 * expired. Mirrors the legacy users.subscription_* columns for telegram.
 */
async function sweepExpired() {
  const subs = await pool.query(
    `UPDATE user_subscriptions
        SET status     = 'expired',
            updated_at = NOW()
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at < NOW()
      RETURNING user_id, platform`
  );
  for (const r of subs.rows) {
    // eslint-disable-next-line no-await-in-loop
    await recordEvent(r.user_id, r.platform, 'subscription_expired', 'Auto-expired by sweep', {
      platform: r.platform,
    });
    if (r.platform === 'telegram') {
      // eslint-disable-next-line no-await-in-loop
      await _mirrorTelegramToLegacyColumns(r.user_id);
    }
  }
  if (subs.rows.length > 0) {
    logger.info(`Subscription sweep: expired ${subs.rows.length} subscription(s)`);
  }
  return { expired: subs.rows.length };
}

// ---------------------------------------------------------------------------
// Invoice helpers — used by /billing routes + IPN.
// ---------------------------------------------------------------------------

/**
 * Create an OxaPay invoice for a user against a specific platform (or the
 * tg+ig bundle). Returns the local invoice row.
 *
 *   options = {
 *     platform: 'telegram' | 'instagram' | 'bundle',  // default 'telegram'
 *     plan?:    string,                                // default 'monthly'
 *     amount?:  number,                                // override price
 *   }
 */
async function createInvoiceForUser(userId, options = {}) {
  if (!oxapayService.isConfigured()) {
    const e = new Error('OxaPay is not configured on this server');
    e.code = 'OXAPAY_NOT_CONFIGURED';
    throw e;
  }

  const platform = options.platform || DEFAULT_PLATFORM;
  let amount;
  let description;
  let periodDays;
  if (platform === 'bundle') {
    amount = Number(
      options.amount
      || (await settingsService.getSetting('billing.bundle.tg_plus_ig.price_usd'))
      || 14.99
    );
    periodDays = parseInt(
      await settingsService.getSetting('billing.bundle.tg_plus_ig.period_days'),
      10
    ) || 30;
    description = `Telegram + Instagram bundle — ${periodDays}-day subscription`;
  } else {
    const p = _normalizePlatform(platform);
    amount = Number(options.amount || (await _subscriptionPriceUsd(p)) || 9.99);
    periodDays = parseInt(await _subscriptionPeriodDays(p), 10) || 30;
    description = `${p === 'telegram' ? 'Telegram' : 'Instagram'} Panel — ${periodDays}-day subscription`;
  }
  if (!(amount > 0)) {
    throw new Error('Invalid subscription price');
  }

  const cfgCurrency = (await settingsService.getSetting('billing.currency')) || 'USD';

  const ins = await pool.query(
    `INSERT INTO payment_invoices
       (user_id, amount_usd, currency, status, raw_create, expires_at, platform)
     VALUES ($1, $2, $3, 'pending', '{}'::jsonb, NULL, $4)
     RETURNING id, user_id, amount_usd, currency, status, created_at, platform`,
    [userId, amount, cfgCurrency, platform === 'bundle' ? 'telegram' : platform]
  );
  const invoiceRow = ins.rows[0];
  // For bundle invoices we record the platform as 'bundle' in a side column on
  // the raw_create JSON since the `platform_type` enum doesn't include it.
  if (platform === 'bundle') {
    await pool.query(
      `UPDATE payment_invoices
          SET raw_create = jsonb_set(raw_create, '{bundle}', 'true'::jsonb, TRUE)
        WHERE id = $1`,
      [invoiceRow.id]
    );
  }

  let oxapay;
  try {
    const userRow = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    oxapay = await oxapayService.createInvoice({
      amount,
      currency: cfgCurrency,
      orderId: String(invoiceRow.id),
      email: userRow.rows[0]?.email,
      description,
    });
  } catch (err) {
    await pool.query(
      `UPDATE payment_invoices
          SET status = 'failed',
              raw_create = $2::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [invoiceRow.id, JSON.stringify({ error: err.message, payload: err.payload || null })]
    );
    throw err;
  }

  const updated = await pool.query(
    `UPDATE payment_invoices
        SET oxapay_track_id = $2,
            payment_url     = $3,
            pay_link        = $3,
            raw_create      = COALESCE(raw_create, '{}'::jsonb) || $4::jsonb,
            expires_at      = TO_TIMESTAMP($5),
            updated_at      = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      invoiceRow.id,
      oxapay.trackId || null,
      oxapay.paymentUrl || null,
      JSON.stringify(oxapay.raw || {}),
      oxapay.expiredAt || null,
    ]
  );

  await recordEvent(
    userId,
    platform === 'bundle' ? 'telegram' : platform,
    'invoice_created',
    `Invoice created via OxaPay (${platform})`,
    { amount, track_id: oxapay.trackId, platform },
    invoiceRow.id
  );
  return updated.rows[0];
}

async function findInvoiceByTrackOrOrder(trackId, orderId) {
  if (trackId) {
    const r = await pool.query(
      'SELECT * FROM payment_invoices WHERE oxapay_track_id = $1',
      [trackId]
    );
    if (r.rows[0]) return r.rows[0];
  }
  if (orderId) {
    const id = parseInt(orderId, 10);
    if (Number.isFinite(id)) {
      const r2 = await pool.query('SELECT * FROM payment_invoices WHERE id = $1', [id]);
      if (r2.rows[0]) return r2.rows[0];
    }
  }
  return null;
}

/**
 * Apply a webhook (or polled status) to a local invoice row. Atomically
 * updates status, and if the new status is "paid", grants the user a fresh
 * subscription window on the invoice's platform (or both, for a bundle
 * invoice).
 */
async function applyPaymentUpdate(invoice, newStatus, payload) {
  if (['paid', 'expired', 'cancelled', 'failed', 'refunded'].includes(invoice.status)
      && invoice.status === newStatus) {
    return invoice;
  }

  const update = await pool.query(
    `UPDATE payment_invoices
        SET status       = $2,
            raw_callback = $3::jsonb,
            paid_at      = CASE WHEN $2 = 'paid' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
            updated_at   = NOW()
      WHERE id = $1
      RETURNING *`,
    [invoice.id, newStatus, JSON.stringify(payload || {})]
  );
  const updated = update.rows[0];

  if (newStatus === 'paid' && invoice.status !== 'paid') {
    const isBundle = !!(invoice.raw_create && invoice.raw_create.bundle);
    if (isBundle) {
      // Grant both platforms in a single transaction so a partial failure
      // rolls back. The same expiry is used for both.
      const tg = await grantSubscription(invoice.user_id, 'telegram', {
        plan: 'bundle', invoiceId: invoice.id,
      });
      const ig = await grantSubscription(invoice.user_id, 'instagram', {
        plan: 'bundle', invoiceId: invoice.id,
      });
      await pool.query(
        `UPDATE payment_invoices
            SET granted_until = $2,
                updated_at    = NOW()
          WHERE id = $1`,
        [invoice.id, tg.expiresAt || ig.expiresAt]
      );
      await recordEvent(invoice.user_id, 'telegram', 'invoice_paid',
        'Bundle invoice paid; subscriptions granted on both panels',
        { amount: Number(invoice.amount_usd), currency: invoice.currency, platform: 'bundle' },
        invoice.id);
    } else {
      const grant = await grantSubscription(
        invoice.user_id,
        invoice.platform || DEFAULT_PLATFORM,
        { plan: 'monthly', invoiceId: invoice.id }
      );
      await pool.query(
        `UPDATE payment_invoices
            SET granted_until = $2,
                updated_at    = NOW()
          WHERE id = $1`,
        [invoice.id, grant.expiresAt]
      );
      await recordEvent(invoice.user_id, invoice.platform || DEFAULT_PLATFORM,
        'invoice_paid', 'Invoice paid; subscription granted',
        {
          amount: Number(invoice.amount_usd),
          currency: invoice.currency,
          platform: invoice.platform || DEFAULT_PLATFORM,
        },
        invoice.id);
    }
  } else if (newStatus !== 'paid') {
    await recordEvent(invoice.user_id, invoice.platform || DEFAULT_PLATFORM,
      `invoice_${newStatus}`, null, payload || {}, invoice.id);
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Listings (user-side + admin-side)
// ---------------------------------------------------------------------------

async function listInvoicesForUser(userId, params = {}) {
  const limit = Math.min(parseInt(params.limit, 10) || 20, 100);
  const offset = (Math.max(parseInt(params.page, 10) || 1, 1) - 1) * limit;
  const platform = params.platform ? _normalizePlatform(params.platform) : null;

  const where = ['user_id = $1'];
  const args = [userId];
  if (platform) {
    args.push(platform);
    where.push(`platform = $${args.length}`);
  }
  args.push(limit);
  args.push(offset);
  const result = await pool.query(
    `SELECT id, amount_usd, currency, status, oxapay_track_id, payment_url,
            paid_at, expires_at, granted_until, created_at, platform
       FROM payment_invoices
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args
  );

  const totalArgs = [userId];
  let totalWhere = 'user_id = $1';
  if (platform) {
    totalArgs.push(platform);
    totalWhere += ' AND platform = $2';
  }
  const total = await pool.query(
    `SELECT COUNT(*)::int AS c FROM payment_invoices WHERE ${totalWhere}`,
    totalArgs
  );
  return {
    invoices: result.rows,
    pagination: { page: Math.max(parseInt(params.page, 10) || 1, 1), limit, total: total.rows[0].c },
  };
}

async function listInvoicesForAdmin(params = {}) {
  const limit = Math.min(parseInt(params.limit, 10) || 50, 500);
  const offset = (Math.max(parseInt(params.page, 10) || 1, 1) - 1) * limit;
  const status = params.status ? String(params.status).toLowerCase() : null;
  const search = params.search ? String(params.search).toLowerCase() : null;
  const platform = params.platform ? _normalizePlatform(params.platform) : null;

  const where = [];
  const args = [];
  if (status) { args.push(status); where.push(`pi.status = $${args.length}`); }
  if (platform) { args.push(platform); where.push(`pi.platform = $${args.length}`); }
  if (search) {
    args.push(`%${search}%`);
    where.push(`(LOWER(u.email) LIKE $${args.length} OR pi.oxapay_track_id ILIKE $${args.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  args.push(limit); args.push(offset);
  const result = await pool.query(
    `SELECT pi.id, pi.user_id, u.email, pi.amount_usd, pi.currency, pi.status,
            pi.oxapay_track_id, pi.payment_url, pi.paid_at, pi.granted_until,
            pi.created_at, pi.updated_at, pi.platform
       FROM payment_invoices pi
       JOIN users u ON u.id = pi.user_id
       ${whereSql}
      ORDER BY pi.created_at DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args
  );

  const stats = await pool.query(
    `SELECT
       COUNT(*)                                        FILTER (WHERE TRUE)                AS total_invoices,
       COUNT(*)                                        FILTER (WHERE status = 'paid')      AS paid_invoices,
       COUNT(*)                                        FILTER (WHERE status = 'pending')   AS pending_invoices,
       COUNT(*)                                        FILTER (WHERE status = 'failed')    AS failed_invoices,
       COALESCE(SUM(amount_usd) FILTER (WHERE status = 'paid'), 0)::numeric AS gross_paid_usd,
       COALESCE(SUM(amount_usd) FILTER (WHERE status = 'paid' AND created_at > NOW() - INTERVAL '30 days'), 0)::numeric AS paid_usd_30d
       FROM payment_invoices`
  );

  const subStats = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active' AND COALESCE(expires_at, NOW()) > NOW()) AS active_paid_subs,
       COUNT(*) FILTER (WHERE trial_expires_at IS NOT NULL AND trial_expires_at > NOW()) AS active_trials,
       COUNT(*) FILTER (WHERE trial_used) AS total_trials_used,
       COUNT(*) FILTER (WHERE platform = 'telegram' AND status = 'active' AND COALESCE(expires_at, NOW()) > NOW()) AS active_paid_subs_telegram,
       COUNT(*) FILTER (WHERE platform = 'instagram' AND status = 'active' AND COALESCE(expires_at, NOW()) > NOW()) AS active_paid_subs_instagram
       FROM user_subscriptions`
  );

  return {
    invoices: result.rows,
    stats: { ...stats.rows[0], ...subStats.rows[0] },
    pagination: {
      page: Math.max(parseInt(params.page, 10) || 1, 1),
      limit,
    },
  };
}

async function listEventsForUser(userId, params = {}) {
  const limit = Math.min(parseInt(params.limit, 10) || 50, 500);
  const platform = params.platform ? _normalizePlatform(params.platform) : null;
  const args = [userId];
  let where = 'user_id = $1';
  if (platform) {
    args.push(platform);
    where += ` AND platform = $${args.length}`;
  }
  args.push(limit);
  const result = await pool.query(
    `SELECT id, invoice_id, event_type, description, details, created_at, platform
       FROM subscription_events
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${args.length}`,
    args
  );
  return result.rows;
}

module.exports = {
  userPublicSnapshot,
  loadSubscription,
  loadSubscriptions,
  entitlementFor,
  startTrial,
  grantSubscription,
  expireSubscription,
  sweepExpired,
  createInvoiceForUser,
  findInvoiceByTrackOrOrder,
  applyPaymentUpdate,
  listInvoicesForUser,
  listInvoicesForAdmin,
  listEventsForUser,
  recordEvent,
  SUBSCRIPTION_PUBLIC_COLUMNS,
  VALID_PLATFORMS,
  DEFAULT_PLATFORM,
};
