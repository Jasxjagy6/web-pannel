/**
 * Candidate generator — turn an obfuscated reset-flow mask into a
 * finite ranked list of candidate full values that PR #4's enumeration
 * stage will validate against Instagram's existence-probe endpoint.
 *
 * Email mask shape (IG reset flow):
 *   "t****a@gmail.com"  → first char + N stars + last char + "@" + domain.
 *   Sometimes the domain is also partially masked: "j*o@g****.com".
 *
 * Phone mask shape (IG reset flow):
 *   "+## *****47"       → country prefix + masked middle + last 2 digits.
 *
 * This module is PURE — it never touches the network. It is consumed
 * by:
 *   - PR #1 candidates persisted as `lookup_findings` of kind=note
 *     (informational, "we know enough about the email to narrow to N
 *     candidates without enumeration").
 *   - PR #4 emailEnumerator/phoneEnumerator that POST each candidate
 *     to `accounts/web_create_ajax` via a burner cookie.
 *
 * Returns objects with explicit `confidence` so downstream callers can
 * gate which candidates are cheap-enough-to-probe.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const _domainList = (() => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'domainDictionary.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.domains) ? parsed.domains : [];
  } catch (_err) {
    return ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'];
  }
})();

const _carriers = (() => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'carrierPrefixes.json'), 'utf8');
    return JSON.parse(raw);
  } catch (_err) {
    return { countries: {} };
  }
})();

const MAX_EMAIL_CANDIDATES = 400;
const MAX_PHONE_CANDIDATES = 800;

function _starCount(masked) {
  if (!masked) return 0;
  return (masked.match(/[*•·]/g) || []).length;
}

/**
 * Normalise a reset-flow mask to the shape "{first}***{last}@{domain}".
 * Returns null if the input doesn't look like an email mask.
 */
function normaliseEmailMask(masked) {
  if (!masked || typeof masked !== 'string') return null;
  const m = masked.trim().toLowerCase();
  // Replace unicode bullets with ASCII stars before splitting.
  const norm = m.replace(/[•·]/g, '*');
  const at = norm.indexOf('@');
  if (at < 2 || at >= norm.length - 4) return null;
  const local = norm.slice(0, at);
  const domain = norm.slice(at + 1);
  // Need at least one revealed char on the local-part for a useful mask.
  const revealed = local.replace(/\*/g, '');
  if (!revealed) return null;
  return {
    local,
    domain,
    firstChar: local[0] !== '*' ? local[0] : null,
    lastChar: local[local.length - 1] !== '*' ? local[local.length - 1] : null,
    starCount: _starCount(local),
    localLen: local.length,
    domainMasked: domain.includes('*'),
  };
}

/**
 * Normalise a phone mask. Returns the country-code, revealed last digits,
 * and the position info needed to enumerate candidates.
 */
function normalisePhoneMask(masked) {
  if (!masked || typeof masked !== 'string') return null;
  // Strip whitespace, replace bullets/dashes with stars.
  const m = masked.replace(/[•·\-\s]/g, '');
  if (!m.startsWith('+')) return null;
  // Find the run of digits at the very start of the string (country code).
  const ccMatch = m.match(/^\+(\d{1,3})/);
  if (!ccMatch) return null;
  const cc = ccMatch[1];
  const tail = m.slice(1 + cc.length);
  const lastDigitsMatch = tail.match(/(\d+)$/);
  const lastDigits = lastDigitsMatch ? lastDigitsMatch[1] : '';
  const starCount = _starCount(tail);
  return {
    countryCode: cc,
    lastDigits,
    starCount,
    countryMeta: _carriers.countries ? _carriers.countries[cc] || null : null,
  };
}

/**
 * Resolve the username's local-part hint (the IG username is the
 * single strongest prior on the email local-part, since most people
 * register one with the other).
 */
function _usernameLocalCandidates(username) {
  if (!username) return [];
  const u = String(username).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const seeds = new Set([
    u,
    u.replace(/[._-]/g, ''),
    u.split('.')[0],
    u.split('_')[0],
    u.split('-')[0],
  ].filter(Boolean));
  const variants = new Set();
  for (const seed of seeds) {
    variants.add(seed);
    for (let n = 0; n < 100; n += 1) variants.add(`${seed}${n}`);
    for (const yr of [1995, 1996, 1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005, 21, 22, 23, 24, 25]) {
      variants.add(`${seed}${yr}`);
    }
    variants.add(`${seed}.real`);
    variants.add(`${seed}.official`);
  }
  return Array.from(variants);
}

