/**
 * Reddit cookie-scrape service.
 *
 * Executes a real Reddit login flow over HTTPS using the legacy
 * `/api/login/<username>` JSON endpoint, then crawls a configurable
 * set of follow-up endpoints across reddit.com / oauth.reddit.com /
 * chat.reddit.com to harvest every Set-Cookie the server emits.
 *
 * - Password and TOTP secret are decrypted at job time only.
 * - All captured cookies are persisted to `reddit_cookies` with their
 *   VALUE encrypted at rest (AES-256-GCM via utils/crypto.js); the
 *   metadata (name, domain, path, http_only, secure, same_site,
 *   host_only, expires_at, source_url, original Set-Cookie header)
 *   stays plaintext for query / export performance.
 * - Every scrape attempt writes a row to `reddit_scrape_jobs` that
 *   forms the audit trail (operator user_id, client_ip, user_agent,
 *   proxy snapshot, status, cookies_count, error_code).
 * - 2FA is solved automatically when `totp_secret_enc` is present.
 * - Captcha / rate-limit / quarantine surfaces are detected and
 *   surfaced as distinct error_codes so the UI can guide the
 *   operator.
 */

'use strict';

const crypto = require('crypto');
const { request } = require('undici');
const undici = require('undici');
const pool = require('../config/database');
const { encrypt, decrypt } = require('../utils/crypto');
const { totp } = require('../utils/totp');
const proxyService = require('../services/proxyService');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// HTTP dispatchers (proxied / direct). Cached per proxy URL so consecutive
// requests on the same scrape job re-use the connection.
// ---------------------------------------------------------------------------
let _directAgent = null;
const _proxyDispatchers = new Map();

function _directDispatcher() {
  if (!_directAgent) {
    _directAgent = new undici.Agent({
      allowH2: true,
      connectTimeout: 10_000,
      bodyTimeout: 30_000,
      headersTimeout: 15_000,
    });
  }
  return _directAgent;
}

function _dispatcherFor(proxyUrl) {
  if (!proxyUrl) return _directDispatcher();
  let agent = _proxyDispatchers.get(proxyUrl);
  if (agent) return agent;
  agent = new undici.ProxyAgent({
    uri: proxyUrl,
    requestTls: { rejectUnauthorized: false },
    connectTimeout: 10_000,
    bodyTimeout: 30_000,
    headersTimeout: 15_000,
    allowH2: true,
  });
  _proxyDispatchers.set(proxyUrl, agent);
  return agent;
}

// ---------------------------------------------------------------------------
// User agents — a small rotating pool so consecutive jobs against the same
// account don't all carry an identical fingerprint.
// ---------------------------------------------------------------------------
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

function _pickUserAgent(seed) {
  if (!seed) return USER_AGENTS[0];
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  return USER_AGENTS[h[0] % USER_AGENTS.length];
}

// ---------------------------------------------------------------------------
// Cookie jar — minimal, deliberate. We do NOT depend on tough-cookie
// because the surface we need is small (parse Set-Cookie, store, emit
// `Cookie:` per host).
// ---------------------------------------------------------------------------

class CookieJar {
  constructor() {
    this._byKey = new Map(); // `${domain}|${path}|${name}` → cookie
    this._raw = [];          // chronological log for the export pipeline
  }

  setFromHeader(setCookieHeader, sourceUrl) {
    if (!setCookieHeader) return;
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const h of headers) {
      const parsed = parseSetCookie(h, sourceUrl);
      if (!parsed) continue;
      const key = `${parsed.domain}|${parsed.path}|${parsed.name}`;
      this._byKey.set(key, parsed);
      this._raw.push(parsed);
    }
  }

  cookieHeaderFor(url) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname || '/';
    const parts = [];
    for (const c of this._byKey.values()) {
      if (!_domainMatches(host, c.domain, c.host_only)) continue;
      if (!_pathMatches(path, c.path)) continue;
      if (c.secure && u.protocol !== 'https:') continue;
      if (c.expires_at && new Date(c.expires_at).getTime() < Date.now()) continue;
      parts.push(`${c.name}=${c.value}`);
    }
    return parts.join('; ');
  }

  all() {
    // Dedup by (name, domain, path) keeping the latest value but preserving
    // the original source_url + set_cookie of the latest emission.
    return Array.from(this._byKey.values());
  }
}

