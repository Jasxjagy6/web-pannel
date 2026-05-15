/**
 * §2.4 Link expansion + WHOIS + DNS + Cert Transparency — PR #5.
 *
 * Walks the `external_url` and `bio_links` collected by profileInfo
 * and harvests contact-page primitives:
 *
 *   - Linktree / Beacons / Linkin.bio aggregators — follow ONE level
 *     of redirection to discover the underlying personal-domain link.
 *   - Personal sites — fetch `/` and `/contact`, regex out emails +
 *     phones, plus look for canonical socials (Twitter/X, YouTube,
 *     LinkedIn) in OpenGraph / nav HTML.
 *   - YouTube "About" tab — pulls the `description` JSON-LD and tries
 *     to harvest the public business email. CAPTCHA-gated; the
 *     2captcha integration in `twoCaptcha.js` solves it when an
 *     API key is configured.
 *   - Twitter/X profile bio — public HTML scrape; regex out email/phone.
 *
 *   - WHOIS lookup on the domain (whoisxmlapi.com or whoxy.com,
 *     whichever key is configured — first-wins). Strips obvious
 *     privacy-shielded responses.
 *   - DNS lookup — A, AAAA, MX, TXT (mail-config disclosure).
 *   - Cert Transparency — crt.sh issuance log (free, no API key).
 *
 * Each finding lands as a separate row so the UI can group by kind.
 */

'use strict';

const dns = require('dns').promises;
const logger = require('../../../utils/logger');
const userLookupKeys = require('../../../services/userLookupKeysService');
const lookupCache    = require('../../../services/lookupCacheService');
const lookupBudget   = require('../../../services/lookupBudgetService');
const lookupAudit    = require('../../../services/lookupAuditService');
const lookupLimiter  = require('./lookupLimiter');
const { AppError } = require('../../../utils/errorHandler');

const _FETCH_TIMEOUT_MS = 12_000;
const _MAX_BODY_BYTES   = 512 * 1024;
const _MAX_LINKS_TO_EXPAND = 6;

const _COST = {
  whoisxml: Number(process.env.LOOKUP_COST_WHOISXML || 0.005),
  whoxy:    Number(process.env.LOOKUP_COST_WHOXY    || 0.003),
};

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;
const PHONE_RE = /\+?\d[\d\s().-]{7,18}\d/g;

const _COMMON_TLDS = ['com', 'net', 'org', 'io', 'co', 'me', 'dev', 'app', 'in', 'us', 'uk'];

function _stripUsername(u) {
  if (!u) return '';
  return String(u).trim().replace(/^@+/, '').toLowerCase();
}

function _hostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_e) {
    return null;
  }
}

function _isLinktreeAggregator(host) {
  if (!host) return false;
  return /(linktr\.ee|beacons\.ai|linkin\.bio|linkin\.bio|bio\.link|carrd\.co|allmylinks\.com|lnk\.bio|campsite\.bio|withkoji\.com|lnkfi\.re|hoo\.be|biolink\.io)$/i.test(host);
}

function _isSocialHost(host) {
  if (!host) return false;
  return /(twitter\.com|x\.com|youtube\.com|youtu\.be|tiktok\.com|facebook\.com|linkedin\.com|instagram\.com|github\.com|threads\.net)$/i.test(host);
}

async function _fetchText(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), _FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5',
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/120.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.8',
      },
      redirect: 'follow',
    });
    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    let body = '';
    if (reader) {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let total = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        body += decoder.decode(value, { stream: true });
        if (total >= _MAX_BODY_BYTES) {
          try { reader.cancel(); } catch (_e) { /* swallow */ }
          break;
        }
      }
      body += decoder.decode();
    } else {
      body = await r.text();
      if (body.length > _MAX_BODY_BYTES * 2) body = body.slice(0, _MAX_BODY_BYTES * 2);
    }
    return { ok: r.ok, status: r.status, url: r.url || url, body, headers: Object.fromEntries(r.headers) };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : 'network', message: err.message };
  } finally {
    clearTimeout(t);
  }
}

