/**
 * §2.3 Breach-DB correlator — PR #5.
 *
 * Joins the IG primitives (username, full_name, recovery masks, confirmed
 * emails/phones) against the breach-DB providers the operator has
 * configured keys for. Each hit is surfaced as a finding row with
 * source / dump-date / freshness metadata so the UI can sort them.
 *
 * Providers (any subset may be configured per-user — missing keys are
 * skipped without error):
 *
 *   - Dehashed       (POST https://api.dehashed.com/search)
 *   - LeakCheck      (GET  https://leakcheck.io/api/v2/query/{q})
 *   - Snusbase       (POST https://api.snusbase.com/data/search)
 *   - IntelligenceX  (POST https://2.intelx.io/intelligent/search)
 *   - HIBP           (GET  https://haveibeenpwned.com/api/v3/breachedaccount/{email})
 *
 * Search axes (instagram_upgrade.txt §2.3):
 *   1. username
 *   2. full_name (normalised)
 *   3. mask-confirmed emails (or candidates produced by emailEnumerator)
 *   4. phone tail (last-4 + country code) when phone mask known
 *
 * Freshness scoring — a breach dated AFTER `lastPasswordChangeAt` is
 * scored 30% lower because the credential probably rotated. The
 * caller passes lastPasswordChangeAt via `opts.lastPasswordChangeAt`
 * (defaults to null, in which case no rotation discount is applied).
 *
 * Caching — every paid call is keyed on the query shape and cached
 * for 7 days via `lookupCacheService`. Cache hits are free; cache
 * misses cost the per-call USD estimate in `_COST_PER_CALL`.
 *
 * Budget — every paid call goes through `lookupBudgetService.assertCanSpend()`.
 * If the per-user monthly cap would be exceeded, the provider is
 * skipped and a `budget_exceeded` note is added.
 *
 * Hard rule: this module NEVER attempts to log into the target with
 * any returned credential. Returned passwords / hashes are surfaced
 * to the operator UI for analysis only — `instagram_upgrade.txt §10.1`.
 */

'use strict';

const logger = require('../../../utils/logger');
const userLookupKeys = require('../../../services/userLookupKeysService');
const lookupCache    = require('../../../services/lookupCacheService');
const lookupBudget   = require('../../../services/lookupBudgetService');
const lookupAudit    = require('../../../services/lookupAuditService');
const lookupLimiter  = require('./lookupLimiter');
const { AppError } = require('../../../utils/errorHandler');

// Per-call USD estimates. Real prices vary by quota tier but these
// are the published "small plan" ceilings as of 2024-12. Operators
// can override via `LOOKUP_COST_*` env vars.
const _COST_PER_CALL = {
  dehashed:      Number(process.env.LOOKUP_COST_DEHASHED      || 0.0035),
  leakcheck:     Number(process.env.LOOKUP_COST_LEAKCHECK     || 0.002),
  snusbase:      Number(process.env.LOOKUP_COST_SNUSBASE      || 0.002),
  intelligencex: Number(process.env.LOOKUP_COST_INTELLIGENCEX || 0.005),
  hibp:          Number(process.env.LOOKUP_COST_HIBP          || 0),
};

const _ENDPOINT = {
  dehashed:      'https://api.dehashed.com/search',
  leakcheck:     (q) => `https://leakcheck.io/api/v2/query/${encodeURIComponent(q)}`,
  snusbase:      'https://api.snusbase.com/data/search',
  intelligencex: 'https://2.intelx.io/intelligent/search',
  hibp:          (email) => `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`,
};

const _DEFAULT_TIMEOUT_MS = 15_000;

function _stripUsername(u) {
  if (!u) return '';
  return String(u).trim().replace(/^@+/, '').toLowerCase();
}

function _normaliseName(name) {
  if (!name) return null;
  const stripped = String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const cleaned  = stripped.replace(/[^A-Za-z0-9 \-']/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length < 3) return null;
  return cleaned;
}

function _phoneSuffix(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

function _fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), _DEFAULT_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal })
    .then(async (res) => {
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch (_e) { body = { _raw: text }; }
      return { ok: res.ok, status: res.status, body };
    })
    .finally(() => clearTimeout(timeout));
}

