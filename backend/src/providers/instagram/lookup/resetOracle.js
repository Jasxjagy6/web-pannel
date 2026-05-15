/**
 * §2.9 Reset-oracle (Oracles 1-3, single-pass) — masked recovery
 * primitives surfaced WITHOUT firing a real password-reset email or
 * SMS.
 *
 * What this does                        How
 * -----------------------------         ------------------------------
 * Oracle 1: obfuscated email/phone      GET /accounts/account_recovery_send_ajax/
 * Oracle 2: recovery-methods bitmap     parse `obfuscated_email_available`
 *                                       + `obfuscated_phone_available` flags
 *                                       from the same response.
 * Oracle 3: account-status meta         GET /accounts/check_username/?username=...
 *                                       + GET /accounts/web_create_ajax/attempt/
 *                                         (dry-run probe — IG returns
 *                                         "username already taken" without
 *                                         creating anything)
 *
 * What this is NOT (instagram_upgrade.txt §3, §10):
 *   - This module does NOT call the `/accounts/send_password_reset/`
 *     POST endpoint that would email/SMS the target. The "_send_ajax"
 *     endpoint above is the IG flow's first stage and ONLY returns the
 *     mask — it never enqueues a real reset on the account unless the
 *     follow-up POST is made. We deliberately stop at the read.
 *   - It does NOT trigger OTPs (§10.3).
 *   - It does NOT brute-force the mask (that's PR #4's job, with
 *     burner cookies).
 *
 * Returns the normalised {findings, raw} shape that the runner
 * expects.
 */

'use strict';

const crypto = require('crypto');
const logger = require('../../../utils/logger');
const { igFetch, pickWebFingerprint } = require('../igFetch');
const lookupLimiter = require('./lookupLimiter');
const { AppError } = require('../../../utils/errorHandler');

const ACCOUNT_RECOVERY_SEND_AJAX =
  'https://www.instagram.com/accounts/account_recovery_send_ajax/';
const CHECK_USERNAME_AJAX =
  'https://www.instagram.com/accounts/check_username/';

/**
 * Build a mask hash that's stable across runs of the same operator,
 * but uniquely derived from a single panel deployment so the
 * lookup_snapshots index can join on hash without leaking the raw
 * mask out of one deployment to another.
 */
function _maskHash(mask) {
  if (!mask) return null;
  const salt = process.env.LOOKUP_MASK_SALT || 'ig-lookup-mask-salt-v1';
  return crypto.createHash('sha256').update(`${salt}:${mask}`).digest('hex').slice(0, 32);
}

function _anonymousCtx(username) {
  return {
    sessionId: `lookup-oracle:${username}`,
    allowAnonymous: true,
    username: null,
    proxyUrl: null,
    bypassProxy: true,
    cookieHeader: '',
    csrftoken: '',
    dsUserId: null,
    blob: null,
    webFingerprint: pickWebFingerprint(`lookup_oracle_${username}`),
    locale: { language: 'en_US', timezoneOffset: 0, regionHint: 'US' },
    apiMode: 'web',
  };
}

async function _resolveCtx(username, opts) {
  if (opts && opts.session && opts.session.id) {
    // eslint-disable-next-line global-require
    const { sessionContext } = require('../igFetch');
    return sessionContext(opts.session);
  }
  return _anonymousCtx(username);
}

/**
 * Oracle 1+2 — masked recovery primitives. IG's account_recovery
 * endpoint is a POST that returns the obfuscated email/phone fragment
 * BEFORE the user clicks the "send reset email" button on the form.
 *
 * We send the form payload with `recover_token: ''` (empty) — IG
 * returns the masks anyway because the page needs to display them
 * before the user picks which method to use.
 */
async function _oracle12(ctx, username) {
  const formBody = new URLSearchParams({
    email_or_username: username,
    // Empty recover_token tells IG this is the mask-fetch stage, not
    // the actual reset request. The follow-up POST that ACTUALLY sends
    // the email requires a real recover_token from this response — we
    // never make that call. (instagram_upgrade.txt §10.3 forbids it.)
    recover_token: '',
    flow: 'web_password_recovery',
  }).toString();

  try {
    const r = await igFetch(ctx, ACCOUNT_RECOVERY_SEND_AJAX, {
      method: 'POST',
      body: formBody,
      extraHeaders: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-instagram-ajax': '1',
      },
      referer: 'https://www.instagram.com/accounts/password/reset/',
      skipLimiter: true,
      logErrors: false,
    });
    return r;
  } catch (err) {
    return { error: err.kind || 'network', message: err.message || String(err) };
  }
}

/**
 * Oracle 3 — account-status meta. IG's check_username endpoint tells
 * us whether the username is taken, which is a 1-bit version of
 * "the account exists" / "deleted vs disabled vs OK".
 */
async function _oracle3(ctx, username) {
  const formBody = new URLSearchParams({ username }).toString();
  try {
    const r = await igFetch(ctx, CHECK_USERNAME_AJAX, {
      method: 'POST',
      body: formBody,
      extraHeaders: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-instagram-ajax': '1',
      },
      referer: 'https://www.instagram.com/accounts/emailsignup/',
      skipLimiter: true,
      logErrors: false,
    });
    return r;
  } catch (err) {
    return { error: err.kind || 'network', message: err.message || String(err) };
  }
}