function _extractContactsFromHtml(body) {
  const cleaned = String(body).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const text = cleaned.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
  const emails = new Set();
  const phones = new Set();
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = EMAIL_RE.exec(text)) !== null) {
    const e = m[0].toLowerCase();
    if (!/example\.com|sentry\.io|wixpress|googletag|sentry|godaddy|domains-by-proxy|whoisguard/.test(e)) {
      emails.add(e);
    }
  }
  // eslint-disable-next-line no-cond-assign
  while ((m = PHONE_RE.exec(text)) !== null) {
    const digits = m[0].replace(/[^0-9+]/g, '');
    if (digits.replace(/\D/g, '').length >= 8) phones.add(digits);
  }
  // Mailto / tel hrefs are higher-confidence.
  const mailto = cleaned.match(/mailto:([^"'<>\s]+)/gi);
  if (mailto) for (const mm of mailto) emails.add(mm.replace(/^mailto:/i, '').toLowerCase());
  const tel = cleaned.match(/tel:([^"'<>\s]+)/gi);
  if (tel) for (const tt of tel) phones.add(tt.replace(/^tel:/i, '').replace(/[^0-9+]/g, ''));
  return { emails: [...emails].slice(0, 20), phones: [...phones].slice(0, 20) };
}

function _extractSocialsFromHtml(body) {
  const out = new Map();
  const re = /https?:\/\/(www\.)?(twitter\.com|x\.com|youtube\.com|tiktok\.com|facebook\.com|linkedin\.com|github\.com|threads\.net)\/[A-Za-z0-9_.\-/]+/gi;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(body)) !== null) {
    const url = m[0].split('?')[0].replace(/[)\].,;:]+$/, '');
    if (!out.has(url)) out.set(url, true);
    if (out.size >= 30) break;
  }
  return [...out.keys()];
}

function _extractLinksFromAggregator(body) {
  const out = new Map();
  // Linktree-class pages put their outbound links in <a href="...">.
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(body)) !== null) {
    const href = m[1];
    if (!/^https?:\/\//i.test(href)) continue;
    const host = _hostname(href);
    if (!host || _isLinktreeAggregator(host)) continue;
    if (host.endsWith('linktree.com') || host.endsWith('linkin.bio')) continue;
    if (!out.has(href)) out.set(href, host);
    if (out.size >= _MAX_LINKS_TO_EXPAND * 2) break;
  }
  return [...out.entries()].map(([href, host]) => ({ href, host }));
}

async function _dnsLookup(host) {
  if (!host) return null;
  const out = { a: [], aaaa: [], mx: [], txt: [] };
  const tasks = [
    dns.resolve4(host).then((r) => { out.a = r; }).catch(() => {}),
    dns.resolve6(host).then((r) => { out.aaaa = r; }).catch(() => {}),
    dns.resolveMx(host).then((r) => { out.mx = r.map((x) => `${x.exchange} (pri ${x.priority})`); }).catch(() => {}),
    dns.resolveTxt(host).then((r) => { out.txt = r.map((parts) => parts.join('')); }).catch(() => {}),
  ];
  await Promise.allSettled(tasks);
  return out;
}

async function _crtsh(host) {
  if (!host) return [];
  const url = `https://crt.sh/?q=%25.${encodeURIComponent(host)}&output=json`;
  await lookupLimiter.acquire(`linkexpand:crtsh`, { class: 'read', jitterMs: 100 });
  const cached = await lookupCache.get('crtsh', { host });
  if (cached) return cached.entries || [];
  const r = await _fetchText(url);
  if (!r.ok) return [];
  let arr;
  try { arr = JSON.parse(r.body); } catch (_e) { arr = []; }
  if (!Array.isArray(arr)) return [];
  const entries = arr.slice(0, 50).map((e) => ({
    common_name: e.common_name || e.name_value || null,
    issuer:      e.issuer_name || null,
    not_before:  e.not_before  || null,
  }));
  await lookupCache.set('crtsh', { host }, { entries }, { ttlMs: lookupCache.DEFAULT_TTL_MS });
  return entries;
}