function _domainMatches(host, cookieDomain, hostOnly) {
  if (hostOnly) return host === cookieDomain;
  if (host === cookieDomain) return true;
  return host.endsWith(`.${cookieDomain}`);
}

function _pathMatches(reqPath, cookiePath) {
  if (!cookiePath) return true;
  if (reqPath === cookiePath) return true;
  if (cookiePath.endsWith('/')) return reqPath.startsWith(cookiePath);
  return reqPath === cookiePath || reqPath.startsWith(`${cookiePath}/`);
}

function parseSetCookie(header, sourceUrl) {
  if (!header) return null;
  const segments = header.split(';');
  const first = segments.shift();
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  let domain = null;
  let path = '/';
  let expires_at = null;
  let max_age = null;
  let http_only = false;
  let secure = false;
  let same_site = null;
  let host_only = true;

  for (const seg of segments) {
    const s = seg.trim();
    if (!s) continue;
    const lower = s.toLowerCase();
    if (lower.startsWith('domain=')) {
      domain = s.slice(7).trim().toLowerCase().replace(/^\./, '');
      host_only = false;
    } else if (lower.startsWith('path=')) {
      path = s.slice(5).trim() || '/';
    } else if (lower.startsWith('expires=')) {
      const d = new Date(s.slice(8).trim());
      if (!Number.isNaN(d.getTime())) expires_at = d.toISOString();
    } else if (lower.startsWith('max-age=')) {
      const n = Number(s.slice(8).trim());
      if (!Number.isNaN(n)) {
        max_age = n;
        expires_at = new Date(Date.now() + n * 1000).toISOString();
      }
    } else if (lower === 'httponly') {
      http_only = true;
    } else if (lower === 'secure') {
      secure = true;
    } else if (lower.startsWith('samesite=')) {
      same_site = s.slice(9).trim();
    }
  }

  if (!domain && sourceUrl) {
    try {
      domain = new URL(sourceUrl).hostname.toLowerCase();
    } catch (_e) {
      domain = 'reddit.com';
    }
  }
  if (!domain) domain = 'reddit.com';

  return {
    name,
    value,
    domain,
    path,
    expires_at,
    max_age,
    http_only,
    secure,
    same_site,
    host_only,
    source_url: sourceUrl || null,
    set_cookie: header,
  };
}

// ---------------------------------------------------------------------------
// HTTP helper — sends one request through the right dispatcher with the
// right cookie header and absorbs every Set-Cookie back into the jar.
// ---------------------------------------------------------------------------

async function _httpRequest({ method, url, headers = {}, body = null, jar, dispatcher }) {
  const merged = {
    ...headers,
  };
  const cookieHeader = jar.cookieHeaderFor(url);
  if (cookieHeader) merged.cookie = cookieHeader;
  const resp = await request(url, {
    method,
    headers: merged,
    body,
    dispatcher,
    maxRedirections: 0,  // we drive redirects ourselves so we can capture cookies on each hop
    throwOnError: false,
  });
  const setCookie = resp.headers['set-cookie'];
  if (setCookie) jar.setFromHeader(setCookie, url);
  let text = '';
  try {
    text = await resp.body.text();
  } catch (_e) {
    text = '';
  }
  return {
    status: resp.statusCode,
    headers: resp.headers,
    body: text,
  };
}

