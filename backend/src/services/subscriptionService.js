const { pool } = require('../config/database');
const logger = require('../utils/logger');
const oxapayService = require('./oxapayService');
const settingsService = require('./systemSettingsService');

/**
 * Subscription lifecycle helpers.
 *
 * We treat the existing `users.subscription_*` columns as the canonical
 * state for "is this user allowed to use the app right now?". This service
 * mutates them atomically and emits a row into `subscription_events` for
 * the audit trail.
 */

const SUBSCRIPTION_PUBLIC_COLUMNS = `
  id, email, role, status, is_approved,
  subscription_plan, subscription_status, subscription_expires_at,
  subscription_features,
  trial_started_at, trial_expires_at, trial_used,
  created_at, updated_at, last_login
`;

function userPublicSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    isApproved: row.is_approved,
    subscription: {
      plan: row.subscription_plan,
      status: row.subscription_status,
      expiresAt: row.subscription_expires_at,
      features: row.subscription_features || {},
    },
    trial: {
      startedAt: row.trial_started_at,
      expiresAt: row.trial_expires_at,
      used: !!row.trial_used,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLogin: row.last_login,
  };
}

async function recordEvent(userId, eventType, description, details, invoiceId) {
  await pool.query(
    `INSERT INTO subscription_events (user_id, invoice_id, event_type, description, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, invoiceId || null, eventType, description || null, JSON.stringify(details || {})]
  );
}

/**
 * Compute the effective "can the user access this feature right now?"
 * predicate. Admins bypass everything. Approved users with an active
 * non-expired subscription pass everything. Trial users pass only the
 * features whitelisted in `billing.trial_allowed_features`.
 *
 * Returns { allowed: boolean, reason: string, mode: "admin" | "subscription" | "trial" | "none" }.
 */
async function entitlementFor(userRow, feature) {
  if (!userRow) return { allowed: false, reason: 'not_authenticated', mode: 'none' };
  if (userRow.role === 'admin') {
    return { allowed: true, reason: 'admin', mode: 'admin' };
  }
  if (userRow.status === 'banned') {
    return { allowed: false, reason: 'banned', mode: 'none' };
  }
  if (!userRow.is_approved) {
    return { allowed: false, reason: 'not_approved', mode: 'none' };
  }

  const now = new Date();
  const subActive = userRow.subscription_status === 'active'
    && userRow.subscription_expires_at
    && new Date(userRow.subscription_expires_at) > now;
  if (subActive) {
    return { allowed: true, reason: 'subscription_active', mode: 'subscription' };
  }

  // Trial path. We allow it only when the feature (if specified) is in
  // the configured trial whitelist.
  const trialActive = userRow.trial_expires_at
    && new Date(userRow.trial_expires_at) > now;
  if (trialActive) {
    if (!feature) return { allowed: true, reason: 'trial_active', mode: 'trial' };
    const allowed = await settingsService.getSetting('billing.trial_allowed_features');
    const list = Array.isArray(allowed) ? allowed : [];
    if (list.includes(feature)) {
      return { allowed: true, reason: 'trial_active', mode: 'trial' };
    }
    return { allowed: false, reason: 'trial_feature_not_allowed', mode: 'trial' };
  }

  return { allowed: false, reason: 'subscription_required', mode: 'none' };
}

/**
 * Activate a free trial for a user. Idempotent against `trial_used` —
 * a user may only trial once. Returns the new public snapshot.
 */
async function startTrial(userId) {
  const existing = await pool.query(
    `SELECT ${SUBSCRIPTION_PUBLIC_COLUMNS} FROM users WHERE id = $1`,
    [userId]
  );
  const row = existing.rows[0];
  if (!row) throw new Error('user not found');
  if (row.trial_used) {
    const e = new Error('Trial already used');
    e.code = 'TRIAL_ALREADY_USED';
    throw e;
  }

  const trialEnabled = await settingsService.getSetting('billing.trial_enabled');
  if (!trialEnabled) {
    const e = new Error('Free trial is currently disabled by the administrator');
    e.code = 'TRIAL_DISABLED';
    throw e;
  }

  const minutes = parseInt(
    await settingsService.getSetting('billing.trial_duration_minutes'),
    10
  ) || 5;

  const updated = await pool.query(
    `UPDATE users
        SET trial_started_at = NOW(),
            trial_expires_at = NOW() + ($2 || ' minutes')::interval,
            trial_used       = TRUE,
            updated_at       = NOW()
      WHERE id = $1
      RETURNING ${SUBSCRIPTION_PUBLIC_COLUMNS}`,
    [userId, String(minutes)]
  );
  await recordEvent(userId, 'trial_started', `Trial started for ${minutes} minute(s)`, { minutes });
  logger.info('Trial started', { userId, minutes });
  return userPublicSnapshot(updated.rows[0]);
}

/**
 * Grant the user a paid subscription for `days` days (extends the
 * existing window if it's still in the future).
 */
async function grantSubscription(userId, opts = {}) {
  const days = parseInt(opts.days, 10) > 0
    ? parseInt(opts.days, 10)
    : (parseInt(await settingsService.getSetting('billing.subscription_period_days'), 10) || 30);
  const plan = opts.plan || 'monthly';

  // Extend from the later of (now, current expiry).
  const result = await pool.query(
    `UPDATE users
        SET subscription_status     = 'active',
            subscription_plan       = $2,
            subscription_expires_at =
              GREATEST(COALESCE(subscription_expires_at, NOW()), NOW())
              + ($3 || ' days')::interval,
            updated_at              = NOW()
      WHERE id = $1
      RETURNING ${SUBSCRIPTION_PUBLIC_COLUMNS}`,
    [userId, plan, String(days)]
  );
  const row = result.rows[0];
  await recordEvent(
    userId,
    'subscription_granted',
    `Subscription extended by ${days} day(s)`,
    { days, plan, expiresAt: row?.subscription_expires_at },
    opts.invoiceId
  );
  logger.info('Subscription granted', { userId, days, plan });
  return { snapshot: userPublicSnapshot(row), expiresAt: row?.subscription_expires_at };
}

/**
 * Force expire a user's subscription (admin override).
 */
async function expireSubscription(userId, reason) {
  const result = await pool.query(
    `UPDATE users
        SET subscription_status     = 'expired',
            subscription_expires_at = NOW(),
            updated_at              = NOW()
      WHERE id = $1
      RETURNING ${SUBSCRIPTION_PUBLIC_COLUMNS}`,
    [userId]
  );
  await recordEvent(userId, 'subscription_expired', reason || 'Manually expired', {});
  return userPublicSnapshot(result.rows[0]);
}

/**
 * Sweep: any active subscription whose expiry has passed → expired.
 * Any trial whose trial_expires_at has passed: just leave (the column
 * naturally falls out of the entitlement check, and we keep the audit).
 */
async function sweepExpired() {
  const subs = await pool.query(
    `UPDATE users
        SET subscription_status = 'expired',
            updated_at          = NOW()
      WHERE subscription_status = 'active'
        AND subscription_expires_at IS NOT NULL
        AND subscription_expires_at < NOW()
      RETURNING id`
  );
  for (const r of subs.rows) {
    await recordEvent(r.id, 'subscription_expired', 'Auto-expired by sweep', {});
  }
  if (subs.rows.length > 0) {
    logger.info(`Subscription sweep: expired ${subs.rows.length} user(s)`);
  }
  return { expired: subs.rows.length };
}

// ---------------------------------------------------------------------------
// Invoice helpers — used by /billing routes + IPN.
// ---------------------------------------------------------------------------

async function createInvoiceForUser(userId, options = {}) {
  if (!oxapayService.isConfigured()) {
    const e = new Error('OxaPay is not configured on this server');
    e.code = 'OXAPAY_NOT_CONFIGURED';
    throw e;
  }

  const cfg = await settingsService.getBillingConfig();
  const amount = Number(options.amount || cfg['billing.subscription_price_usd'] || 9.99);
  if (!(amount > 0)) {
    throw new Error('Invalid subscription price');
  }

  // Insert the local invoice row first so we can attach our local id as
  // the order_id sent to OxaPay. OxaPay echoes order_id back to us in
  // the webhook payload, which lets us short-circuit any track_id miss.
  const ins = await pool.query(
    `INSERT INTO payment_invoices
       (user_id, amount_usd, currency, status, raw_create, expires_at)
     VALUES ($1, $2, $3, 'pending', '{}'::jsonb, NULL)
     RETURNING id, user_id, amount_usd, currency, status, created_at`,
    [userId, amount, cfg['billing.currency'] || 'USD']
  );
  const invoiceRow = ins.rows[0];

  let oxapay;
  try {
    const userRow = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    oxapay = await oxapayService.createInvoice({
      amount,
      currency: cfg['billing.currency'] || 'USD',
      orderId: String(invoiceRow.id),
      email: userRow.rows[0]?.email,
      description: `Telegram Panel — ${cfg['billing.subscription_period_days'] || 30}-day subscription`,
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
            raw_create      = $4::jsonb,
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
  await recordEvent(userId, 'invoice_created', 'Invoice created via OxaPay', {
    amount,
    track_id: oxapay.trackId,
  }, invoiceRow.id);
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
 * Apply a webhook (or polled status) to a local invoice row.
 * Atomically updates status, and if the new status is "paid",
 * grants the user a fresh subscription window.
 */
async function applyPaymentUpdate(invoice, newStatus, payload) {
  // No-op if we already finalized this invoice — webhooks may retry.
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
    const grant = await grantSubscription(invoice.user_id, {
      plan: 'monthly',
      invoiceId: invoice.id,
    });
    await pool.query(
      `UPDATE payment_invoices
          SET granted_until = $2,
              updated_at    = NOW()
        WHERE id = $1`,
      [invoice.id, grant.expiresAt]
    );
    await recordEvent(invoice.user_id, 'invoice_paid', 'Invoice paid; subscription granted', {
      amount: Number(invoice.amount_usd),
      currency: invoice.currency,
    }, invoice.id);
  } else if (newStatus !== 'paid') {
    await recordEvent(invoice.user_id, `invoice_${newStatus}`, null, payload || {}, invoice.id);
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Listings (user-side + admin-side)
// ---------------------------------------------------------------------------

async function listInvoicesForUser(userId, params = {}) {
  const limit = Math.min(parseInt(params.limit, 10) || 20, 100);
  const offset = (Math.max(parseInt(params.page, 10) || 1, 1) - 1) * limit;
  const result = await pool.query(
    `SELECT id, amount_usd, currency, status, oxapay_track_id, payment_url,
            paid_at, expires_at, granted_until, created_at
       FROM payment_invoices
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  const total = await pool.query(
    'SELECT COUNT(*)::int AS c FROM payment_invoices WHERE user_id = $1',
    [userId]
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

  const where = [];
  const args = [];
  if (status) { args.push(status); where.push(`pi.status = $${args.length}`); }
  if (search) {
    args.push(`%${search}%`);
    where.push(`(LOWER(u.email) LIKE $${args.length} OR pi.oxapay_track_id ILIKE $${args.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  args.push(limit); args.push(offset);
  const result = await pool.query(
    `SELECT pi.id, pi.user_id, u.email, pi.amount_usd, pi.currency, pi.status,
            pi.oxapay_track_id, pi.payment_url, pi.paid_at, pi.granted_until,
            pi.created_at, pi.updated_at
       FROM payment_invoices pi
       JOIN users u ON u.id = pi.user_id
       ${whereSql}
      ORDER BY pi.created_at DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args
  );

  // Cumulative stats over all invoices (no filter) for the dashboard cards.
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
       COUNT(*) FILTER (WHERE subscription_status = 'active' AND COALESCE(subscription_expires_at, NOW()) > NOW()) AS active_paid_subs,
       COUNT(*) FILTER (WHERE trial_expires_at IS NOT NULL AND trial_expires_at > NOW()) AS active_trials,
       COUNT(*) FILTER (WHERE trial_used) AS total_trials_used
       FROM users
       WHERE role = 'user'`
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
  const result = await pool.query(
    `SELECT id, invoice_id, event_type, description, details, created_at
       FROM subscription_events
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

module.exports = {
  userPublicSnapshot,
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
};
