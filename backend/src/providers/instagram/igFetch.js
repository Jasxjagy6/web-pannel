/**
 * Single point of egress for Instagram web-API calls.
 *
 * Why this module exists:
 * Instagram's risk model rejects requests on three orthogonal axes:
 *   1. IP reputation       — data-centre IPs trigger checkpoint_required
 *   2. Device fingerprint  — UA + sec-ch-ua + Accept-Language must look
 *                            like the browser the cookies came from AND
 *                            must be IDENTICAL on every request from the
 *                            same sessionid (the cookies remember the UA
 *                            they were issued under)
 *   3. Request cadence     — bursts of identical calls flag as bot
 *
 * Every other module that talks to www.instagram.com (webScraper,
 * cookieAdapter, the warm-up worker, the on-demand health probe)
 * routes through `igFetch()` so all three axes are handled in one
 * place — including proxy egress, browser-grade headers and a tight
 * error-mapping pass.
 *
 * Phase 1 hardening (anti-ban):
 *   - Per-session pinned web fingerprint (UA + sec-ch hints +
 *     accept-language). Sourced from `platform_state.webFingerprint`
 *     if set, otherwise a deterministic pick from
 *     `webFingerprints.json` based on the session's device seed.
 *     Persisted on first use so subsequent requests are identical.
 *   - Per-session pinned locale → `accept-language` header.
 *   - When `security.instagram.require_proxy` is true (default) and
 *     the session has no proxy_url, igFetch throws PROXY_REQUIRED
 *     instead of silently egressing through the panel host.
 *   - Optional jittered pre-sleep stays — `sessionLimiter` (B7) is
 *     the new global throttle; `preSleepMs` is now an additional
 *     per-call hint.
 */

'use strict';

const crypto = require('crypto');
const logger = require('../../utils/logger');
const { decrypt } = require('../../utils/crypto');
const webFingerprintsTable = require('./webFingerprints.json');

let _undici = null;
function _loadUndici() {
  if (_undici) return _undici;
  // eslint-disable-next-line global-require
  _undici = require('undici');
  return _undici;
}

const WEB_APP_ID = '936619743392459';

// Legacy fallbacks — only used if a session has no pinned fingerprint
// AND `webFingerprints.json` is somehow empty. Kept in sync with one
// of the table entries to avoid a silent UA flip on the first request.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const DEFAULT_SEC_CH_UA =
  '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"';

// ---------------------------------------------------------------------
// Per-session ProxyAgent cache
// ---------------------------------------------------------------------

const _dispatcherCache = new Map(); // proxyUrl -> ProxyAgent
let _directH2Agent = null;

/**
 * The direct (no proxy) dispatcher for IG web requests. We intentionally
 * enable HTTP/2 here — Instagram returns a body-less HTTP/1.1 429 to
 * non-browser clients on `www.instagram.com/api/v1/...`, even with a
 * perfectly valid sessionid + browser-grade headers, because no real
 * Chrome/Firefox client has spoken HTTP/1.1 to instagram.com in years.
 * Browsers ALWAYS negotiate H2 via ALPN, so the panel was the obvious
 * outlier.
 *
 * Switching to undici's H2-capable Agent for the direct path makes the
 * request shape match Chrome on the wire and the rate-limit signal
 * disappears. When the operator has assigned a per-session proxy we
 * still use ProxyAgent (which negotiates H2 via the proxy when the
 * upstream supports it).
 */
function _getDirectH2Agent() {
  if (_directH2Agent) return _directH2Agent;
  const { Agent } = _loadUndici();
  _directH2Agent = new Agent({
    allowH2: true,
    connectTimeout: 10_000,
    bodyTimeout: 30_000,
    headersTimeout: 15_000,
  });
  return _directH2Agent;
}

function _getDispatcher(proxyUrl) {
  if (!proxyUrl) return _getDirectH2Agent();
  let agent = _dispatcherCache.get(proxyUrl);
  if (agent) return agent;
  const { ProxyAgent } = _loadUndici();
  agent = new ProxyAgent({
    uri: proxyUrl,
    requestTls: { rejectUnauthorized: false },
    connectTimeout: 10_000,
    bodyTimeout: 30_000,
    headersTimeout: 15_000,
    // Tell undici to attempt ALPN H2 with the upstream when the proxy
    // supports CONNECT — critical for matching real-browser request
    // shape on instagram.com.
    allowH2: true,
  });
  _dispatcherCache.set(proxyUrl, agent);
  return agent;
}

function invalidateProxy(proxyUrl) {
  if (!proxyUrl) return;
  const a = _dispatcherCache.get(proxyUrl);
  if (a && typeof a.close === 'function') a.close().catch(() => {});
  _dispatcherCache.delete(proxyUrl);
}

// ---------------------------------------------------------------------
// Web fingerprint pinning (B3)
// ---------------------------------------------------------------------

