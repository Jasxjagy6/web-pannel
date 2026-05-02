const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');
const settingsService = require('../services/systemSettingsService');
const subscriptionService = require('../services/subscriptionService');
const oxapayService = require('../services/oxapayService');

const VALID_PLATFORMS = ['telegram', 'instagram'];
const VALID_BUNDLES = ['none', 'bundle']; // 'bundle' = bundle (TG + IG combined plan)

/**
 * Pick the platform from the request — preference order:
 *   - explicit ?platform=telegram|instagram in body / query
 *   - req.platform set by parsePlatform middleware (URL prefix
 *     /api/<platform>/* or X-Platform header)
 *   - 'telegram' for legacy callers (always available + matches the
 *     historic single-platform behaviour).
 */
function _resolvePlatform(req) {
  const candidate =
    req.body?.platform ||
    req.query?.platform ||
    req.platform ||
    'telegram';
  if (!VALID_PLATFORMS.includes(candidate)) return 'telegram';
  return candidate;
}

function _resolveBundle(req) {
  const b = req.body?.bundle || req.query?.bundle || 'none';
  if (!VALID_BUNDLES.includes(b)) return 'none';
  return b;
}

const billingController = {
  /**
   * GET /api/<platform>/billing/config (or /api/billing/config legacy)
   * Public-ish (must be authed but not necessarily approved/subscribed):
   * the user landing page calls this to render the subscribe / trial buttons.
   *
   * Now reads per-platform pricing keys (e.g.
   *   billing.telegram.subscription_price_usd
   *   billing.instagram.subscription_price_usd
   *   billing.bundle.subscription_price_usd
   * ) and falls back to the global billing.subscription_price_usd for
   * platforms that don't have an override yet.
   */
  getConfig: asyncHandler(async (req, res) => {
    const platform = _resolvePlatform(req);
    const cfg = await settingsService.getBillingConfig();
    const get = (k, fallback) => {
      const perPlatform = cfg[`billing.${platform}.${k}`];
      if (perPlatform !== undefined && perPlatform !== null && perPlatform !== '') {
        return perPlatform;
      }
      return cfg[`billing.${k}`] !== undefined ? cfg[`billing.${k}`] : fallback;
    };
    res.json({
      success: true,
      data: {
        platform,
        priceUsd: Number(get('subscription_price_usd', 9.99)),
        periodDays: Number(get('subscription_period_days', 30)),
        currency: get('currency', 'USD'),
        bundle: {
          enabled: cfg['billing.bundle.enabled'] !== false,
          priceUsd: Number(cfg['billing.bundle.subscription_price_usd'] || 14.99),
          periodDays: Number(cfg['billing.bundle.subscription_period_days'] || 30),
        },
        trial: {
          enabled: !!get('trial_enabled', cfg['billing.trial_enabled']),
          durationMinutes: Number(get('trial_duration_minutes', cfg['billing.trial_duration_minutes'] || 5)),
          allowedFeatures: Array.isArray(get('trial_allowed_features', cfg['billing.trial_allowed_features']))
            ? get('trial_allowed_features', cfg['billing.trial_allowed_features'])
            : [],
        },
        oxapayConfigured: oxapayService.isConfigured(),
      },
    });
  }),

  /**
   * GET /api/billing/status
   * Returns the user's effective entitlement state — the frontend uses
   * this to pick between "show app", "show subscribe page", or "trial
   * timer".
   */
  getStatus: asyncHandler(async (req, res) => {
    const r = await pool.query(
      `SELECT ${subscriptionService.SUBSCRIPTION_PUBLIC_COLUMNS}
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    const row = r.rows[0];
    const ent = await subscriptionService.entitlementFor(row);
    res.json({
      success: true,
      data: {
        user: subscriptionService.userPublicSnapshot(row),
        entitlement: ent,
        config: await settingsService.getBillingConfig(),
      },
    });
  }),

  /**
   * POST /api/billing/trial/start
   * Activate the (one-time) free trial.
   */
  startTrial: asyncHandler(async (req, res) => {
    if (!req.user.isApproved) {
      throw new AppError('Your account is not yet approved', 403, 'NOT_APPROVED');
    }
    const platform = _resolvePlatform(req);
    let snap;
    try {
      snap = await subscriptionService.startTrial(req.user.id, platform);
    } catch (err) {
      if (err.code === 'TRIAL_ALREADY_USED') {
        throw new AppError(err.message, 400, 'TRIAL_ALREADY_USED');
      }
      if (err.code === 'TRIAL_DISABLED') {
        throw new AppError(err.message, 400, 'TRIAL_DISABLED');
      }
      throw err;
    }
    res.json({ success: true, data: { ...snap, platform } });
  }),

  /**
   * POST /api/billing/checkout
   * Create a brand-new OxaPay invoice for this user. Returns the
   * `payment_url` the frontend should redirect to (or render in an
   * iframe / popup).
   */
  createCheckout: asyncHandler(async (req, res) => {
    if (!req.user.isApproved) {
      throw new AppError('Your account is not yet approved', 403, 'NOT_APPROVED');
    }
    if (!oxapayService.isConfigured()) {
      throw new AppError(
        'Payments are temporarily unavailable: OxaPay is not configured.',
        503,
        'OXAPAY_NOT_CONFIGURED'
      );
    }
    const platform = _resolvePlatform(req);
    const bundle = _resolveBundle(req);
    let invoice;
    try {
      invoice = await subscriptionService.createInvoiceForUser(req.user.id, {
        platform,
        bundle,
      });
    } catch (err) {
      if (err.code === 'OXAPAY_NOT_CONFIGURED') {
        throw new AppError(err.message, 503, 'OXAPAY_NOT_CONFIGURED');
      }
      logger.error('createCheckout failed', { err: err.message, platform, bundle });
      throw new AppError(err.message || 'Could not create invoice', 502, 'OXAPAY_ERROR');
    }
    res.json({
      success: true,
      data: {
        invoice: {
          id: invoice.id,
          platform: invoice.platform || platform,
          bundle: invoice.bundle || bundle,
          trackId: invoice.oxapay_track_id,
          paymentUrl: invoice.payment_url,
          amountUsd: Number(invoice.amount_usd),
          currency: invoice.currency,
          expiresAt: invoice.expires_at,
        },
      },
    });
  }),

  /**
   * GET /api/billing/invoices
   * The user's own invoice history — used by the "Recent payments"
   * widget on the Billing page.
   */
  listMyInvoices: asyncHandler(async (req, res) => {
    const data = await subscriptionService.listInvoicesForUser(req.user.id, req.query);
    res.json({ success: true, data });
  }),

  /**
   * GET /api/billing/events
   * The user's own subscription event log (trials, grants, expiries).
   */
  listMyEvents: asyncHandler(async (req, res) => {
    const events = await subscriptionService.listEventsForUser(req.user.id, req.query);
    res.json({ success: true, data: { events } });
  }),

  /**
   * POST /api/billing/invoices/:id/refresh
   * Defense-in-depth: poll OxaPay for the canonical state and apply it.
   * The user can press "I paid" to force the refresh from the UI.
   */
  refreshInvoice: asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query(
      `SELECT * FROM payment_invoices WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    const inv = r.rows[0];
    if (!inv) throw new AppError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
    if (!inv.oxapay_track_id) {
      return res.json({ success: true, data: { invoice: inv, refreshed: false } });
    }

    let live;
    try {
      live = await oxapayService.getPayment(inv.oxapay_track_id);
    } catch (err) {
      logger.warn('refreshInvoice oxapay error', { err: err.message });
      return res.json({ success: true, data: { invoice: inv, refreshed: false, error: err.message } });
    }
    const normalized = oxapayService.normalizeStatus(live.status);
    const updated = await subscriptionService.applyPaymentUpdate(inv, normalized, live.raw);
    res.json({ success: true, data: { invoice: updated, refreshed: true } });
  }),

  /**
   * POST /api/billing/oxapay/ipn
   * Webhook receiver for OxaPay. Auth: HMAC header verified against
   * raw body. Mounted with `express.raw()` so we can re-hash the
   * untouched payload before parsing it.
   */
  oxapayIpn: asyncHandler(async (req, res) => {
    const rawBody = req.body; // Buffer when express.raw() is in use
    const hmac = req.headers['hmac'] || req.headers['HMAC'];
    if (!oxapayService.verifyWebhookSignature(rawBody, hmac)) {
      logger.warn('OxaPay IPN: bad HMAC');
      return res.status(400).json({ success: false, error: { code: 'BAD_HMAC' } });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ success: false, error: { code: 'BAD_JSON' } });
    }

    // OxaPay nests the actual transaction under `data` for v1; older
    // installs send it flat. Try both.
    const data = payload.data || payload;
    const trackId = data.track_id || data.trackId;
    const orderId = data.order_id || data.orderId;
    const status = data.status;

    const inv = await subscriptionService.findInvoiceByTrackOrOrder(trackId, orderId);
    if (!inv) {
      logger.warn('OxaPay IPN: invoice not found', { trackId, orderId });
      return res.json({ success: true, data: { matched: false } });
    }

    // Defense in depth: re-fetch live state from OxaPay before granting.
    let normalized;
    try {
      const live = await oxapayService.getPayment(trackId);
      normalized = oxapayService.normalizeStatus(live.status || status);
    } catch {
      normalized = oxapayService.normalizeStatus(status);
    }

    await subscriptionService.applyPaymentUpdate(inv, normalized, payload);
    res.json({ success: true, data: { matched: true, status: normalized } });
  }),

  // -------------------------------------------------------------------
  // Admin endpoints (mounted under /api/admin/billing/*)
  // -------------------------------------------------------------------

  adminGetSettings: asyncHandler(async (_req, res) => {
    const cfg = await settingsService.getBillingConfig();
    res.json({ success: true, data: cfg });
  }),

  adminSetSettings: asyncHandler(async (req, res) => {
    const platforms = ['telegram', 'instagram', 'bundle'];
    const baseKeys = [
      'billing.subscription_price_usd',
      'billing.subscription_period_days',
      'billing.currency',
      'billing.trial_enabled',
      'billing.trial_duration_minutes',
      'billing.trial_allowed_features',
    ];
    const allowedKeys = [
      ...baseKeys,
      // Per-platform overrides
      ...platforms.flatMap((p) => baseKeys.map((k) => k.replace('billing.', `billing.${p}.`))),
      // Bundle-specific
      'billing.bundle.enabled',
    ];
    const patch = {};
    for (const k of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) {
        patch[k] = req.body[k];
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new AppError('No settings to update', 400, 'BAD_REQUEST');
    }

    // Validation.
    if (patch['billing.subscription_price_usd'] !== undefined) {
      const p = Number(patch['billing.subscription_price_usd']);
      if (!Number.isFinite(p) || p < 0) {
        throw new AppError('subscription_price_usd must be a non-negative number', 400, 'BAD_REQUEST');
      }
      patch['billing.subscription_price_usd'] = Number(p.toFixed(2));
    }
    if (patch['billing.subscription_period_days'] !== undefined) {
      const d = parseInt(patch['billing.subscription_period_days'], 10);
      if (!Number.isFinite(d) || d <= 0) {
        throw new AppError('subscription_period_days must be a positive integer', 400, 'BAD_REQUEST');
      }
      patch['billing.subscription_period_days'] = d;
    }
    if (patch['billing.trial_duration_minutes'] !== undefined) {
      const m = parseInt(patch['billing.trial_duration_minutes'], 10);
      if (!Number.isFinite(m) || m <= 0) {
        throw new AppError('trial_duration_minutes must be a positive integer', 400, 'BAD_REQUEST');
      }
      patch['billing.trial_duration_minutes'] = m;
    }
    if (patch['billing.trial_enabled'] !== undefined) {
      patch['billing.trial_enabled'] = !!patch['billing.trial_enabled'];
    }
    if (patch['billing.trial_allowed_features'] !== undefined) {
      const arr = patch['billing.trial_allowed_features'];
      if (!Array.isArray(arr)) {
        throw new AppError('trial_allowed_features must be an array of strings', 400, 'BAD_REQUEST');
      }
      patch['billing.trial_allowed_features'] = arr.map((s) => String(s));
    }
    if (patch['billing.currency'] !== undefined) {
      patch['billing.currency'] = String(patch['billing.currency']).toUpperCase();
    }

    const updated = await settingsService.setSettings(patch, req.user.id);
    res.json({ success: true, data: updated });
  }),

  adminListInvoices: asyncHandler(async (req, res) => {
    const data = await subscriptionService.listInvoicesForAdmin(req.query);
    res.json({ success: true, data });
  }),

  adminGetUserInvoices: asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      throw new AppError('Invalid user id', 400, 'BAD_REQUEST');
    }
    const data = await subscriptionService.listInvoicesForUser(userId, req.query);
    const events = await subscriptionService.listEventsForUser(userId, { limit: 50 });
    res.json({ success: true, data: { ...data, events } });
  }),

  adminGrantSubscription: asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const days = parseInt(req.body.days, 10);
    if (!Number.isFinite(userId) || !Number.isFinite(days) || days <= 0) {
      throw new AppError('userId and days are required', 400, 'BAD_REQUEST');
    }
    const out = await subscriptionService.grantSubscription(userId, {
      days,
      plan: req.body.plan || 'manual',
    });
    res.json({ success: true, data: out.snapshot });
  }),

  adminExpireSubscription: asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) throw new AppError('Invalid user id', 400, 'BAD_REQUEST');
    const snap = await subscriptionService.expireSubscription(userId, req.body.reason || 'admin override');
    res.json({ success: true, data: snap });
  }),
};

module.exports = billingController;