async function _followRedirects(req, jar, dispatcher, maxHops = 6) {
  let current = await _httpRequest({ ...req, jar, dispatcher });
  let hops = 0;
  while (current.status >= 300 && current.status < 400 && hops < maxHops) {
    const loc = current.headers.location;
    if (!loc) break;
    const next = new URL(loc, req.url).toString();
    current = await _httpRequest({
      method: 'GET',
      url: next,
      headers: { ...(req.headers || {}), referer: req.url },
      jar,
      dispatcher,
    });
    hops += 1;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Account CRUD
// ---------------------------------------------------------------------------

async function listAccounts(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, username, label, notes, proxy_id, status, status_message,
            last_scraped_at, last_successful_at, last_job_id, metadata,
            created_at, updated_at,
            CASE WHEN totp_secret_enc IS NULL THEN false ELSE true END AS has_totp
       FROM reddit_accounts
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

async function getAccount(userId, accountId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, username, label, notes, proxy_id, status, status_message,
            last_scraped_at, last_successful_at, last_job_id, metadata,
            created_at, updated_at,
            CASE WHEN totp_secret_enc IS NULL THEN false ELSE true END AS has_totp
       FROM reddit_accounts
      WHERE user_id = $1 AND id = $2`,
    [userId, accountId]
  );
  return rows[0] || null;
}

async function createAccount(userId, { username, password, totpSecret, label, notes, proxyId }) {
  const u = String(username || '').trim();
  if (!u || !/^[A-Za-z0-9_-]{2,32}$/.test(u)) {
    throw new Error('invalid username (must be 2-32 chars, A-Z 0-9 _ -)');
  }
  if (!password || password.length < 1) throw new Error('password is required');

  const passwordEnc = encrypt(password);
  const totpEnc = totpSecret && totpSecret.trim() ? encrypt(totpSecret.trim().toUpperCase().replace(/\s+/g, '')) : null;

  // The unique index `reddit_accounts_user_username_uq` enforces
  // (user_id, lower(username)) uniqueness; we catch 23505 to translate
  // it into a friendly duplicate_account code.
  let rows;
  try {
    ({ rows } = await pool.query(
      `INSERT INTO reddit_accounts (user_id, username, password_enc, totp_secret_enc, label, notes, proxy_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [userId, u, passwordEnc, totpEnc, label || null, notes || null, proxyId || null]
    ));
  } catch (e) {
    if (e && e.code === '23505') {
      const dup = new Error('reddit account already exists for this user');
      dup.code = 'duplicate_account';
      throw dup;
    }
    throw e;
  }
  return getAccount(userId, rows[0].id);
}

async function updateAccount(userId, accountId, patch) {
  const existing = await getAccount(userId, accountId);
  if (!existing) throw new Error('account not found');

  const set = [];
  const vals = [userId, accountId];
  let i = vals.length + 1;

  if (patch.password) {
    set.push(`password_enc = $${i++}`);
    vals.push(encrypt(patch.password));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'totpSecret')) {
    if (!patch.totpSecret) {
      set.push(`totp_secret_enc = NULL`);
    } else {
      set.push(`totp_secret_enc = $${i++}`);
      vals.push(encrypt(String(patch.totpSecret).trim().toUpperCase().replace(/\s+/g, '')));
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'label')) {
    set.push(`label = $${i++}`);
    vals.push(patch.label || null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) {
    set.push(`notes = $${i++}`);
    vals.push(patch.notes || null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'proxyId')) {
    set.push(`proxy_id = $${i++}`);
    vals.push(patch.proxyId || null);
  }
  if (set.length === 0) return existing;
  set.push(`updated_at = NOW()`);
  await pool.query(
    `UPDATE reddit_accounts SET ${set.join(', ')}
       WHERE user_id = $1 AND id = $2`,
    vals
  );
  return getAccount(userId, accountId);
}

async function deleteAccount(userId, accountId) {
  await pool.query(
    `DELETE FROM reddit_accounts WHERE user_id = $1 AND id = $2`,
    [userId, accountId]
  );
}

// ---------------------------------------------------------------------------
// Jobs / cookies
// ---------------------------------------------------------------------------

async function listJobs(userId, accountId, { limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, account_id, user_id, status, attempt, proxy_id, proxy_url_snapshot,
            user_agent, client_ip, cookies_count, oauth_token_present, meta_snapshot,
            duration_ms, error_code, error_message, queue_job_id,
            created_at, started_at, completed_at
       FROM reddit_scrape_jobs
      WHERE user_id = $1 AND account_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [userId, accountId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500)]
  );
  return rows;
}