function _pickWebFingerprint(seed) {
  const profiles = (webFingerprintsTable && webFingerprintsTable.profiles) || [];
  if (profiles.length === 0) {
    return {
      id: 'fallback',
      userAgent: DEFAULT_USER_AGENT,
      secChUa: DEFAULT_SEC_CH_UA,
      secChUaMobile: '?0',
      secChUaPlatform: '"macOS"',
      acceptLanguage: 'en-US,en;q=0.9',
    };
  }
  const h = crypto.createHash('sha256').update(String(seed || '')).digest();
  const idx = h.readUInt32BE(0) % profiles.length;
  return profiles[idx];
}

function pickWebFingerprint(seed) {
  return _pickWebFingerprint(seed);
}

/**
 * Build an `accept-language` value that respects the session's pinned
 * locale (e.g. `en_IN` → `en-IN,en;q=0.9`).
 */
function _acceptLanguageForLocale(locale, fingerprintDefault) {
  if (!locale || !locale.language) return fingerprintDefault || 'en-US,en;q=0.9';
  const tag = String(locale.language).replace('_', '-');
  const base = tag.split('-')[0];
  return `${tag},${base};q=0.9`;
}

// ---------------------------------------------------------------------
// Proxy enforcement
// ---------------------------------------------------------------------

async function _isProxyRequired() {
  // eslint-disable-next-line global-require
  const settings = require('../../services/systemSettingsService');
  try {
    const v = await settings.getSetting('security.instagram.require_proxy');
    // Default is now `false` — proxy is OPTIONAL. Operators who want
    // strict residential-proxy enforcement should set
    // security.instagram.require_proxy = true in system_settings.
    if (v === true || v === 'true') return true;
    return false;
  } catch (_err) {
    return false;
  }
}

// ---------------------------------------------------------------------
// Cookie / session blob helpers
// ---------------------------------------------------------------------

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
 * the session_data once, hydrates the per-session pinned web
 * fingerprint + locale, and stashes the resolved cookie / proxy data
 * so we don't re-decrypt on every request.
 *
 * `await sessionContext(sessionRow)` — async because pinning a fresh
 * web fingerprint is persisted to platform_state on first use.
 */
async function sessionContext(sessionRow) {
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

  // Hydrate the pinned platform_state (seed, appVersion, locale,
  // api_mode, webFingerprint). identity.getOrCreatePlatformState is
  // idempotent and persists missing slots before returning.
  // eslint-disable-next-line global-require
  const identity = require('./identity');
  const pinned = await identity.getOrCreatePlatformState(sessionRow);
  let webFingerprint = (pinned.platformState && pinned.platformState.webFingerprint) || null;
  if (!webFingerprint || !webFingerprint.userAgent) {
    webFingerprint = _pickWebFingerprint(pinned.seed);
    // Persist so the next request reads the same pinned fingerprint.
    try {
      const ps = pinned.platformState || {};
      ps.webFingerprint = Object.assign({}, webFingerprint, {
        pinned_at: new Date().toISOString(),
      });
      // eslint-disable-next-line global-require
      const { pool } = require('../../config/database');
      await pool.query(
        `UPDATE sessions
            SET platform_state = $1::jsonb,
                updated_at = NOW()
          WHERE id = $2`,
        [JSON.stringify(ps), sessionRow.id]
      );
    } catch (err) {
      logger.warn(`IG.igFetch: failed to persist pinned webFingerprint for sessionId=${sessionRow.id}: ${err.message}`);
    }
  }

  return {
    sessionId: sessionRow.id,
    username: sessionRow.username,
    proxyUrl: sessionRow.proxy_url || null,
    // bypassProxy: when true, igFetch skips the require_proxy gate and
    // sends requests directly from the panel host. Set on a session
    // row clone by scrape jobs whose operator unticked "Use proxy".
    bypassProxy: !!(sessionRow && sessionRow._bypassProxy === true),
    cookieHeader: header,
    csrftoken,
    dsUserId,
    blob,
    webFingerprint,
    locale: pinned.locale,
    apiMode: pinned.apiMode,
    appVersion: pinned.appVersion,
  };
}

// ---------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Header builder + fetch wrapper
// ---------------------------------------------------------------------

/**
 * Browser-grade headers for IG web. Caller passes a `referer` that
 * matches the request (e.g. the target's profile URL) and we fill in
 * the rest from the session's pinned web fingerprint.
 */
