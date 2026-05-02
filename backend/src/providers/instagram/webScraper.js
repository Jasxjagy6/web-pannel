/**
 * Cookie-based Instagram web scraper.
 *
 * Why this exists:
 * The mobile `instagram-private-api` SDK is what the panel uses by
 * default, but IG's mobile API checks the *device* + *IP* of every
 * request. When the panel runs on a data-centre IP, mobile API calls
 * (even with valid `sessionid` cookies) reliably trigger
 * `checkpoint_required` because IG considers the request "from a new
 * device". The web GraphQL/REST endpoints under `www.instagram.com`
 * don't enforce the same check — they trust the `sessionid` cookie
 * directly — so cookie-uploaded sessions can scrape via the web
 * surface even from a panel host that the mobile API would block.
 *
 * The scrape provider switches to this module whenever
 * `platform_state.source === 'browser_cookies'` (set by
 * cookieAdapter on upload).
 *
 * Endpoints used:
 *   GET /api/v1/users/web_profile_info/?username=<u>
 *       resolves a username to its `pk` and a few profile fields.
 *   GET /api/v1/friendships/<pk>/followers/?count=N&max_id=<cursor>
 *   GET /api/v1/friendships/<pk>/following/?count=N&max_id=<cursor>
 *       paginated friend lists. Each user record includes pk,
 *       username, full_name, is_private, is_verified, profile_pic_url.
 *
 * Required cookies (rejected upload if missing): sessionid, csrftoken,
 * ds_user_id.
 */

const logger = require('../../utils/logger');

const WEB_APP_ID = '936619743392459';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

/**
 * Build a `Cookie:` header from the cookies stored on the session row.
 *
 * Accepts the panel's canonical session blob shape (tough-cookie jar)
 * OR a raw browser-cookie array — same as cookieAdapter — so the
 * function is reusable from other call sites.
 */
function _cookieHeaderFromBlob(blob) {
  if (!blob) return { header: '', csrftoken: null };
  let entries = [];
  // The panel's canonical session blob nests the tough-cookie jar
  // under `cookies` — { cookies: { version, storeType, cookies: [...] } }.
  // Browser-export uploads come in as either a flat array or
  // { cookies: [...] }. Walk both shapes to find the actual cookie list.
  let raw = null;
  if (Array.isArray(blob)) {
    raw = blob;
  } else if (blob.cookies && Array.isArray(blob.cookies)) {
    raw = blob.cookies;
  } else if (blob.cookies && Array.isArray(blob.cookies.cookies)) {
    raw = blob.cookies.cookies;
  }
  if (Array.isArray(raw)) {
    entries = raw.map((c) => ({
      name: c.key || c.name,
      value: c.value,
      domain: (c.domain || '').toLowerCase(),
    }));
  }
  let csrftoken = null;
  const parts = [];
  for (const e of entries) {
    if (!e.name) continue;
    const dom = e.domain.replace(/^\./, '');
    if (dom && !dom.endsWith('instagram.com')) continue;
    if (e.name === 'csrftoken') csrftoken = e.value;
    parts.push(`${e.name}=${e.value}`);
  }
  return { header: parts.join('; '), csrftoken };
}

function _baseHeaders(csrftoken, referer) {
  return {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'x-ig-app-id': WEB_APP_ID,
    'x-csrftoken': csrftoken || '',
    'x-requested-with': 'XMLHttpRequest',
    'user-agent': DEFAULT_USER_AGENT,
    referer: referer || 'https://www.instagram.com/',
  };
}

/**
 * Promise-based jittered sleep used between feed pages so we look like
 * a human scrolling instead of a script.
 */