/**
 * Generate email candidates from a mask + the target username.
 *
 *   emailCandidates('t****a@gmail.com', 'tariqahmed')
 *     →  [
 *          { email: 'tariqa@gmail.com', confidence: 60 },
 *          { email: 'tariqahmed@gmail.com', confidence: 55 },
 *          ...
 *        ]
 *
 * Candidates are filtered down to those that match the mask's
 * first-char + last-char + length constraints.
 */
function emailCandidates(mask, username, opts = {}) {
  const m = normaliseEmailMask(mask);
  if (!m) return [];
  const maxLocal = opts.maxLocalLen || (m.localLen + 4);
  const minLocal = opts.minLocalLen || Math.max(3, m.localLen - 2);
  const allowDomains = m.domainMasked ? _domainList : [m.domain];
  const localSeeds = _usernameLocalCandidates(username);

  const out = [];
  const seen = new Set();
  for (const local of localSeeds) {
    if (local.length < minLocal || local.length > maxLocal) continue;
    if (m.firstChar && local[0] !== m.firstChar) continue;
    if (m.lastChar && local[local.length - 1] !== m.lastChar) continue;
    for (const dom of allowDomains) {
      const cand = `${local}@${dom}`;
      if (seen.has(cand)) continue;
      seen.add(cand);
      // Confidence is loosely a function of mask coverage:
      //   - revealed chars / total chars   → mask-fit
      //   - dictionary match for the domain → +5
      //   - username-local exact match     → +10
      let conf = 40;
      if (m.firstChar) conf += 5;
      if (m.lastChar) conf += 5;
      if (m.localLen && Math.abs(m.localLen - local.length) <= 1) conf += 5;
      if (!m.domainMasked) conf += 5;
      if (local === String(username || '').toLowerCase()) conf += 10;
      out.push({ email: cand, confidence: Math.min(95, conf) });
    }
    if (out.length >= MAX_EMAIL_CANDIDATES) break;
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, MAX_EMAIL_CANDIDATES);
}

/**
 * Generate phone candidates from a mask. Bounded by the country
 * dictionary so we never expand an unknown-country mask into a
 * billion-element space.
 */
function phoneCandidates(mask, opts = {}) {
  const m = normalisePhoneMask(mask);
  if (!m) return [];
  const meta = m.countryMeta;
  if (!meta) {
    // Unknown country code — surface the prefix + last-digits hint as a
    // single low-confidence candidate so the operator at least sees
    // what we extracted.
    return [{
      phone: `+${m.countryCode}*${m.lastDigits || ''}`,
      confidence: 20,
      note: 'unknown country code — full enumeration disabled',
    }];
  }
  const [minLen, maxLen] = meta.nationalLen;
  const lastLen = m.lastDigits ? m.lastDigits.length : 0;
  const maxCandidates = opts.maxCandidates || MAX_PHONE_CANDIDATES;
  const out = [];
  // Cap the search space — anything wider than ~6 unknown digits is
  // > 1M candidates which we won't enumerate anyway.
  const unknownDigits = Math.max(0, maxLen - lastLen);
  if (unknownDigits > 6) {
    return [{
      phone: `+${m.countryCode}${'*'.repeat(unknownDigits)}${m.lastDigits || ''}`,
      confidence: 25,
      note: `${unknownDigits} unknown digits — enumeration disabled (too wide)`,
    }];
  }
  const targetLen = maxLen;
  const total = 10 ** unknownDigits;
  // Skip phones starting with 0 in some countries — most national
  // numbering plans use a leading non-zero digit for the trunk prefix.
  for (let i = 0; i < total; i += 1) {
    const padded = String(i).padStart(unknownDigits, '0');
    const national = padded + (m.lastDigits || '');
    if (national.length !== targetLen && national.length !== minLen) continue;
    out.push({
      phone: `+${m.countryCode}${national}`,
      confidence: unknownDigits <= 3 ? 70 : unknownDigits <= 4 ? 50 : 35,
    });
    if (out.length >= maxCandidates) break;
  }
  return out;
}

module.exports = {
  normaliseEmailMask,
  normalisePhoneMask,
  emailCandidates,
  phoneCandidates,
  _domainList,
  _carriers,
  MAX_EMAIL_CANDIDATES,
  MAX_PHONE_CANDIDATES,
};