function browserHeaders(ctx, opts = {}) {
  const fp = (ctx && ctx.webFingerprint) || _pickWebFingerprint(ctx && ctx.sessionId);
  const acceptLanguage = _acceptLanguageForLocale(ctx && ctx.locale, fp.acceptLanguage);

  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': acceptLanguage,
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    referer: opts.referer || 'https://www.instagram.com/',
    origin: 'https://www.instagram.com',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': fp.userAgent || DEFAULT_USER_AGENT,
    'x-asbd-id': '129477',
    'x-csrftoken': (ctx && ctx.csrftoken) || '',
    'x-ig-app-id': WEB_APP_ID,
    'x-ig-www-claim': '0',
    'x-requested-with': 'XMLHttpRequest',
    cookie: (ctx && ctx.cookieHeader) || '',
  };

  // sec-ch-* headers — only emit them when the pinned fingerprint
  // actually carries them (Chromium-family browsers do, Safari /
  // Firefox don't). Adding them on a Safari UA is itself a bot tell.
  if (fp.secChUa) headers['sec-ch-ua'] = fp.secChUa;
  if (fp.secChUaMobile) headers['sec-ch-ua-mobile'] = fp.secChUaMobile;
  if (fp.secChUaPlatform) headers['sec-ch-ua-platform'] = fp.secChUaPlatform;

  return Object.assign(headers, opts.extraHeaders || {});
}

/**
 * Core fetch wrapper. Handles:
 *   - per-session ProxyAgent dispatcher (undici)
 *   - per-session pinned browser-grade headers
 *   - proxy enforcement
 *   - jittered pre-request sleep to spread out burst calls
 *   - JSON parse + clean error classification
 *
 * Returns the parsed JSON on 2xx, throws a classified error otherwise.
 */
async function igFetch(ctx, url, opts = {}) {
  // Identity-lookup public probes (web_profile_info) call this with
  // `ctx.allowAnonymous = true` to deliberately send a cookie-less
  // request. The endpoint accepts that as long as `x-ig-app-id` is
  // set (browserHeaders does this). Anonymous traffic from a panel
  // host that lacks proxies still fails at the proxy-required gate
  // below, which is the correct production behaviour — but we no
  // longer fail-fast on the cookie check before that gate runs.
  if (!ctx || (!ctx.cookieHeader && !ctx.allowAnonymous)) {
    const e = new Error('Session has no cookies');
    e.kind = 'login_required';
    e.statusCode = 401;
    throw e;
  }

  // Phase 1.B7 — per-session token bucket. Consumes a token of class
  // `read` by default; callers performing writes/risky actions should
  // pass `opts.limiterClass='write'` or `'risky'`.
  if (ctx.sessionId && opts.skipLimiter !== true) {
    // eslint-disable-next-line global-require
    const sessionLimiter = require('./sessionLimiter');
    await sessionLimiter.acquire(ctx.sessionId, {
      class: opts.limiterClass || 'read',
    });
  }

  // Per-call bypass takes precedence over the global require_proxy
  // setting. When ctx.bypassProxy is true the request is sent direct
  // from the panel host; the operator opted in via the scrape form's
  // "Use proxy" checkbox.
  if (!ctx.bypassProxy && !ctx.proxyUrl && (await _isProxyRequired())) {
    const e = new Error(
      `Instagram session ${ctx.sessionId || ''} has no proxy assigned. ` +
      `Direct egress from the panel host trips Instagram's data-centre filter on the first request. ` +
      `Assign a residential proxy, untick "Use proxy" on the scrape form to run this single ` +
      `job from the panel IP, or disable security.instagram.require_proxy in system_settings to override globally.`
    );
    e.kind = 'forbidden';
    e.statusCode = 400;
    e.code = 'PROXY_REQUIRED';
    throw e;
  }

  // Always run through an undici dispatcher so HTTP/2 is negotiated;
  // bypassProxy just skips the ProxyAgent path and uses the H2-capable
  // direct agent.
  const dispatcher = ctx.bypassProxy ? _getDirectH2Agent() : _getDispatcher(ctx.proxyUrl);
  const headers = browserHeaders(ctx, opts);
  const init = {
    method: opts.method || 'GET',
    headers,
    redirect: 'manual',
  };
  if (opts.body) init.body = opts.body;
  if (dispatcher) init.dispatcher = dispatcher;

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
    // Phase 3.B15 — record a structured detection event for every
    // non-2xx web-API response. Best-effort, never throws.
    try {
      // eslint-disable-next-line global-require
      const detectionEvents = require('./detectionEvents');
      const fp = detectionEvents.fingerprintFromCtx(ctx, {
        action_class: opts.limiterClass || 'read',
      });
      detectionEvents.record({
        sessionId: ctx.sessionId || null,
        userId: opts.userId || null,
        eventKind: e.kind || 'network',
        apiPath: url,
        httpStatus: res.status,
        responseBody: body,
        requestFingerprint: fp,
      }).catch(() => { /* swallow — already best-effort inside */ });
    } catch (_recErr) { /* swallow */ }
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
  pickWebFingerprint,
  WEB_APP_ID,
  DEFAULT_USER_AGENT,
};
