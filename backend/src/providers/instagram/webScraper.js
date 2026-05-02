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
 * All HTTP egress goes through `igFetch.js`, which handles:
 *   - per-session ProxyAgent (residential / mobile sticky IP)
 *   - browser-grade headers (UA, sec-ch, x-ig-app-id, csrftoken)
 *   - error classification (checkpoint / login_required / rate_limited / ...)
 */

const logger = require('../../utils/logger');
const { igFetch, sessionContext } = require('./igFetch');

/**
 * Promise-based jittered sleep used between feed pages so we look like
 * a human scrolling instead of a script.
 */
function _jitterSleep(minMs = 1500, maxMs = 3000) {
  const ms = Math.floor(minMs + Math.random() * Math.max(1, maxMs - minMs));
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a session context object from a session row OR from a raw
 * cookie blob (back-compat — the old API took a `blob` directly).
 */
function _resolveCtx(sessionOrBlob) {
  if (sessionOrBlob && (sessionOrBlob.id || sessionOrBlob.session_data)) {
    return sessionContext(sessionOrBlob);
  }
  // Treat as a raw cookie blob (no proxy binding).
  const { cookieHeaderFromBlob } = require('./igFetch');
  const { header, csrftoken, dsUserId } = cookieHeaderFromBlob(sessionOrBlob);
  return {
    sessionId: null,
    username: null,
    proxyUrl: null,
    cookieHeader: header,
    csrftoken,
    dsUserId,
    blob: sessionOrBlob,
  };
}

async function getUserIdByUsername(sessionOrBlob, username) {
  const ctx = _resolveCtx(sessionOrBlob);
  if (!ctx.cookieHeader) {
    const e = new Error('Session has no cookies');
    e.statusCode = 401;
    throw e;
  }
  const u = encodeURIComponent(String(username).replace(/^@/, '').toLowerCase());
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${u}`;
  const json = await igFetch(ctx, url, {
    referer: `https://www.instagram.com/${u}/`,
  });
  const user = json && json.data && json.data.user;
  if (!user || !user.id) {
    const e = new Error('Target Instagram username not found.');
    e.statusCode = 404;
    e.kind = 'not_found';
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
 * Generator: yields one user record at a time for the followers
 * (kind='followers') or following (kind='following') feed of
 * `targetPk`.
 *
 * Each yielded item is the raw user object IG returns:
 *   { pk, username, full_name, is_private, is_verified, profile_pic_url, ... }
 */
async function* paginateFriendList(sessionOrBlob, targetPk, kind, opts = {}) {
  if (!['followers', 'following'].includes(kind)) {
    throw new Error(`Unsupported kind: ${kind}`);
  }
  const ctx = _resolveCtx(sessionOrBlob);
  if (!ctx.cookieHeader) {
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
    const json = await igFetch(ctx, url, { referer });
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
};
