/**
 * §2.7 Google-dork probe via SerpAPI.
 *
 * Issues a small set of targeted Google searches that historically
 * surface PII for IG handles:
 *
 *   site:linkedin.com "<username>"
 *   site:facebook.com "<username>"
 *   site:about.me   "<username>"
 *   site:linktr.ee  "<username>"
 *   "<username>"  email
 *   "<username>"  phone
 *   "<username>"  resume
 *
 * Requires the operator (or org admin) to set `SERPAPI_KEY` in
 * the backend env. When unset the method gracefully returns `ok: true`
 * with an informational note instead of erroring — that way the rest
 * of the pipeline still completes for cheap.
 *
 * Per-job spend is bounded by lookup_jobs.budget_usd_cap (the
 * runner enforces this; this module just reports its own per-query
 * cost via `cost_usd_estimate`).
 *
 * Findings are emitted as kind=url with raw.title + raw.snippet so
 * the operator can read the surface before clicking through.
 */

'use strict';

const logger = require('../../../utils/logger');
const lookupLimiter = require('./lookupLimiter');

const SERPAPI_URL = 'https://serpapi.com/search.json';
// Approximate cost per SerpAPI search at their cheapest tier ($75 / 5k searches).
const COST_PER_QUERY_USD = 0.015;

const DORKS = [
  (u) => `site:linkedin.com/in "${u}"`,
  (u) => `site:linkedin.com "${u}"`,
  (u) => `site:facebook.com "${u}"`,
  (u) => `site:twitter.com "${u}"`,
  (u) => `site:about.me "${u}"`,
  (u) => `site:linktr.ee "${u}"`,
  (u) => `site:github.com "${u}"`,
  (u) => `"${u}" email`,
  (u) => `"${u}" phone`,
  (u) => `"${u}" contact`,
];

async function _serp(query, key) {
  const u = new URL(SERPAPI_URL);
  u.searchParams.set('engine', 'google');
  u.searchParams.set('q', query);
  u.searchParams.set('num', '5');
  u.searchParams.set('api_key', key);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(u, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    clearTimeout(t);
    logger.warn(`IG.lookup.googleDork: serpapi error for "${query}": ${err.message}`);
    return null;
  }
}

async function run(username, opts = {}) {
  if (!username || typeof username !== 'string') {
    return { method: 'dork', ok: false, error: 'invalid_input', findings: [] };
  }
  const cleaned = username.trim().replace(/^@+/, '');
  const key = (opts.serpApiKey || process.env.SERPAPI_KEY || '').trim();
  if (!key) {
    return {
      method: 'dork',
      ok: true,
      findings: [{
        method: 'dork',
        kind: 'note',
        value: 'Google-dork probe skipped — set SERPAPI_KEY in the backend env or attach a per-user key via Settings.',
        confidence: 100,
      }],
      raw: { skipped: 'no_serpapi_key' },
      cost_usd_estimate: 0,
    };
  }

  await lookupLimiter.acquire(`dork:${cleaned}`, { class: 'read' });

  const budgetUsdCap = Number(opts.budgetUsdCap || 0);
  const queries = DORKS.slice(0, Math.max(1, Math.min(DORKS.length, opts.maxQueries || DORKS.length)));
  const findings = [];
  const seen = new Set();
  let spentUsd = 0;
  for (const make of queries) {
    if (budgetUsdCap > 0 && spentUsd + COST_PER_QUERY_USD > budgetUsdCap) {
      findings.push({
        method: 'dork',
        kind: 'note',
        value: `Google-dork probe aborted at ${spentUsd.toFixed(4)} USD — budget cap reached.`,
        confidence: 100,
      });
      break;
    }
    const q = make(cleaned);
    const r = await _serp(q, key);
    spentUsd += COST_PER_QUERY_USD;
    if (!r) continue;
    const results = (r.organic_results || []).slice(0, 5);
    for (const o of results) {
      const url = o.link;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      findings.push({
        method: 'dork',
        kind: 'url',
        value: url,
        confidence: 70,
        sourceUrl: url,
        raw: {
          query: q,
          title: o.title || null,
          snippet: o.snippet || null,
          position: o.position || null,
        },
      });
    }
  }

  logger.info(`IG.lookup.googleDork: ${cleaned} → ${findings.length} hits, spent ~$${spentUsd.toFixed(4)}`);
  return {
    method: 'dork',
    ok: true,
    findings,
    cost_usd_estimate: Number(spentUsd.toFixed(4)),
    raw: { queries_run: queries.length, hits: findings.length },
  };
}

module.exports = { run, DORKS, COST_PER_QUERY_USD };