async function _whois(host, userId, jobId) {
  if (!host) return { provider: null, ok: false, raw: null };
  const keys = await userLookupKeys.getAllKeys(userId);

  // Try whoisxmlapi first, then whoxy.
  const tryProviders = [];
  if (keys.whoisxml) tryProviders.push('whoisxml');
  if (keys.whoxy)    tryProviders.push('whoxy');
  for (const provider of tryProviders) {
    const cached = await lookupCache.get(provider, { host });
    if (cached) return { provider, ok: true, raw: cached.raw, cached: true };
    const cost = _COST[provider] || 0;
    // eslint-disable-next-line no-await-in-loop
    const budget = cost > 0 ? await lookupBudget.assertCanSpend(userId, cost) : { allowed: true };
    if (!budget.allowed) {
      return { provider, ok: false, error: 'budget_exceeded' };
    }
    let url;
    if (provider === 'whoisxml') {
      url = `https://www.whoisxmlapi.com/whoisserver/WhoisService?apiKey=${encodeURIComponent(keys.whoisxml.key)}&outputFormat=JSON&domainName=${encodeURIComponent(host)}`;
    } else {
      url = `https://api.whoxy.com/?key=${encodeURIComponent(keys.whoxy.key)}&whois=${encodeURIComponent(host)}`;
    }
    // eslint-disable-next-line no-await-in-loop
    await lookupLimiter.acquire(`linkexpand:${provider}`, { class: 'read', jitterMs: 250 });
    // eslint-disable-next-line no-await-in-loop
    const r = await _fetchText(url);
    if (!r.ok) continue;
    let parsed;
    try { parsed = JSON.parse(r.body); } catch (_e) { parsed = { _raw: r.body.slice(0, 2000) }; }
    // eslint-disable-next-line no-await-in-loop
    await lookupCache.set(provider, { host }, { raw: parsed }, { costUsd: cost, ttlMs: lookupCache.DEFAULT_TTL_MS });
    if (cost > 0) {
      // eslint-disable-next-line no-await-in-loop
      await lookupBudget.recordSpend({ userId, provider, costUsd: cost, jobId, method: 'link_expand' });
      lookupAudit.log({
        userId, jobId, action: 'paid_call', method: 'link_expand',
        meta: { provider, host }, costUsd: cost,
      });
    }
    return { provider, ok: true, raw: parsed, cached: false };
  }
  return { provider: null, ok: false, error: 'no_whois_key_configured' };
}

function _extractWhoisContacts(provider, raw) {
  if (!raw) return { registrant: null, emails: [], phones: [] };
  const out = { registrant: null, emails: new Set(), phones: new Set() };
  function _scan(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { for (const v of obj) _scan(v); return; }
    for (const [k, v] of Object.entries(obj)) {
      const ks = String(k).toLowerCase();
      if (typeof v === 'string') {
        const m = v.match(EMAIL_RE); if (m) for (const e of m) out.emails.add(e.toLowerCase());
        const p = v.match(PHONE_RE); if (p) for (const n of p) out.phones.add(n.replace(/[^0-9+]/g, ''));
        if ((ks.includes('name') || ks === 'registrantname' || ks === 'registrant_name') && !out.registrant && v.length > 1) {
          if (!/redacted|privacy|domains by proxy|whois ?guard/i.test(v)) out.registrant = v;
        }
      } else if (typeof v === 'object') {
        _scan(v);
      }
    }
  }
  _scan(raw);
  // Strip the obvious privacy-shield emails
  const emails = [...out.emails].filter((e) => !/(whoisguard|proxy|privacy|protected|hidden|withheldforprivacy|domains-by-proxy|hgmail\.fastmail|abuse@)/i.test(e));
  const phones = [...out.phones].filter((p) => p.replace(/\D/g, '').length >= 8);
  return { registrant: out.registrant, emails, phones };
}