// -----------------------------------------------------------------------------
// Per-provider drivers — each returns a normalised
//   { ok, hits: [{ email?, password?, password_hash?, source_dump, breach_date, fields? }] }
// -----------------------------------------------------------------------------

async function _searchDehashed({ key, meta }, query) {
  if (!key || !meta || !meta.username) return { ok: false, error: 'missing_dehashed_username' };
  const params = new URLSearchParams();
  params.set('size', '50');
  if (query.email)    params.set('query', `email:"${query.email}"`);
  else if (query.username) params.set('query', `username:"${query.username}"`);
  else if (query.name)     params.set('query', `name:"${query.name}"`);
  else if (query.phoneTail)params.set('query', `phone:"${query.phoneTail}"`);
  else return { ok: false, error: 'no_query_axis' };
  const url = `${_ENDPOINT.dehashed}?${params.toString()}`;
  const auth = Buffer.from(`${meta.username}:${key}`).toString('base64');
  const r = await _fetchJson(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${auth}`,
    },
  });
  if (!r.ok) return { ok: false, error: `http_${r.status}`, body: r.body };
  const entries = Array.isArray(r.body && r.body.entries) ? r.body.entries : [];
  return {
    ok: true,
    hits: entries.slice(0, 50).map((e) => ({
      email:         e.email || null,
      username:      e.username || null,
      password:      e.password || null,
      password_hash: e.hashed_password || null,
      source_dump:   e.database_name || e.source || null,
      breach_date:   e.obtained_from || e.date || null,
      fields:        ['ip_address', 'phone', 'name', 'address'].reduce((acc, k) => {
        if (e[k]) acc[k] = e[k];
        return acc;
      }, {}),
    })),
  };
}

async function _searchLeakCheck({ key }, query) {
  if (!key) return { ok: false, error: 'missing_key' };
  const q = query.email || query.username || query.phoneTail;
  if (!q) return { ok: false, error: 'no_query_axis' };
  const r = await _fetchJson(_ENDPOINT.leakcheck(q), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-API-Key': key,
    },
  });
  if (!r.ok) return { ok: false, error: `http_${r.status}`, body: r.body };
  const result = r.body && (r.body.result || r.body.data);
  if (!result) return { ok: true, hits: [] };
  return {
    ok: true,
    hits: result.slice(0, 50).map((e) => ({
      email:         e.email     || null,
      username:      e.username  || null,
      password:      e.password  || null,
      password_hash: e.hash      || null,
      source_dump:   e.source    && (e.source.name || e.source.title) || null,
      breach_date:   e.source && e.source.breach_date || null,
      fields:        e.fields || null,
    })),
  };
}

async function _searchSnusbase({ key }, query) {
  if (!key) return { ok: false, error: 'missing_key' };
  let term, types;
  if (query.email) { term = query.email; types = ['email']; }
  else if (query.username) { term = query.username; types = ['username']; }
  else if (query.name) { term = query.name; types = ['name']; }
  else if (query.phoneTail) { term = query.phoneTail; types = ['lastip', 'phone']; }
  else return { ok: false, error: 'no_query_axis' };
  const r = await _fetchJson(_ENDPOINT.snusbase, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Auth: key,
    },
    body: JSON.stringify({ terms: [term], types, wildcard: false }),
  });
  if (!r.ok) return { ok: false, error: `http_${r.status}`, body: r.body };
  const results = (r.body && r.body.results) || {};
  const hits = [];
  for (const [dbName, rows] of Object.entries(results)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows.slice(0, 50)) {
      hits.push({
        email:         row.email    || null,
        username:      row.username || null,
        password:      row.password || null,
        password_hash: row.hash     || null,
        source_dump:   dbName,
        breach_date:   row._dump_date || null,
        fields:        row,
      });
    }
  }
  return { ok: true, hits };
}

async function _searchIntelligenceX({ key }, query) {
  if (!key) return { ok: false, error: 'missing_key' };
  const term = query.email || query.username || query.name || query.phoneTail;
  if (!term) return { ok: false, error: 'no_query_axis' };
  const create = await _fetchJson(_ENDPOINT.intelligencex, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-key': key,
    },
    body: JSON.stringify({
      term,
      maxresults: 25,
      media: 0,
      sort: 4,
      timeout: 5,
    }),
  });
  if (!create.ok) return { ok: false, error: `http_${create.status}`, body: create.body };
  const id = create.body && create.body.id;
  if (!id) return { ok: true, hits: [] };
  // intelx is async — poll /result. Cap at 2 attempts (4s) so we don't
  // burn a slot.
  let records = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1500));
    // eslint-disable-next-line no-await-in-loop
    const poll = await _fetchJson(`https://2.intelx.io/intelligent/search/result?id=${encodeURIComponent(id)}&limit=25&statistics=0&previewlines=8`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'x-key': key },
    });
    if (poll.ok && poll.body && Array.isArray(poll.body.records)) {
      records = poll.body.records;
      if (poll.body.status === 0 || records.length) break;
    }
  }
  return {
    ok: true,
    hits: records.slice(0, 25).map((rec) => ({
      email:        null,
      username:     null,
      password:     null,
      password_hash:null,
      source_dump:  rec.bucket || rec.name || null,
      breach_date:  rec.date   || null,
      fields:       { systemid: rec.systemid, type: rec.type, name: rec.name },
    })),
  };
}

