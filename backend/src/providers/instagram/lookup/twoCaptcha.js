/**
 * 2captcha thin client — PR #6.
 *
 * Solves reCAPTCHA v2 / v3 / hCaptcha / image-text CAPTCHAs via the
 * 2captcha.com REST API. Used by:
 *   - reverseImage.js — Yandex sometimes serves a CAPTCHA before
 *                       letting an unauth'd client see results.
 *   - linkExpander.js — YouTube About email-reveal CAPTCHA.
 *   - candidateGenerator.js (optional) — IG /accounts/web_create_ajax
 *                                          intermittently challenges.
 *
 * Behaviour: long-poll the 2captcha "out" endpoint with 5s sleeps
 * (their official cadence) up to opts.timeoutMs (default 90s).
 *
 * Returns `{ ok, token, error, timeMs }` — never throws.
 */

'use strict';

const logger = require('../../../utils/logger');
const userLookupKeys = require('../../../services/userLookupKeysService');
const lookupBudget   = require('../../../services/lookupBudgetService');
const lookupAudit    = require('../../../services/lookupAuditService');

const _SUBMIT = 'https://2captcha.com/in.php';
const _POLL   = 'https://2captcha.com/res.php';
const _DEFAULT_POLL_INTERVAL_MS = 5000;
const _DEFAULT_TIMEOUT_MS = 90_000;

const _COST_PER_SOLVE = Number(process.env.LOOKUP_COST_TWOCAPTCHA || 0.003);

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function _fetchJson(url, init = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20_000);
  try {
    const r = await fetch(url, { ...init, signal: controller.signal });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch (_e) { body = { _raw: text }; }
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function solve({
  method,            // 'userrecaptcha' | 'hcaptcha' | 'recaptchav3' | 'image'
  siteKey,
  pageUrl,
  imageBase64,       // for method='image'
  action,            // for recaptchav3
  minScore,          // for recaptchav3
  userId,
  jobId,
  timeoutMs = _DEFAULT_TIMEOUT_MS,
  pollIntervalMs = _DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  const t0 = Date.now();
  const keyRes = await userLookupKeys.getKey(userId, '2captcha');
  if (!keyRes || !keyRes.key) {
    return { ok: false, error: 'no_key', timeMs: 0 };
  }
  if (_COST_PER_SOLVE > 0) {
    const budget = await lookupBudget.assertCanSpend(userId, _COST_PER_SOLVE);
    if (!budget.allowed) return { ok: false, error: 'budget_exceeded', timeMs: 0 };
  }
  // Submit
  const params = new URLSearchParams({
    key: keyRes.key,
    method: method || 'userrecaptcha',
    json: '1',
  });
  if (siteKey)  params.set('googlekey', siteKey);
  if (siteKey && method === 'hcaptcha') params.set('sitekey', siteKey);
  if (pageUrl)  params.set('pageurl', pageUrl);
  if (action)   params.set('action', action);
  if (minScore) params.set('min_score', String(minScore));
  if (imageBase64) params.set('body', imageBase64);
  let submit;
  try {
    submit = await _fetchJson(`${_SUBMIT}?${params.toString()}`, { method: 'GET' });
  } catch (err) {
    return { ok: false, error: 'submit_failed', message: err.message, timeMs: Date.now() - t0 };
  }
  if (!submit.ok || submit.body.status !== 1) {
    return { ok: false, error: 'submit_rejected', body: submit.body, timeMs: Date.now() - t0 };
  }
  const reqId = submit.body.request;
  // Poll
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await _sleep(pollIntervalMs);
    const pollUrl = `${_POLL}?${new URLSearchParams({ key: keyRes.key, action: 'get', id: reqId, json: '1' }).toString()}`;
    let poll;
    try {
      // eslint-disable-next-line no-await-in-loop
      poll = await _fetchJson(pollUrl, { method: 'GET' });
    } catch (err) {
      continue;
    }
    if (poll.body && poll.body.status === 1) {
      const token = poll.body.request;
      if (_COST_PER_SOLVE > 0) {
        await lookupBudget.recordSpend({ userId, provider: '2captcha', costUsd: _COST_PER_SOLVE, jobId, method: 'captcha' });
        lookupAudit.log({
          userId,
          jobId: jobId || null,
          action: 'paid_call',
          method: 'captcha',
          meta: { reqId, method },
          costUsd: _COST_PER_SOLVE,
        });
      }
      logger.info(`2captcha solved (${method}) in ${Date.now() - t0}ms`);
      return { ok: true, token, timeMs: Date.now() - t0 };
    }
    if (poll.body && poll.body.status === 0 && poll.body.request !== 'CAPCHA_NOT_READY') {
      return { ok: false, error: 'solve_failed', message: poll.body.request, timeMs: Date.now() - t0 };
    }
  }
  return { ok: false, error: 'timeout', timeMs: Date.now() - t0 };
}

module.exports = { solve };