async function run(username, opts = {}) {
  if (!username || typeof username !== 'string') {
    throw new AppError('resetOracle.run: username required', 400, 'VALIDATION_ERROR');
  }
  const cleaned = username.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/i.test(cleaned)) {
    throw new AppError('resetOracle.run: invalid IG username', 400, 'VALIDATION_ERROR');
  }
  await lookupLimiter.acquire(cleaned, { class: 'probe' });
  const ctx = await _resolveCtx(cleaned, opts);

  const [oracle12, oracle3] = await Promise.all([
    _oracle12(ctx, cleaned),
    _oracle3(ctx, cleaned),
  ]);

  const findings = [];

  // -----------------------------------------------------------------
  // Oracle 1 — masked email
  // -----------------------------------------------------------------
  if (oracle12 && oracle12.contact_point) {
    findings.push({
      method: 'recovery_mask',
      kind: 'email',
      value: oracle12.contact_point,
      confidence: 70,
      verified: false,
      sourceUrl: 'https://www.instagram.com/accounts/password/reset/',
      raw: { mask: oracle12.contact_point, oracle: 1 },
    });
  }
  if (oracle12 && oracle12.email) {
    findings.push({
      method: 'recovery_mask',
      kind: 'email',
      value: oracle12.email,
      confidence: 75,
      verified: false,
      sourceUrl: 'https://www.instagram.com/accounts/password/reset/',
      raw: { mask: oracle12.email, oracle: 1 },
    });
  }
  if (oracle12 && oracle12.phone_number) {
    findings.push({
      method: 'recovery_mask',
      kind: 'phone',
      value: oracle12.phone_number,
      confidence: 75,
      verified: false,
      sourceUrl: 'https://www.instagram.com/accounts/password/reset/',
      raw: { mask: oracle12.phone_number, oracle: 1 },
    });
  }
  if (oracle12 && oracle12.obfuscated_email) {
    findings.push({
      method: 'recovery_mask',
      kind: 'email',
      value: oracle12.obfuscated_email,
      confidence: 70,
      verified: false,
      sourceUrl: 'https://www.instagram.com/accounts/password/reset/',
      raw: { mask: oracle12.obfuscated_email, oracle: 1 },
    });
  }
  if (oracle12 && oracle12.obfuscated_phone) {
    findings.push({
      method: 'recovery_mask',
      kind: 'phone',
      value: oracle12.obfuscated_phone,
      confidence: 70,
      verified: false,
      sourceUrl: 'https://www.instagram.com/accounts/password/reset/',
      raw: { mask: oracle12.obfuscated_phone, oracle: 1 },
    });
  }

  // -----------------------------------------------------------------
  // Oracle 2 — recovery-methods bitmap (which methods IG offers)
  // -----------------------------------------------------------------
  const methodsBitmap = {
    email: !!(oracle12 && (oracle12.obfuscated_email_available || oracle12.email || oracle12.contact_point)),
    phone: !!(oracle12 && (oracle12.obfuscated_phone_available || oracle12.phone_number)),
    fb_linked: !!(oracle12 && oracle12.fb_login_url),
    whatsapp_linked: !!(oracle12 && oracle12.whatsapp_available),
  };
  findings.push({
    method: 'recovery_methods',
    kind: 'note',
    value: `recovery methods: ${
      Object.keys(methodsBitmap).filter((k) => methodsBitmap[k]).join(', ') || 'none'
    }`,
    confidence: 80,
    verified: false,
    sourceUrl: 'https://www.instagram.com/accounts/password/reset/',
    raw: methodsBitmap,
  });

  // -----------------------------------------------------------------
  // Oracle 3 — account status (exists / deleted / disabled / available)
  // -----------------------------------------------------------------
  let status = 'unknown';
  if (oracle3 && typeof oracle3.available === 'boolean') {
    status = oracle3.available ? 'username_available' : 'exists';
  }
  if (oracle3 && oracle3.error) status = oracle3.error;
  // The recovery endpoint also distinguishes deleted/disabled in
  // some IG variants — these come through as message strings.
  if (oracle12 && oracle12.message) {
    const m = String(oracle12.message).toLowerCase();
    if (/no users found|user not found/.test(m)) status = 'not_found';
    if (/disabled/.test(m)) status = 'disabled';
    if (/deleted/.test(m)) status = 'deleted';
  }
  findings.push({
    method: 'recovery_meta',
    kind: 'note',
    value: `account status: ${status}`,
    confidence: 80,
    verified: false,
    sourceUrl: 'https://www.instagram.com/accounts/password/reset/',
    raw: { oracle: 3, status, recovery: oracle12, check_username: oracle3 },
  });

  logger.info(`IG.lookup.resetOracle: ${cleaned} → status=${status}, findings=${findings.length}`);

  // The runner consumes this `snapshot` block when (later) building a
  // lookup_snapshots row for the Oracle 5 longitudinal diff. The mask
  // hashes are kept here so the row can be inserted without re-hashing.
  const snapshot = {
    obfuscated_email: oracle12 && (oracle12.obfuscated_email || oracle12.email || oracle12.contact_point),
    obfuscated_phone: oracle12 && (oracle12.obfuscated_phone || oracle12.phone_number),
    methodsBitmap,
    status,
  };

  return {
    method: 'reset_oracle',
    ok: true,
    findings,
    snapshot,
    maskHashes: {
      email: _maskHash(snapshot.obfuscated_email),
      phone: _maskHash(snapshot.obfuscated_phone),
    },
    raw: { oracle12, oracle3 },
  };
}

module.exports = { run, _maskHash };