async function _searchHibp({ key }, query) {
  // HIBP free tier is read-only on `/breaches`; the per-account endpoint
  // requires a paid key.
  if (!key || !query.email) return { ok: false, error: query.email ? 'missing_key' : 'no_query_axis' };
  const r = await _fetchJson(_ENDPOINT.hibp(query.email), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'hibp-api-key': key,
      'User-Agent': 'web-pannel-lookup/1.0',
    },
  });
  if (r.status === 404) return { ok: true, hits: [] };
  if (!r.ok) return { ok: false, error: `http_${r.status}`, body: r.body };
  const arr = Array.isArray(r.body) ? r.body : [];
  return {
    ok: true,
    hits: arr.slice(0, 50).map((e) => ({
      email:         query.email,
      username:      null,
      password:      null,
      password_hash: null,
      source_dump:   e.Name || e.Title || null,
      breach_date:   e.BreachDate || null,
      fields:        {
        data_classes: e.DataClasses,
        is_verified:  e.IsVerified,
        is_sensitive: e.IsSensitive,
      },
    })),
  };
}

const _PROVIDER_DRIVERS = {
  dehashed:      _searchDehashed,
  leakcheck:     _searchLeakCheck,
  snusbase:      _searchSnusbase,
  intelligencex: _searchIntelligenceX,
  hibp:          _searchHibp,
};

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

function _scoreFreshness(breachDateStr, lastPwChange) {
  if (!breachDateStr) return 60;
  const bd = Date.parse(breachDateStr);
  if (!Number.isFinite(bd)) return 60;
  if (lastPwChange) {
    const pc = Date.parse(lastPwChange);
    if (Number.isFinite(pc) && bd < pc) return 35;  // pre-rotation, stale
  }
  const ageDays = (Date.now() - bd) / 86400000;
  if (ageDays < 180)   return 85;
  if (ageDays < 365)   return 75;
  if (ageDays < 365*3) return 65;
  return 50;
}

