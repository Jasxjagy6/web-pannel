const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Tiny HTTPS client wrapper around OxaPay's v1 REST API.
 *
 * OxaPay docs: https://docs.oxapay.com/api-reference
 *
 * Auth: every request carries a `merchant_api_key` header.
 * Webhooks: OxaPay POSTs to our callback_url with an `HMAC` header
 * containing `sha512(rawBody, merchantApiKey)` we MUST verify.
 *
 * Required env:
 *   OXAPAY_MERCHANT_API_KEY  - the merchant API key from the OxaPay dashboard
 *   OXAPAY_CALLBACK_URL      - public URL where OxaPay posts payment updates
 *   OXAPAY_RETURN_URL        - URL the user is redirected to after paying
 *   OXAPAY_SANDBOX           - "true" to send sandbox=true on every invoice
 *   OXAPAY_INVOICE_LIFETIME_MIN - optional override (default 60, min 15, max 2880)
 */

const OXAPAY_BASE_URL = process.env.OXAPAY_BASE_URL || 'https://api.oxapay.com/v1';

function getApiKey() {
  const key = process.env.OXAPAY_MERCHANT_API_KEY;
  if (!key) {
    const e = new Error('OxaPay is not configured (set OXAPAY_MERCHANT_API_KEY)');
    e.code = 'OXAPAY_NOT_CONFIGURED';
    throw e;
  }
  return key;
}

function isConfigured() {
  return Boolean(process.env.OXAPAY_MERCHANT_API_KEY);
}

async function request(method, pathname, body) {
  const url = `${OXAPAY_BASE_URL}${pathname}`;
  const init = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'merchant_api_key': getApiKey(),
    },
  };
  if (body && method !== 'GET') {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`OxaPay returned non-JSON response: ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const msg = json?.error?.message || json?.message || `OxaPay ${method} ${pathname} failed (${res.status})`;
    const e = new Error(msg);
    e.status = res.status;
    e.payload = json;
    throw e;
  }
  // The v1 API also embeds an `error` object on logical failures even when
  // the HTTP layer says 200. Surface those as exceptions too.
  if (json?.error && Object.keys(json.error || {}).length > 0) {
    const e = new Error(json.error.message || 'OxaPay error');
    e.status = res.status;
    e.payload = json;
    throw e;
  }
  return json;
}

/**
 * Create a new payment invoice for `amount` USD. Returns the OxaPay
 * `track_id` and the `payment_url` the customer should be redirected to.
 *
 * @param {object} opts
 * @param {number} opts.amount         USD amount, e.g. 9.99
 * @param {string} opts.orderId        local order ID (we use our payment_invoices.id)
 * @param {string} [opts.email]        customer email (optional, for OxaPay reports)
 * @param {string} [opts.description]  free-form description
 * @param {string} [opts.callbackUrl]  override default callback
 * @param {string} [opts.returnUrl]    override default return URL
 * @param {number} [opts.lifetimeMin]  override invoice lifetime (15..2880)
 */
async function createInvoice(opts) {
  const lifetime = Math.max(
    15,
    Math.min(
      2880,
      parseInt(opts.lifetimeMin || process.env.OXAPAY_INVOICE_LIFETIME_MIN || '60', 10) || 60
    )
  );
  const body = {
    amount: Number(opts.amount),
    currency: opts.currency || 'USD',
    lifetime,
    callback_url: opts.callbackUrl || process.env.OXAPAY_CALLBACK_URL,
    return_url: opts.returnUrl || process.env.OXAPAY_RETURN_URL,
    order_id: String(opts.orderId),
    description: opts.description || 'Subscription payment',
  };
  if (opts.email) body.email = opts.email;
  if (process.env.OXAPAY_SANDBOX && /^(1|true|yes)$/i.test(process.env.OXAPAY_SANDBOX)) {
    body.sandbox = true;
  }

  logger.info('OxaPay createInvoice', { orderId: body.order_id, amount: body.amount });
  const json = await request('POST', '/payment/invoice', body);
  return {
    trackId: json?.data?.track_id,
    paymentUrl: json?.data?.payment_url,
    expiredAt: json?.data?.expired_at, // unix
    raw: json,
  };
}

/**
 * Look up the current state of an invoice by its OxaPay track id.
 * Used by our IPN handler as a defense-in-depth check (we only trust
 * the webhook *after* re-fetching the canonical state).
 */
async function getPayment(trackId) {
  const json = await request('GET', `/payment/${encodeURIComponent(trackId)}`);
  return {
    status: json?.data?.status,         // e.g. "Paid", "Confirming", "Expired", ...
    amount: json?.data?.amount,
    payAmount: json?.data?.pay_amount,
    currency: json?.data?.currency,
    payCurrency: json?.data?.pay_currency,
    payDate: json?.data?.pay_date,
    raw: json,
  };
}

/**
 * Verify the HMAC header that OxaPay attaches to every webhook.
 * It's `sha512(rawBody, merchantApiKey)` in lowercase hex.
 *
 * `rawBody` MUST be the unparsed request body bytes — Express's
 * `express.json()` parser destroys this, so the route mounts a raw
 * body parser specifically for the webhook.
 */
function verifyWebhookSignature(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const key = getApiKey();
  const expected = crypto
    .createHmac('sha512', key)
    .update(typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody))
    .digest('hex');
  // Constant-time compare to avoid timing attacks.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(hmacHeader).toLowerCase(), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Map OxaPay's webhook status string to one of our payment_invoices.status
 * enum values. OxaPay uses several strings depending on flow:
 *   "Paid"        - fully paid + confirmed
 *   "Confirming"  - on-chain confirmations pending; treat as pending
 *   "Expired"     - lifetime elapsed, no payment
 *   "Failed"      - explicit failure
 *   "Cancelled"   - cancelled by user / merchant
 *   "Underpaid"   - paid less than required (treat as failed for our purposes)
 *   "Refunded"    - refunded post-payment
 */
function normalizeStatus(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'paid') return 'paid';
  if (v === 'expired') return 'expired';
  if (v === 'cancelled' || v === 'canceled') return 'cancelled';
  if (v === 'failed' || v === 'underpaid') return 'failed';
  if (v === 'refunded') return 'refunded';
  return 'pending';
}

module.exports = {
  isConfigured,
  createInvoice,
  getPayment,
  verifyWebhookSignature,
  normalizeStatus,
};
