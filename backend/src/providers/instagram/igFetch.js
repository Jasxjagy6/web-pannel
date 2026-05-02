/**
 * Single point of egress for Instagram web-API calls.
 *
 * Why this module exists:
 * Instagram's risk model rejects requests on three orthogonal axes:
 *   1. IP reputation       — data-centre IPs trigger checkpoint_required
 *   2. Device fingerprint  — UA + sec-ch-ua + Accept-Language must look
 *                            like the browser the cookies came from
 *   3. Request cadence     — bursts of identical calls flag as bot
 *
 * Every other module that talks to www.instagram.com (webScraper,
 * cookieAdapter, the warm-up worker, the on-demand health probe)
 * routes through `igFetch()` so all three axes are handled in one
 * place — including proxy egress, browser-grade headers and a tight
 * error-mapping pass.
 */

const logger = require('../../utils/logger');
const { decrypt } = require('../../utils/crypto');

let _undici = null;
function _loadUndici() {
  if (_undici) return _undici;
  // eslint-disable-next-line global-require
  _undici = require('undici');
  return _undici;
}

const WEB_APP_ID = '936619743392459';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const DEFAULT_SEC_CH_UA =
  '"Chromium";v="123", "Not:A-Brand";v="24", "Google Chrome";v="123"';

// Per-session cached ProxyAgent (undici dispatcher) so we don't pay
// the connection-pool init cost on every request.
const _dispatcherCache = new Map(); // proxyUrl -> ProxyAgent

function _getDispatcher(proxyUrl) {
  if (!proxyUrl) return undefined;
  let agent = _dispatcherCache.get(proxyUrl);
  if (agent) return agent;
  const { ProxyAgent } = _loadUndici();
  agent = new ProxyAgent({
    uri: proxyUrl,
    // 30s read timeout, 10s connect timeout — IG is fast and a slow
    // proxy almost always means a dead one. Don't burn the whole job
    // waiting on a dead exit.
    requestTls: { rejectUnauthorized: false },
    connectTimeout: 10_000,
    bodyTimeout: 30_000,
    headersTimeout: 15_000,
  });
  _dispatcherCache.set(proxyUrl, agent);
  return agent;
}

/**
 * Drop the cached dispatcher for a proxy URL — call this when the
 * operator rotates the proxy on a session row.
 */
function invalidateProxy(proxyUrl) {
  if (!proxyUrl) return;
  const a = _dispatcherCache.get(proxyUrl);
  if (a && typeof a.close === 'function') a.close().catch(() => {});
  _dispatcherCache.delete(proxyUrl);
}

/**
 * Walk the panel's nested/flat session blob shapes and return:
 *   - cookies header string
 *   - csrftoken value (if present)
 *   - ds_user_id (own pk, useful for "self" warm-up calls)
 */
function cookieHeaderFromBlob(blob) {
  if (!blob) return { header: '', csrftoken: null, dsUserId: null };
  let raw = null;
  if (Array.isArray(blob)) {
    raw = blob;
  } else if (blob.cookies && Array.isArray(blob.cookies)) {
    raw = blob.cookies;
  } else if (blob.cookies && Array.isArray(blob.cookies.cookies)) {
    raw = blob.cookies.cookies;
  }
  if (!Array.isArray(raw)) return { header: '', csrftoken: null, dsUserId: null };
  let csrftoken = null;
  let dsUserId = null;
  const parts = [];
  for (const c of raw) {
    const name = c.key || c.name;
    if (!name) continue;
    const dom = (c.domain || '').toLowerCase().replace(/^\./, '');
    if (dom && !dom.endsWith('instagram.com')) continue;
    if (name === 'csrftoken') csrftoken = c.value;
    if (name === 'ds_user_id') dsUserId = c.value;
    parts.push(`${name}=${c.value}`);
  }
  return { header: parts.join('; '), csrftoken, dsUserId };
}

/**
 * Build a session-context object that callers (webScraper, warm-up,
 * cookieAdapter) can hold onto for the duration of a job. Decrypts
 * the session_data once and stashes the resolved cookie / proxy data
 * so we don't re-decrypt on every request.
 */
function sessionContext(sessionRow) {
  if (!sessionRow) throw new Error('sessionContext(): session row required');
  let blob = null;
  if (sessionRow.session_data) {
    try {
      blob = JSON.parse(decrypt(sessionRow.session_data));
    } catch (err) {
      const e = new Error(`Failed to decrypt session blob: ${err.message}`);
      e.statusCode = 500;
      throw e;
    }
  }
  const { header, csrftoken, dsUserId } = cookieHeaderFromBlob(blob);
  return {
    sessionId: sessionRow.id,
    username: sessionRow.username,
    proxyUrl: sessionRow.proxy_url || null,
    cookieHeader: header,
    csrftoken,
    dsUserId,
    blob,
  };
}