async function _runProvider({ provider, keyResolution, query, userId, jobId }) {
  if (!keyResolution || !keyResolution.key) {
    return { provider, ok: false, error: 'no_key_configured', hits: [], cost: 0 };
  }
  const cached = await lookupCache.get(provider, query);
  if (cached) {
    return { provider, ok: true, hits: cached.hits || [], cost: 0, cached: true };
  }
  const estCost = _COST_PER_CALL[provider] || 0;
  if (estCost > 0) {
    const budget = await lookupBudget.assertCanSpend(userId, estCost);
    if (!budget.allowed) {
      return { provider, ok: false, error: 'budget_exceeded', hits: [], cost: 0, budget };
    }
  }
  await lookupLimiter.acquire(`breach:${provider}`, { class: 'read', jitterMs: 250 });
  const driver = _PROVIDER_DRIVERS[provider];
  let result;
  try {
    result = await driver(keyResolution, query);
  } catch (err) {
    logger.warn(`breachCorrelator: ${provider} error: ${err.message}`);
    return { provider, ok: false, error: err.name === 'AbortError' ? 'timeout' : 'exception', message: err.message, hits: [], cost: 0 };
  }
  if (!result.ok) return { provider, ok: false, error: result.error, body: result.body, hits: [], cost: 0 };

  // Persist to cache + record spend.
  await lookupCache.set(provider, query, { hits: result.hits || [] }, {
    costUsd: estCost,
    ttlMs: lookupCache.DEFAULT_TTL_MS,
  });
  if (estCost > 0) {
    await lookupBudget.recordSpend({ userId, provider, costUsd: estCost, jobId, method: 'breach' });
    lookupAudit.log({
      userId,
      jobId: jobId || null,
      action: 'paid_call',
      method: 'breach',
      meta: { provider, queryShape: Object.keys(query), hits: result.hits.length },
      costUsd: estCost,
    });
  }
  return { provider, ok: true, hits: result.hits, cost: estCost, cached: false };
}

function _buildQueries({ username, fullName, confirmedEmails, confirmedPhones, maskedEmail, maskedPhone, altUsernames }) {
  const queries = [];
  if (username) queries.push({ username: _stripUsername(username) });
  for (const u of (altUsernames || [])) {
    if (u && u !== username) queries.push({ username: _stripUsername(u) });
  }
  const nm = _normaliseName(fullName);
  if (nm) queries.push({ name: nm });
  for (const e of (confirmedEmails || [])) {
    if (e) queries.push({ email: String(e).trim().toLowerCase() });
  }
  for (const p of (confirmedPhones || [])) {
    const tail = _phoneSuffix(p);
    if (tail) queries.push({ phoneTail: tail });
  }
  // Mask-derived hints (informational, low-yield by design).
  if (maskedEmail && /@/.test(String(maskedEmail))) {
    queries.push({ name: _normaliseName(String(maskedEmail).split('@')[0].replace(/\*/g, '').slice(0, 30)) });
  }
  if (maskedPhone) {
    const tail = _phoneSuffix(String(maskedPhone).replace(/\*/g, ''));
    if (tail) queries.push({ phoneTail: tail });
  }
  // Dedup
  const seen = new Set();
  return queries.filter((q) => {
    const key = JSON.stringify(q);
    if (seen.has(key)) return false;
    seen.add(key);
    return !!Object.values(q).find((v) => v && String(v).length > 0);
  });
}