async function getJob(userId, jobId) {
  const { rows } = await pool.query(
    `SELECT j.* FROM reddit_scrape_jobs j
      WHERE j.user_id = $1 AND j.id = $2`,
    [userId, jobId]
  );
  return rows[0] || null;
}

async function listCookies(userId, jobId) {
  // Verify ownership through the job row, then fetch the cookies.
  const job = await getJob(userId, jobId);
  if (!job) return null;
  const { rows } = await pool.query(
    `SELECT id, account_id, job_id, name, value_enc, value_hash, value_len,
            domain, path, expires_at, max_age, http_only, secure, same_site,
            host_only, source_url, set_cookie, captured_at
       FROM reddit_cookies
      WHERE job_id = $1
      ORDER BY id ASC`,
    [jobId]
  );
  const decrypted = rows.map((r) => ({
    id: r.id,
    name: r.name,
    value: _safeDecrypt(r.value_enc),
    value_hash: r.value_hash,
    value_len: r.value_len,
    domain: r.domain,
    path: r.path,
    expires_at: r.expires_at,
    max_age: r.max_age,
    http_only: r.http_only,
    secure: r.secure,
    same_site: r.same_site,
    host_only: r.host_only,
    source_url: r.source_url,
    set_cookie: r.set_cookie,
    captured_at: r.captured_at,
  }));
  return { job, cookies: decrypted };
}