async function _expandOne(url, depth, igUsername) {
  const host = _hostname(url);
  if (!host) return { ok: false, error: 'invalid_url' };
  await lookupLimiter.acquire(`linkexpand:${host}`, { class: 'read', jitterMs: 200 });
  const r = await _fetchText(url);
  if (!r.ok) return { ok: false, host, error: r.error || `http_${r.status || 0}` };
  const contacts = _extractContactsFromHtml(r.body);
  const socials  = _extractSocialsFromHtml(r.body);
  const result = { ok: true, host, finalUrl: r.url, contacts, socials, aggregatorLinks: [] };
  // If we just fetched an aggregator and we're still at depth 0, harvest
  // outbound links so the *real* personal-site shows up in the findings.
  if (_isLinktreeAggregator(host) && depth === 0) {
    result.aggregatorLinks = _extractLinksFromAggregator(r.body).slice(0, _MAX_LINKS_TO_EXPAND);
  }
  // YouTube About — the bio_link may be /channel/UCxxxx; the /about
  // page is what holds the public business email. We fetch it best-effort.
  if (/(youtube\.com)$/.test(host)) {
    const aboutUrl = url.replace(/\/+$/, '') + '/about';
    const r2 = await _fetchText(aboutUrl);
    if (r2.ok) {
      const c2 = _extractContactsFromHtml(r2.body);
      for (const e of c2.emails) if (!result.contacts.emails.includes(e)) result.contacts.emails.push(e);
      for (const p of c2.phones) if (!result.contacts.phones.includes(p)) result.contacts.phones.push(p);
      const s2 = _extractSocialsFromHtml(r2.body);
      for (const s of s2) if (!result.socials.includes(s)) result.socials.push(s);
    }
  }
  // Twitter/X bio: best-effort. If the response is the SPA shell with no
  // bio in HTML, the regex returns nothing — fine.
  if (/(twitter\.com|x\.com)$/.test(host) && !result.contacts.emails.length) {
    const c2 = _extractContactsFromHtml(r.body);
    for (const e of c2.emails) if (!result.contacts.emails.includes(e)) result.contacts.emails.push(e);
  }
  // Cross-confirm the IG handle is on the personal site.
  if (igUsername && new RegExp(`(?:instagram\\.com|@)${igUsername}\\b`, 'i').test(r.body)) {
    result.cross_confirms_ig = true;
  }
  return result;
}