/**
 * Map an HTTP status / body to a clean classified error so callers
 * can branch on `e.kind` (checkpoint, login_required, rate_limited,
 * not_found, network) and so the session-health state machine knows
 * whether to flip the row to needs_attention.
 */
function classifyError(status, body) {
  const e = new Error();
  const lc = (body || '').toLowerCase();
  if (/checkpoint_required/.test(lc) || /challenge_required/.test(lc)) {
    e.kind = 'checkpoint';
    e.statusCode = 401;
    e.message = 'Instagram is blocking this session with a checkpoint. Solve it on a trusted device, then re-upload.';
    return e;
  }
  if (/login_required/.test(lc) || status === 401) {
    e.kind = 'login_required';
    e.statusCode = 401;
    e.message = 'Instagram session is no longer logged in. Re-upload a fresh session.';
    return e;
  }
  if (/feedback_required/.test(lc) || /action_blocked/.test(lc)) {
    e.kind = 'action_blocked';
    e.statusCode = 429;
    e.message = 'Instagram has temporarily blocked this action on this session. Pause and try again later.';
    return e;
  }
  if (status === 429 || /rate.?limit/.test(lc)) {
    e.kind = 'rate_limited';
    e.statusCode = 429;
    e.message = 'Instagram is rate-limiting this session. Slow down and try again in a few minutes.';
    return e;
  }
  if (status === 404 || /user_not_found/.test(lc)) {
    e.kind = 'not_found';
    e.statusCode = 404;
    e.message = 'Target Instagram username not found.';
    return e;
  }
  if (status === 403) {
    e.kind = 'forbidden';
    e.statusCode = 403;
    e.message = 'Instagram refused this request. The target may be private or the session may not be authorised.';
    return e;
  }
  e.kind = 'network';
  e.statusCode = status >= 500 ? 502 : 500;
  e.message = `Instagram web API returned HTTP ${status}: ${(body || '').slice(0, 200)}`;
  return e;
}

/**
 * Browser-grade headers for IG web. Caller passes a `referer` that
 * matches the request (e.g. the target's profile URL) and we fill in
 * the rest. The sec-ch-* hints are what real Chromium sends and
 * IG's bot model leans on them heavily.
 */
function browserHeaders(ctx, opts = {}) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    referer: opts.referer || 'https://www.instagram.com/',
    origin: 'https://www.instagram.com',
    'sec-ch-ua': DEFAULT_SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': DEFAULT_USER_AGENT,
    'x-asbd-id': '129477',
    'x-csrftoken': ctx.csrftoken || '',
    'x-ig-app-id': WEB_APP_ID,
    'x-ig-www-claim': '0',
    'x-requested-with': 'XMLHttpRequest',
    cookie: ctx.cookieHeader || '',
    ...(opts.extraHeaders || {}),
  };
}

/**
 * Core fetch wrapper. Handles:
 *   - per-session ProxyAgent dispatcher (undici)
 *   - browser-grade headers (UA, sec-ch, x-ig-app-id, csrftoken)
 *   - jittered pre-request sleep to spread out burst calls
 *   - JSON parse + clean error classification
 *
 * Returns the parsed JSON on 2xx, throws a classified error otherwise.
 *
 * Caller can pass `opts.expectJson = false` to get the raw body string.
 */
async function igFetch(ctx, url, opts = {}) {
  if (!ctx || !ctx.cookieHeader) {
    const e = new Error('Session has no cookies');
    e.kind = 'login_required';
    e.statusCode = 401;
    throw e;
  }

  const dispatcher = _getDispatcher(ctx.proxyUrl);
  const headers = browserHeaders(ctx, opts);
  const init = {
    method: opts.method || 'GET',
    headers,
    redirect: 'manual',
  };
  if (opts.body) init.body = opts.body;
  if (dispatcher) init.dispatcher = dispatcher;

  // Optional jittered pre-sleep so callers in tight loops don't burst.
  if (opts.preSleepMs) {
    const ms = Math.floor(opts.preSleepMs * (0.7 + Math.random() * 0.6));
    await new Promise((r) => setTimeout(r, ms));
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const e = new Error(`Network error fetching IG: ${err.message}`);
    e.kind = 'network';
    e.statusCode = 502;
    e.cause = err;
    throw e;
  }
  const body = await res.text();
  if (!res.ok) {
    const e = classifyError(res.status, body);
    if (opts.logErrors !== false) {
      logger.warn(`IG fetch ${init.method} ${url} → ${res.status} (${e.kind})`);
    }
    throw e;
  }
  if (opts.expectJson === false) return body;
  try {
    return JSON.parse(body);
  } catch (_err) {
    const e = classifyError(res.status, body);
    e.message = `IG returned non-JSON 2xx: ${body.slice(0, 200)}`;
    throw e;
  }
}

module.exports = {
  igFetch,
  sessionContext,
  cookieHeaderFromBlob,
  browserHeaders,
  classifyError,
  invalidateProxy,
  WEB_APP_ID,
  DEFAULT_USER_AGENT,
};