function _safeDecrypt(enc) {
  try {
    return decrypt(enc);
  } catch (_e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Job creation (queueing handled by caller).
// ---------------------------------------------------------------------------

async function createJobRow(userId, accountId, { clientIp, userAgent }) {
  const { rows } = await pool.query(
    `INSERT INTO reddit_scrape_jobs (account_id, user_id, status, attempt, client_ip, user_agent)
     VALUES ($1, $2, 'queued', 1, $3, $4)
     RETURNING id`,
    [accountId, userId, clientIp || null, userAgent || null]
  );
  await pool.query(
    `UPDATE reddit_accounts SET status = 'queued', status_message = NULL, updated_at = NOW()
      WHERE id = $1 AND user_id = $2`,
    [accountId, userId]
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// The actual scrape — runs synchronously inside the worker.
// ---------------------------------------------------------------------------

async function executeJob(jobId) {
  const startedAt = Date.now();
  const { rows: jrows } = await pool.query(
    `SELECT * FROM reddit_scrape_jobs WHERE id = $1`,
    [jobId]
  );
  if (!jrows[0]) throw new Error(`reddit_scrape_jobs row ${jobId} not found`);
  const job = jrows[0];

  const { rows: arows } = await pool.query(
    `SELECT * FROM reddit_accounts WHERE id = $1`,
    [job.account_id]
  );
  if (!arows[0]) throw new Error(`reddit_accounts row ${job.account_id} not found`);
  const account = arows[0];

  await pool.query(
    `UPDATE reddit_scrape_jobs SET status='running', started_at=NOW() WHERE id=$1`,
    [jobId]
  );
  await pool.query(
    `UPDATE reddit_accounts SET status='scraping', status_message=NULL, updated_at=NOW()
      WHERE id=$1`,
    [account.id]
  );

  let proxyUrl = null;
  let proxySnapshot = null;
  if (account.proxy_id) {
    const proxyRow = await _loadProxy(account.proxy_id);
    if (proxyRow) {
      proxyUrl = proxyService.buildProxyUrl(proxyRow);
      proxySnapshot = proxyUrl
        ? proxyUrl.replace(/:[^:@]*@/, ':***@') // mask password
        : null;
    }
  }

  const userAgent = _pickUserAgent(`${account.id}|${jobId}`);
  const jar = new CookieJar();
  const dispatcher = _dispatcherFor(proxyUrl);

  let password;
  try {
    password = decrypt(account.password_enc);
  } catch (e) {
    return _failJob(jobId, account.id, 'decrypt_failed', `password decrypt failed: ${e.message}`, startedAt, jar, proxySnapshot, userAgent);
  }
  let totpSecret = null;
  if (account.totp_secret_enc) {
    try {
      totpSecret = decrypt(account.totp_secret_enc);
    } catch (e) {
      return _failJob(jobId, account.id, 'decrypt_failed', `totp decrypt failed: ${e.message}`, startedAt, jar, proxySnapshot, userAgent);
    }
  }

  let loginResult;
  try {
    loginResult = await _performLogin({
      jar,
      dispatcher,
      username: account.username,
      password,
      totpSecret,
      userAgent,
    });
  } catch (e) {
    return _failJob(jobId, account.id, e.code || 'login_failed', e.message, startedAt, jar, proxySnapshot, userAgent);
  }

  // Crawl follow-up pages to gather every cookie surface Reddit exposes.
  const hostsVisited = [];
  await _crawlFollowups({ jar, dispatcher, userAgent, hostsVisited });

  // Validate session.
  let meSnapshot = null;
  try {
    const meResp = await _httpRequest({
      method: 'GET',
      url: 'https://www.reddit.com/api/v1/me.json',
      headers: _commonHeaders(userAgent, 'https://www.reddit.com/'),
      jar,
      dispatcher,
    });
    if (meResp.status === 200) {
      try { meSnapshot = JSON.parse(meResp.body); } catch (_e) { meSnapshot = null; }
    } else {
      meSnapshot = { _http_status: meResp.status };
    }
  } catch (e) {
    meSnapshot = { _error: e.message };
  }

  // Try to extract the OAuth access token Reddit embeds in the homepage
  // HTML (the `__r` config blob). When found, persist it in the metadata
  // for downstream tooling.
  let oauthToken = null;
  try {
    const home = await _httpRequest({
      method: 'GET',
      url: 'https://www.reddit.com/',
      headers: _commonHeaders(userAgent, 'https://www.reddit.com/'),
      jar,
      dispatcher,
    });
    const m = /"accessToken":"([A-Za-z0-9\-_.]+)"/.exec(home.body);
    if (m) oauthToken = m[1];
  } catch (_e) { /* ignore */ }

  const cookies = jar.all();
  await _persistCookies(jobId, account.id, cookies);

  const meta = {
    reddit_session_set: cookies.some((c) => c.name === 'reddit_session'),
    modhash_set: cookies.some((c) => c.name === 'modhash'),
    token_v2_set: cookies.some((c) => c.name === 'token_v2'),
    edgebucket_set: cookies.some((c) => c.name === 'edgebucket'),
    csv_set: cookies.some((c) => c.name === 'csv'),
    loid_set: cookies.some((c) => c.name === 'loid'),
    hosts_visited: hostsVisited,
    me_endpoint: meSnapshot ? {
      ok: !!(meSnapshot && meSnapshot.name),
      id: meSnapshot?.id || null,
      name: meSnapshot?.name || null,
      link_karma: meSnapshot?.link_karma || null,
      comment_karma: meSnapshot?.comment_karma || null,
      total_karma: meSnapshot?.total_karma || null,
      has_verified_email: meSnapshot?.has_verified_email || false,
      is_gold: meSnapshot?.is_gold || false,
      is_mod: meSnapshot?.is_mod || false,
      created_utc: meSnapshot?.created_utc || null,
      _http_status: meSnapshot?._http_status || null,
      _error: meSnapshot?._error || null,
    } : null,
    oauth_token_present: !!oauthToken,
    oauth_token_preview: oauthToken ? `${oauthToken.slice(0, 8)}…${oauthToken.slice(-4)}` : null,
  };

  const durationMs = Date.now() - startedAt;
  await pool.query(
    `UPDATE reddit_scrape_jobs
        SET status='succeeded', completed_at=NOW(), duration_ms=$2,
            cookies_count=$3, oauth_token_present=$4, meta_snapshot=$5,
            proxy_url_snapshot=$6, user_agent=$7
      WHERE id=$1`,
    [jobId, durationMs, cookies.length, !!oauthToken, meta, proxySnapshot, userAgent]
  );

  await pool.query(
    `UPDATE reddit_accounts
        SET status='ok', status_message=NULL,
            last_scraped_at=NOW(), last_successful_at=NOW(),
            last_job_id=$2, metadata=$3, updated_at=NOW()
      WHERE id=$1`,
    [account.id, jobId, meta.me_endpoint || {}]
  );

  return { jobId, cookiesCount: cookies.length, meta };
}

async function _failJob(jobId, accountId, code, message, startedAt, _jar, proxySnapshot, userAgent) {
  const durationMs = Date.now() - startedAt;
  await pool.query(
    `UPDATE reddit_scrape_jobs
        SET status='failed', completed_at=NOW(), duration_ms=$2,
            error_code=$3, error_message=$4,
            proxy_url_snapshot=$5, user_agent=$6
      WHERE id=$1`,
    [jobId, durationMs, code, message, proxySnapshot, userAgent]
  );
  const accountStatus = code === 'wrong_otp' ? 'needs_2fa'
    : code === 'captcha_required' ? 'needs_captcha'
    : code === 'account_locked' ? 'locked'
    : 'error';
  await pool.query(
    `UPDATE reddit_accounts
        SET status=$2, status_message=$3, last_scraped_at=NOW(),
            last_job_id=$4, updated_at=NOW()
      WHERE id=$1`,
    [accountId, accountStatus, `${code}: ${message}`.slice(0, 4000), jobId]
  );
  logger.warn('[reddit-scrape] job %s failed: %s — %s', jobId, code, message);
  return { jobId, cookiesCount: 0, error: { code, message } };
}

async function _loadProxy(proxyId) {
  const { rows } = await pool.query(
    `SELECT id, host, port, protocol, username, password_enc, secret
       FROM proxies
      WHERE id = $1`,
    [proxyId]
  );
  return rows[0] || null;
}

function _commonHeaders(userAgent, referer) {
  return {
    'user-agent': userAgent,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'upgrade-insecure-requests': '1',
    ...(referer ? { referer } : {}),
  };
}

async function _performLogin({ jar, dispatcher, username, password, totpSecret, userAgent }) {
  // 1. Visit the login page so Reddit hands us the initial edge / csv / token cookies.
  await _httpRequest({
    method: 'GET',
    url: 'https://www.reddit.com/login/',
    headers: _commonHeaders(userAgent, 'https://www.reddit.com/'),
    jar,
    dispatcher,
  });

  // 2. POST credentials to the legacy login JSON endpoint. This works for
  //    both 2FA-enabled and 2FA-disabled accounts; if 2FA is enabled and
  //    no `otp` is provided Reddit responds with `WRONG_PASSWORD` and
  //    field=otp inside `json.errors`.
  let body = new URLSearchParams({
    user: username,
    passwd: password,
    api_type: 'json',
    dest: 'https://www.reddit.com/',
    rem: 'on',
  });
  if (totpSecret) {
    body.set('otp', totp(totpSecret));
  }

  const loginUrl = `https://www.reddit.com/api/login/${encodeURIComponent(username)}`;
  const loginResp = await _httpRequest({
    method: 'POST',
    url: loginUrl,
    headers: {
      ..._commonHeaders(userAgent, 'https://www.reddit.com/login/'),
      'content-type': 'application/x-www-form-urlencoded',
      'origin': 'https://www.reddit.com',
      'x-requested-with': 'XMLHttpRequest',
    },
    body: body.toString(),
    jar,
    dispatcher,
  });

  // 3. Parse the JSON response and surface domain-specific error codes.
  let parsed;
  try {
    parsed = JSON.parse(loginResp.body);
  } catch (_e) {
    if (loginResp.status === 403 || /captcha/i.test(loginResp.body)) {
      const err = new Error('captcha required by Reddit');
      err.code = 'captcha_required';
      throw err;
    }
    if (loginResp.status === 429) {
      const err = new Error('Reddit rate-limited the login request (429)');
      err.code = 'rate_limited';
      throw err;
    }
    const err = new Error(`unexpected non-JSON login response (HTTP ${loginResp.status})`);
    err.code = 'login_unknown';
    throw err;
  }

  const errs = parsed?.json?.errors || [];
  if (errs.length > 0) {
    const first = errs[0];
    const code = String(first[0] || '').toLowerCase();
    const detail = String(first[1] || '').slice(0, 4000);
    const field = String(first[2] || '');
    if (code === 'incorrect_username_password' || code === 'wrong_password') {
      // 2FA accounts return WRONG_PASSWORD with field='otp' when the
      // OTP was missing or wrong.
      if (field === 'otp') {
        const err = new Error('Reddit demanded a TOTP/SMS code — store the TOTP secret on the account row');
        err.code = totpSecret ? 'wrong_otp' : 'totp_required';
        throw err;
      }
      const err = new Error('Reddit rejected the credentials (WRONG_PASSWORD)');
      err.code = 'wrong_credentials';
      throw err;
    }
    if (code === 'rate_limit') {
      const err = new Error(detail || 'Reddit rate-limited the login');
      err.code = 'rate_limited';
      throw err;
    }
    if (code === 'bad_captcha' || /captcha/i.test(code)) {
      const err = new Error('Reddit demanded a CAPTCHA — solve interactively in a browser, then retry');
      err.code = 'captcha_required';
      throw err;
    }
    if (code === 'suspended' || code === 'locked' || code === 'account_locked') {
      const err = new Error(detail || 'Reddit reports the account as suspended/locked');
      err.code = 'account_locked';
      throw err;
    }
    if (code === 'wrong_otp' || code === 'invalid_otp') {
      const err = new Error('Reddit rejected the OTP — the stored TOTP secret is wrong or out of sync');
      err.code = 'wrong_otp';
      throw err;
    }
    const err = new Error(`Reddit login failed: ${code}${detail ? ' — ' + detail : ''}`);
    err.code = `login_failed_${code || 'unknown'}`;
    throw err;
  }

  return {
    modhash: parsed?.json?.data?.modhash || null,
    cookie: parsed?.json?.data?.cookie || null,
    need_https: !!parsed?.json?.data?.need_https,
  };
}

async function _crawlFollowups({ jar, dispatcher, userAgent, hostsVisited }) {
  const urls = [
    'https://www.reddit.com/',
    'https://www.reddit.com/prefs/',
    'https://old.reddit.com/',
    'https://old.reddit.com/api/me.json',
    'https://chat.reddit.com/',
    'https://gateway.reddit.com/desktopapi/v1/prefs',
    'https://oauth.reddit.com/api/v1/me',
    'https://accounts.reddit.com/',
  ];
  for (const u of urls) {
    try {
      await _followRedirects({
        url: u,
        method: 'GET',
        headers: _commonHeaders(userAgent, 'https://www.reddit.com/'),
      }, jar, dispatcher);
      try { hostsVisited.push(new URL(u).hostname); } catch (_e) { /* */ }
    } catch (_e) {
      // crawl is best-effort; skip dead endpoints.
    }
  }
}

async function _persistCookies(jobId, accountId, cookies) {
  if (!cookies.length) return;
  const inserts = [];
  for (const c of cookies) {
    const valueEnc = encrypt(c.value || '');
    const hash = crypto.createHash('sha256').update(c.value || '').digest('hex');
    inserts.push(pool.query(
      `INSERT INTO reddit_cookies
         (account_id, job_id, name, value_enc, value_hash, value_len, domain, path,
          expires_at, max_age, http_only, secure, same_site, host_only, source_url, set_cookie)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        accountId, jobId,
        c.name, valueEnc, hash, (c.value || '').length,
        c.domain, c.path || '/',
        c.expires_at, c.max_age,
        !!c.http_only, !!c.secure, c.same_site || null, !!c.host_only,
        c.source_url || null, c.set_cookie || null,
      ]
    ));
  }
  await Promise.all(inserts);
}

module.exports = {
  // CRUD
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  // Jobs
  listJobs,
  getJob,
  createJobRow,
  // Cookies
  listCookies,
  // Worker entrypoint
  executeJob,
  // Exported for tests
  _internals: { parseSetCookie, CookieJar },
};