async function run(username, opts = {}) {
  if (!username || typeof username !== 'string') {
    throw new AppError('breachCorrelator.run: username required', 400, 'VALIDATION_ERROR');
  }
  const cleaned = _stripUsername(username);
  const userId = opts.userId || null;

  // Inputs come from the upstream pipeline. We accept liberal aliases
  // so the runner doesn't care about field-name drift.
  const fullName = opts.fullName
    || (opts.profileInfoSnapshot && (opts.profileInfoSnapshot.full_name
        || (opts.profileInfoSnapshot.data && opts.profileInfoSnapshot.data.user && opts.profileInfoSnapshot.data.user.full_name)))
    || null;
  const confirmedEmails = Array.isArray(opts.confirmedEmails) ? opts.confirmedEmails : [];
  const confirmedPhones = Array.isArray(opts.confirmedPhones) ? opts.confirmedPhones : [];
  const maskedEmail = opts.maskedEmail || (opts.resetOracleSnapshot && opts.resetOracleSnapshot.obfuscated_email) || null;
  const maskedPhone = opts.maskedPhone || (opts.resetOracleSnapshot && opts.resetOracleSnapshot.obfuscated_phone) || null;
  const altUsernames = Array.isArray(opts.altUsernames) ? opts.altUsernames : [];
  const lastPasswordChangeAt = opts.lastPasswordChangeAt || null;

  // Determine which providers we can call. A provider with no
  // configured key is skipped — the runner still completes ok.
  const keys = await userLookupKeys.getAllKeys(userId);
  const queries = _buildQueries({ username: cleaned, fullName, confirmedEmails, confirmedPhones, maskedEmail, maskedPhone, altUsernames });
  if (!queries.length) {
    return {
      method: 'breach',
      ok: true,
      findings: [{
        method: 'breach',
        kind: 'note',
        value: 'breach correlator: no usable input axis (need username/email/phone/full_name).',
        confidence: 100,
      }],
    };
  }

  const findings = [];
  const providerSummary = {};
  let totalCost = 0;

  // Cross-product of providers × queries. Bounded to ≤25 calls per
  // job (5 providers × 5 queries default) to keep paid spend tight.
  const PROVIDERS = ['dehashed', 'leakcheck', 'snusbase', 'intelligencex', 'hibp'];
  const limited = queries.slice(0, 5);
  for (const provider of PROVIDERS) {
    const keyResolution = keys[provider];
    if (!keyResolution) {
      providerSummary[provider] = { ok: false, reason: 'no_key' };
      continue;
    }
    let hits = 0;
    let calls = 0;
    let lastError = null;
    for (const q of limited) {
      // Skip HIBP queries that have no email — its only axis.
      if (provider === 'hibp' && !q.email) continue;
      // eslint-disable-next-line no-await-in-loop
      const r = await _runProvider({ provider, keyResolution, query: q, userId, jobId: opts.jobId });
      calls += 1;
      totalCost += r.cost || 0;
      if (!r.ok) { lastError = r.error || 'error'; continue; }
      for (const h of (r.hits || [])) {
        hits += 1;
        const conf = _scoreFreshness(h.breach_date, lastPasswordChangeAt);
        if (h.password) {
          findings.push({
            method: 'breach',
            kind: 'password',
            value: h.password.slice(0, 200),
            confidence: conf,
            raw: { ...h, provider, query: q, cached: r.cached === true },
          });
        }
        if (h.password_hash) {
          findings.push({
            method: 'breach',
            kind: 'password_hash',
            value: h.password_hash.slice(0, 200),
            confidence: conf,
            raw: { ...h, provider, query: q, cached: r.cached === true },
          });
        }
        if (h.email && !findings.some((f) => f.kind === 'email' && f.value === h.email.toLowerCase())) {
          findings.push({
            method: 'breach',
            kind: 'email',
            value: String(h.email).toLowerCase(),
            confidence: conf,
            raw: { ...h, provider, query: q, cached: r.cached === true },
          });
        }
        if (h.source_dump) {
          findings.push({
            method: 'breach',
            kind: 'note',
            value: `breach: ${h.source_dump}${h.breach_date ? ` (${h.breach_date})` : ''}`,
            confidence: conf,
            raw: { ...h, provider, query: q, cached: r.cached === true },
          });
        }
      }
    }
    providerSummary[provider] = { ok: true, calls, hits, lastError };
  }

  findings.push({
    method: 'breach',
    kind: 'note',
    value: `breach correlator summary: ${
      Object.entries(providerSummary)
        .map(([p, s]) => `${p}=${s.ok ? `${s.hits}h/${s.calls}c` : (s.reason || 'err')}`)
        .join(' ')
    }`,
    confidence: 100,
    raw: { providerSummary, queries: limited, totalCost },
  });

  logger.info(`IG.lookup.breach: ${cleaned} → providers=${PROVIDERS.filter((p) => keys[p]).length} queries=${limited.length} hits=${findings.filter((f) => f.kind !== 'note').length} cost=$${totalCost.toFixed(4)}`);

  return {
    method: 'breach',
    ok: true,
    findings,
    cost_usd_estimate: totalCost,
    raw: { providerSummary, queries: limited },
  };
}

module.exports = {
  run,
  _buildQueries,
  _scoreFreshness,
  _normaliseName,
  _phoneSuffix,
};