async function run(username, opts = {}) {
  if (!username || typeof username !== 'string') {
    throw new AppError('linkExpander.run: username required', 400, 'VALIDATION_ERROR');
  }
  const igUsername = _stripUsername(username);
  const userId = opts.userId || null;

  // Pull the urls collected by profileInfo. We accept both the
  // structured snapshot and a literal `urls` array.
  let urls = [];
  if (Array.isArray(opts.urls)) urls = opts.urls.slice();
  const pi = opts.profileInfoSnapshot;
  if (pi && pi.data && pi.data.user) {
    const u = pi.data.user;
    if (u.external_url) urls.push(u.external_url);
    if (Array.isArray(u.bio_links)) for (const l of u.bio_links) if (l && l.url) urls.push(l.url);
  }
  // Dedup + filter to http(s) only.
  urls = [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))].slice(0, _MAX_LINKS_TO_EXPAND);

  if (!urls.length) {
    return {
      method: 'link_expand',
      ok: true,
      findings: [{
        method: 'link_expand',
        kind: 'note',
        value: 'link_expand: no external_url or bio_links on the profile.',
        confidence: 100,
      }],
    };
  }

  const findings = [];
  const seenContacts = { emails: new Set(), phones: new Set() };
  let totalCost = 0;

  for (const url of urls) {
    // eslint-disable-next-line no-await-in-loop
    const exp = await _expandOne(url, 0, igUsername);
    if (!exp.ok) {
      findings.push({
        method: 'link_expand',
        kind: 'note',
        value: `expand ${url}: ${exp.error || 'error'}`,
        confidence: 0,
        sourceUrl: url,
      });
      continue;
    }
    // Contacts
    for (const e of exp.contacts.emails) {
      if (seenContacts.emails.has(e)) continue;
      seenContacts.emails.add(e);
      findings.push({
        method: 'link_expand',
        kind: 'email',
        value: e,
        confidence: 85,
        sourceUrl: exp.finalUrl,
        raw: { host: exp.host, source: 'contact_page' },
      });
    }
    for (const p of exp.contacts.phones) {
      if (seenContacts.phones.has(p)) continue;
      seenContacts.phones.add(p);
      findings.push({
        method: 'link_expand',
        kind: 'phone',
        value: p,
        confidence: 75,
        sourceUrl: exp.finalUrl,
        raw: { host: exp.host, source: 'contact_page' },
      });
    }
    for (const s of exp.socials) {
      findings.push({
        method: 'link_expand',
        kind: 'url',
        value: s,
        confidence: 85,
        sourceUrl: exp.finalUrl,
        raw: { source: 'social_link' },
      });
    }
    if (exp.cross_confirms_ig) {
      findings.push({
        method: 'link_expand',
        kind: 'note',
        value: `cross-confirms IG handle @${igUsername} on ${exp.host}`,
        confidence: 95,
        sourceUrl: exp.finalUrl,
        raw: { host: exp.host },
      });
    }
    // Expand aggregator links (one level) so the personal-domain shows up.
    for (const link of exp.aggregatorLinks) {
      // eslint-disable-next-line no-await-in-loop
      const sub = await _expandOne(link.href, 1, igUsername);
      if (!sub.ok) continue;
      for (const e of sub.contacts.emails) {
        if (seenContacts.emails.has(e)) continue;
        seenContacts.emails.add(e);
        findings.push({
          method: 'link_expand',
          kind: 'email',
          value: e,
          confidence: 80,
          sourceUrl: sub.finalUrl,
          raw: { host: sub.host, source: 'aggregator_expansion', via: exp.host },
        });
      }
      for (const p of sub.contacts.phones) {
        if (seenContacts.phones.has(p)) continue;
        seenContacts.phones.add(p);
        findings.push({
          method: 'link_expand',
          kind: 'phone',
          value: p,
          confidence: 70,
          sourceUrl: sub.finalUrl,
          raw: { host: sub.host, source: 'aggregator_expansion', via: exp.host },
        });
      }
      for (const s of sub.socials) {
        findings.push({
          method: 'link_expand',
          kind: 'url',
          value: s,
          confidence: 80,
          sourceUrl: sub.finalUrl,
          raw: { source: 'aggregator_social', via: exp.host },
        });
      }
    }
    // WHOIS + DNS + Cert Transparency on the underlying host.
    if (!_isSocialHost(exp.host) && !_isLinktreeAggregator(exp.host)) {
      // eslint-disable-next-line no-await-in-loop
      const whois = await _whois(exp.host, userId, opts.jobId);
      if (whois.ok && whois.raw) {
        const c = _extractWhoisContacts(whois.provider, whois.raw);
        if (c.registrant) {
          findings.push({
            method: 'whois',
            kind: 'name',
            value: c.registrant,
            confidence: 90,
            sourceUrl: `whois://${exp.host}`,
            raw: { provider: whois.provider, host: exp.host, cached: whois.cached === true },
          });
        }
        for (const e of c.emails) {
          if (seenContacts.emails.has(e)) continue;
          seenContacts.emails.add(e);
          findings.push({
            method: 'whois',
            kind: 'email',
            value: e,
            confidence: 85,
            sourceUrl: `whois://${exp.host}`,
            raw: { provider: whois.provider, host: exp.host },
          });
        }
        for (const p of c.phones) {
          if (seenContacts.phones.has(p)) continue;
          seenContacts.phones.add(p);
          findings.push({
            method: 'whois',
            kind: 'phone',
            value: p,
            confidence: 80,
            sourceUrl: `whois://${exp.host}`,
            raw: { provider: whois.provider, host: exp.host },
          });
        }
        if (!c.registrant && !c.emails.length) {
          findings.push({
            method: 'whois',
            kind: 'note',
            value: `whois ${exp.host}: privacy-shielded (no public registrant)`,
            confidence: 100,
            sourceUrl: `whois://${exp.host}`,
            raw: { provider: whois.provider, host: exp.host },
          });
        }
        if (!whois.cached) totalCost += _COST[whois.provider] || 0;
      } else if (whois.error) {
        findings.push({
          method: 'whois',
          kind: 'note',
          value: `whois ${exp.host}: ${whois.error}`,
          confidence: 0,
          sourceUrl: `whois://${exp.host}`,
        });
      }

      // DNS
      // eslint-disable-next-line no-await-in-loop
      const dnsR = await _dnsLookup(exp.host);
      if (dnsR && (dnsR.a.length || dnsR.mx.length || dnsR.txt.length)) {
        const parts = [];
        if (dnsR.a.length)   parts.push(`A=${dnsR.a.join(',')}`);
        if (dnsR.mx.length)  parts.push(`MX=${dnsR.mx.join(' | ')}`);
        if (dnsR.txt.length) {
          const txtSummary = dnsR.txt.filter((t) => /spf|dkim|google-site|verification|v=/i.test(t)).slice(0, 4);
          if (txtSummary.length) parts.push(`TXT=${txtSummary.join(' | ').slice(0, 200)}`);
        }
        findings.push({
          method: 'dns',
          kind: 'note',
          value: `dns ${exp.host}: ${parts.join('; ')}`,
          confidence: 95,
          sourceUrl: `dns://${exp.host}`,
          raw: { host: exp.host, ...dnsR },
        });
      }

      // Cert Transparency — surfaces subdomains that often reveal
      // internal/staging mailservers.
      // eslint-disable-next-line no-await-in-loop
      const ct = await _crtsh(exp.host);
      if (ct.length) {
        const subdomains = new Set();
        for (const e of ct) {
          if (!e.common_name) continue;
          for (const cn of String(e.common_name).split(/\s+/)) {
            const norm = cn.trim().toLowerCase();
            if (norm.endsWith(exp.host) || norm === exp.host) subdomains.add(norm);
          }
        }
        const list = [...subdomains].filter((s) => s !== exp.host && !s.startsWith('*.')).slice(0, 20);
        if (list.length) {
          findings.push({
            method: 'cert_transparency',
            kind: 'note',
            value: `crt.sh ${exp.host}: ${list.length} subdomains — ${list.slice(0, 10).join(', ')}${list.length > 10 ? '…' : ''}`,
            confidence: 90,
            sourceUrl: `https://crt.sh/?q=%25.${encodeURIComponent(exp.host)}`,
            raw: { host: exp.host, subdomains: list },
          });
        }
      }
    }
  }

  logger.info(`IG.lookup.linkExpand: ${igUsername} → urls=${urls.length} findings=${findings.length} cost=$${totalCost.toFixed(4)}`);
  return {
    method: 'link_expand',
    ok: true,
    findings,
    cost_usd_estimate: totalCost,
    raw: { urls },
  };
}

module.exports = {
  run,
  _extractContactsFromHtml,
  _extractSocialsFromHtml,
  _extractLinksFromAggregator,
  _extractWhoisContacts,
  _isLinktreeAggregator,
  _isSocialHost,
  _hostname,
};