function _jitterSleep(minMs = 1500, maxMs = 3000) {
  const ms = Math.floor(minMs + Math.random() * Math.max(1, maxMs - minMs));
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Map an HTTP status / body to a clean error so the caller can surface
 * a 4xx instead of a generic 500.
 */
function _httpToError(status, body) {
  const e = new Error();
  if (status === 401 || status === 403) {
    e.message = 'Instagram session is no longer logged in. Re-upload a fresh session.';
    e.statusCode = 401;
  } else if (status === 404) {
    e.message = 'Target Instagram username not found.';
    e.statusCode = 404;
  } else if (status === 429) {
    e.message = 'Instagram is rate-limiting this session. Slow down and try again in a few minutes.';
    e.statusCode = 429;
  } else if (/checkpoint_required/i.test(body || '')) {
    e.message = 'Instagram is blocking this session with a checkpoint. Solve the checkpoint on a trusted device, then re-upload.';
    e.statusCode = 401;
  } else if (/login_required/i.test(body || '')) {
    e.message = 'Instagram session is no longer logged in. Re-upload a fresh session.';
    e.statusCode = 401;
  } else {
    e.message = `Instagram web API returned HTTP ${status}: ${(body || '').slice(0, 200)}`;
    e.statusCode = 502;
  }
  return e;
}

async function getUserIdByUsername(blob, username) {
  const { header, csrftoken } = _cookieHeaderFromBlob(blob);
  if (!header) {
    const e = new Error('Session has no cookies');
    e.statusCode = 401;
    throw e;
  }
  const u = encodeURIComponent(String(username).replace(/^@/, '').toLowerCase());
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${u}`;
  const r = await fetch(url, {
    headers: {
      cookie: header,
      ..._baseHeaders(csrftoken, `https://www.instagram.com/${u}/`),
    },
  });
  const body = await r.text();
  if (!r.ok) throw _httpToError(r.status, body);
  let json;
  try { json = JSON.parse(body); } catch (_err) {
    throw _httpToError(r.status, body);
  }
  const user = json && json.data && json.data.user;
  if (!user || !user.id) {
    const e = new Error('Target Instagram username not found.');
    e.statusCode = 404;
    throw e;
  }
  return {
    pk: String(user.id),
    username: String(user.username || username).toLowerCase(),
    full_name: user.full_name || null,
    is_private: !!user.is_private,
    is_verified: !!user.is_verified,
    follower_count: user.edge_followed_by?.count ?? null,
    following_count: user.edge_follow?.count ?? null,
  };
}

/**
 * Generator: yields one page of `users` records at a time for the
 * followers (kind='followers') or following (kind='following') feed
 * of `targetPk`.
 *
 * Each yielded item is the raw user object IG returns:
 *   { pk, username, full_name, is_private, is_verified, profile_pic_url, ... }
 */
async function* paginateFriendList(blob, targetPk, kind, opts = {}) {
  if (!['followers', 'following'].includes(kind)) {
    throw new Error(`Unsupported kind: ${kind}`);
  }
  const { header, csrftoken } = _cookieHeaderFromBlob(blob);
  if (!header) {
    const e = new Error('Session has no cookies');
    e.statusCode = 401;
    throw e;
  }
  const pageSize = Math.max(1, Math.min(200, opts.pageSize || 50));
  const limit = Math.max(1, opts.limit || 1000);
  const referer = `https://www.instagram.com/${opts.targetUsername || 'i'}/${kind}/`;

  let nextMaxId = null;
  let yielded = 0;
  let pageNum = 0;
  while (true) {
    const params = new URLSearchParams({
      // IG's web /friendships/<pk>/followers endpoint enforces ~25
      // users per page regardless of `count`. We pass it anyway so
      // the URL looks like a real client; pagination uses next_max_id.
      count: String(pageSize),
      search_surface: 'follow_list_page',
    });
    if (nextMaxId) params.set('max_id', nextMaxId);
    const url = `https://www.instagram.com/api/v1/friendships/${encodeURIComponent(targetPk)}/${kind}/?${params}`;

    if (pageNum > 0) await _jitterSleep(1500, 3000); // anti-throttle
    const r = await fetch(url, {
      headers: {
        cookie: header,
        ..._baseHeaders(csrftoken, referer),
      },
    });
    const body = await r.text();
    if (!r.ok) throw _httpToError(r.status, body);
    let json;
    try { json = JSON.parse(body); } catch (_err) { throw _httpToError(r.status, body); }
    const users = Array.isArray(json.users) ? json.users : [];
    if (users.length === 0) {
      logger.info(`IG.webScraper.${kind}: no more users (page ${pageNum + 1})`);
      return;
    }
    for (const u of users) {
      yield u;
      yielded += 1;
      if (yielded >= limit) return;
    }
    pageNum += 1;
    // The web endpoint omits `next_max_id` (or sets `big_list:false`)
    // on the final page even when the per-page count is below the
    // requested page size, so trust IG's own end-of-list signal
    // rather than comparing users.length against pageSize.
    nextMaxId = json.next_max_id ? String(json.next_max_id) : null;
    if (!nextMaxId) return;
    if (pageNum >= 200) {
      logger.warn(`IG.webScraper.${kind}: bailing after ${pageNum} pages — likely runaway pagination`);
      return;
    }
  }
}

module.exports = {
  getUserIdByUsername,
  paginateFriendList,
  _cookieHeaderFromBlob,
};
