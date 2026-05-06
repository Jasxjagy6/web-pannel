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
 * Supported target types (all routed through `igFetch` so anti-ban
 * and proxy enforcement are uniform):
 *   - followers / following  → /friendships/{pk}/{kind}/
 *   - likers                 → /media/{mediaPk}/likers/
 *   - commenters             → /media/{mediaPk}/comments/      (deduped by user pk)
 *   - tagged                 → /usertags/{pk}/feed/            (yields post-owner users)
 *
 * All HTTP egress goes through `igFetch.js`, which handles:
 *   - per-session ProxyAgent (residential / mobile sticky IP)
 *   - browser-grade headers (UA, sec-ch, x-ig-app-id, csrftoken)
 *   - per-session token-bucket rate limit (sessionLimiter)
 *   - error classification (checkpoint / login_required / rate_limited / ...)
 */

const logger = require('../../utils/logger');
const { igFetch, sessionContext } = require('./igFetch');

// Instagram shortcode alphabet (URL-safe base64 minus padding).
// Used both ways: shortcode <-> media pk.
const _SHORTCODE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

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
 *
 * Async because `sessionContext` now persists pinned per-session web
 * fingerprint / locale on first use (Phase 1, B3).
 */
async function _resolveCtx(sessionOrBlob) {
  if (sessionOrBlob && (sessionOrBlob.id || sessionOrBlob.session_data)) {
    return sessionContext(sessionOrBlob);
  }
  // Treat as a raw cookie blob (no proxy binding). Use a deterministic
  // pinned fingerprint based on the blob's ds_user_id so repeated
  // calls with the same raw blob send the same UA.
  const { cookieHeaderFromBlob, pickWebFingerprint } = require('./igFetch');
  const { header, csrftoken, dsUserId } = cookieHeaderFromBlob(sessionOrBlob);
  return {
    sessionId: null,
    username: null,
    proxyUrl: null,
    cookieHeader: header,
    csrftoken,
    dsUserId,
    blob: sessionOrBlob,
    webFingerprint: pickWebFingerprint(`raw_${dsUserId || 'anon'}`),
    locale: { language: 'en_US', timezoneOffset: 0, regionHint: 'US' },
    apiMode: 'web',
  };
}

// ---------------------------------------------------------------------
// Shortcode <-> media-pk conversion (deterministic, no network).
// ---------------------------------------------------------------------

/**
 * Convert an Instagram shortcode (the bit in /p/<sc>/, /reel/<sc>/,
 * /tv/<sc>/) into the numeric media pk used by the API. Pure
 * function, no network. Returns a string so we don't lose precision
 * on >2^53 pks.
 */
function shortcodeToPk(shortcode) {
  if (!shortcode || typeof shortcode !== 'string') {
    throw new Error('shortcodeToPk: shortcode required');
  }
  let pk = 0n;
  for (const ch of shortcode) {
    const idx = _SHORTCODE_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`shortcodeToPk: invalid character '${ch}'`);
    pk = pk * 64n + BigInt(idx);
  }
  return pk.toString();
}

/**
 * Inverse of shortcodeToPk — useful for building back URLs from pk.
 */
function pkToShortcode(pk) {
  if (pk == null) throw new Error('pkToShortcode: pk required');
  let n = BigInt(pk);
  if (n < 0n) throw new Error('pkToShortcode: pk must be non-negative');
  if (n === 0n) return _SHORTCODE_ALPHABET[0];
  let out = '';
  while (n > 0n) {
    out = _SHORTCODE_ALPHABET[Number(n % 64n)] + out;
    n = n / 64n;
  }
  return out;
}

/**
 * Parse user input that may be a media URL, shortcode, or raw pk.
 * Returns `{ pk, shortcode, urlPath }` (urlPath is the canonical
 * `/p/<sc>/` referer path for that media).
 *
 * Accepted forms:
 *   - https://www.instagram.com/p/<sc>/?...
 *   - https://www.instagram.com/reel/<sc>/
 *   - https://instagram.com/tv/<sc>/
 *   - <sc> alone (alphanumeric incl. -/_, length 8-15)
 *   - 1234567890   (numeric pk)
 *   - 1234567890_42 (mobile-style media id with owner suffix → strip)
 */
function parseMediaInput(input) {
  if (input == null) throw new Error('parseMediaInput: input required');
  const s = String(input).trim();
  if (!s) throw new Error('parseMediaInput: input is empty');

  // Mobile-style "<pk>_<owner>" → take the leading pk.
  const underscored = s.match(/^(\d+)_\d+$/);
  if (underscored) {
    const pk = underscored[1];
    return { pk, shortcode: pkToShortcode(pk), urlPath: `/p/${pkToShortcode(pk)}/` };
  }

  // Pure numeric → treat as pk.
  if (/^\d{6,}$/.test(s)) {
    return { pk: s, shortcode: pkToShortcode(s), urlPath: `/p/${pkToShortcode(s)}/` };
  }

  // URL → extract shortcode.
  const urlMatch = s.match(/instagram\.com\/(?:p|reel|tv|reels)\/([A-Za-z0-9_-]+)/i);
  if (urlMatch) {
    const sc = urlMatch[1];
    return { pk: shortcodeToPk(sc), shortcode: sc, urlPath: `/p/${sc}/` };
  }

  // Bare shortcode.
  if (/^[A-Za-z0-9_-]{6,20}$/.test(s)) {
    return { pk: shortcodeToPk(s), shortcode: s, urlPath: `/p/${s}/` };
  }

  throw new Error(
    `parseMediaInput: cannot interpret '${input}' as an Instagram media reference. ` +
    `Pass a shortcode, a /p/<sc>/ URL, or a numeric media pk.`
  );
}

// ---------------------------------------------------------------------
// User lookup
// ---------------------------------------------------------------------

async function getUserIdByUsername(sessionOrBlob, username) {
  const ctx = await _resolveCtx(sessionOrBlob);
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
 * Resolve a media reference (shortcode/url/pk) to its numeric pk +
 * owner pk + caption. Calls `/api/v1/media/<pk>/info/` to validate
 * the media is reachable from this session, surfacing a clean 404 if
 * the post was deleted or hidden.
 */
async function getMediaInfo(sessionOrBlob, mediaInput) {
  const parsed = parseMediaInput(mediaInput);
  const ctx = await _resolveCtx(sessionOrBlob);
  if (!ctx.cookieHeader) {
    const e = new Error('Session has no cookies');
    e.statusCode = 401;
    throw e;
  }

  const url = `https://www.instagram.com/api/v1/media/${encodeURIComponent(parsed.pk)}/info/`;
  const referer = `https://www.instagram.com${parsed.urlPath}`;
  const json = await igFetch(ctx, url, { referer });
  const item = json && json.items && json.items[0];
  if (!item || !item.pk) {
    const e = new Error(`Instagram media not found: ${mediaInput}`);
    e.statusCode = 404;
    e.kind = 'not_found';
    throw e;
  }
  return {
    pk: String(item.pk),
    shortcode: parsed.shortcode,
    urlPath: parsed.urlPath,
    owner: item.user
      ? { pk: String(item.user.pk), username: item.user.username }
      : null,
    like_count: item.like_count ?? null,
    comment_count: item.comment_count ?? null,
    media_type: item.media_type ?? null,
  };
}

// ---------------------------------------------------------------------
// Followers / following
// ---------------------------------------------------------------------

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
  const ctx = await _resolveCtx(sessionOrBlob);
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

    if (pageNum > 0) await _jitterSleep(2000, 4500); // anti-throttle

    // Retry-with-backoff on transient throttles. Mid-pagination
    // `rate_limited` / `forbidden` / `network` errors used to abort
    // the whole job — and with a single session in the pool, there
    // was nowhere to fail over to. Retry up to 3 times with
    // exponential-with-jitter backoff before giving up.
    let json;
    let lastErr = null;
    const RETRYABLE = new Set(['rate_limited', 'forbidden', 'network', 'action_blocked']);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        json = await igFetch(ctx, url, { referer });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!RETRYABLE.has(err && err.kind)) {
          throw err;
        }
        const base = 30_000 * Math.pow(2, attempt); // 30s → 60s → 120s
        const jitter = Math.floor(Math.random() * 15_000);
        const wait = base + jitter;
        logger.warn(
          `IG.webScraper.${kind}: page ${pageNum + 1} hit ${err.kind} ` +
          `(attempt ${attempt + 1}/3). Sleeping ${Math.round(wait / 1000)}s before retry.`
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (lastErr) {
      // Surface a clean partial-success signal to the caller so the
      // job can be marked completed-with-warning instead of failed.
      if (yielded > 0) {
        const warn = new Error(
          `Instagram throttled mid-pagination after ${yielded} ${kind} ` +
          `(retried ${3} times). Returning partial result.`
        );
        warn.kind = lastErr.kind || 'rate_limited';
        warn.partial = true;
        warn.yielded = yielded;
        throw warn;
      }
      throw lastErr;
    }

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

// ---------------------------------------------------------------------
// Likers — single-shot, IG returns the full likers list (capped at ~1k
// by IG itself). No pagination cursor is exposed by the web API.
// ---------------------------------------------------------------------

/**
 * Generator: yields user records for everyone who liked `mediaPk`.
 *
 * IG caps this list at ~1000 unique likers regardless of the actual
 * like count. That's an IG-side limitation, not a client throttle —
 * scrape jobs targeting big posts will simply hit the cap and stop.
 */
async function* paginateMediaLikers(sessionOrBlob, mediaPk, opts = {}) {
  const ctx = await _resolveCtx(sessionOrBlob);
  if (!ctx.cookieHeader) {
    const e = new Error('Session has no cookies');
    e.statusCode = 401;
    throw e;
  }
  const limit = Math.max(1, opts.limit || 1000);
  const referer = opts.referer || `https://www.instagram.com${opts.urlPath || '/'}`;

  const url = `https://www.instagram.com/api/v1/media/${encodeURIComponent(mediaPk)}/likers/`;
  const json = await igFetch(ctx, url, { referer });
  const users = Array.isArray(json.users) ? json.users : [];
  let yielded = 0;
  for (const u of users) {
    yield u;
    yielded += 1;
    if (yielded >= limit) return;
  }
  logger.info(`IG.webScraper.likers: ${users.length} likers fetched (IG returns max ~1000 per media)`);
}

// ---------------------------------------------------------------------
// Commenters — paginated by max_id, but unique by user pk.
// ---------------------------------------------------------------------

/**
 * Generator: yields unique commenters for `mediaPk`. Iterates the
 * comments feed (which can return the same user multiple times when
 * they posted multiple comments) and deduplicates by user pk.
 */
async function* paginateMediaCommenters(sessionOrBlob, mediaPk, opts = {}) {
  const ctx = await _resolveCtx(sessionOrBlob);
  if (!ctx.cookieHeader) {
    const e = new Error('Session has no cookies');
    e.statusCode = 401;
    throw e;
  }
  const limit = Math.max(1, opts.limit || 1000);
  const referer = opts.referer || `https://www.instagram.com${opts.urlPath || '/'}`;

  const seen = new Set();
  let yielded = 0;
  let nextMinId = null;
  let nextMaxId = null;
  let pageNum = 0;

  while (true) {
    const params = new URLSearchParams({
      can_support_threading: 'true',
      // Anchor IG's pagination to the most recent comments; keeps the
      // request shape identical to the web client.
      permalink_enabled: 'false',
    });
    if (nextMaxId) params.set('max_id', nextMaxId);
    if (nextMinId && !nextMaxId) params.set('min_id', nextMinId);

    const url = `https://www.instagram.com/api/v1/media/${encodeURIComponent(mediaPk)}/comments/?${params}`;

    if (pageNum > 0) await _jitterSleep(2000, 4000); // wider — IG flags burst comment fetches
    const json = await igFetch(ctx, url, { referer });
    const comments = Array.isArray(json.comments) ? json.comments : [];
    if (comments.length === 0) {
      logger.info(`IG.webScraper.commenters: no more comments (page ${pageNum + 1})`);
      return;
    }
    for (const c of comments) {
      const u = c && c.user;
      if (!u || !u.pk) continue;
      const key = String(u.pk);
      if (seen.has(key)) continue;
      seen.add(key);
      yield u;
      yielded += 1;
      if (yielded >= limit) return;
    }
    pageNum += 1;
    // IG returns `next_max_id` for older pages and `next_min_id` for
    // newer ones. Walk older comments first.
    nextMaxId = json.next_max_id ? String(json.next_max_id) : null;
    if (!nextMaxId) {
      if (pageNum === 1 && json.next_min_id) {
        // Single-page response with newer-pointer only — already
        // emitted what we have.
      }
      return;
    }
    if (pageNum >= 60) {
      logger.warn(`IG.webScraper.commenters: bailing after ${pageNum} pages — likely runaway pagination`);
      return;
    }
  }
}

// ---------------------------------------------------------------------
// Tagged-in — paginated via /usertags/<pk>/feed/. Yields the *owner*
// of each media (i.e., the account that posted the photo tagging the
// target user). Useful for "who is tagging me" intelligence.
// ---------------------------------------------------------------------

/**
 * Generator: yields one user object per post that tags `targetPk`.
 *
 * The `user` field in IG's usertags feed is the **owner of the
 * media** (the account that posted the photo). For the panel's
 * scraped_users storage, we surface those owners as the "scraped"
 * users, deduped — this matches the Scrape page's "Posts tagging an
 * account" framing.
 *
 * Items are augmented with two synthetic fields so the caller can
 * link back to the source post:
 *
 *   { ...user, _media_shortcode, _media_pk }
 */
async function* paginateUserTags(sessionOrBlob, targetPk, opts = {}) {
  const ctx = await _resolveCtx(sessionOrBlob);
  if (!ctx.cookieHeader) {
    const e = new Error('Session has no cookies');
    e.statusCode = 401;
    throw e;
  }
  const limit = Math.max(1, opts.limit || 1000);
  const referer = `https://www.instagram.com/${opts.targetUsername || 'i'}/tagged/`;
  const dedupe = opts.dedupe !== false;

  const seen = new Set();
  let yielded = 0;
  let nextMaxId = null;
  let pageNum = 0;

  while (true) {
    const params = new URLSearchParams({ count: '12' });
    if (nextMaxId) params.set('max_id', nextMaxId);

    const url = `https://www.instagram.com/api/v1/usertags/${encodeURIComponent(targetPk)}/feed/?${params}`;

    if (pageNum > 0) await _jitterSleep(2000, 4500);
    const json = await igFetch(ctx, url, { referer });
    const items = Array.isArray(json.items) ? json.items : [];
    if (items.length === 0) {
      logger.info(`IG.webScraper.tagged: no more items (page ${pageNum + 1})`);
      return;
    }
    for (const it of items) {
      const owner = it && it.user;
      if (!owner || !owner.pk) continue;
      const key = String(owner.pk);
      if (dedupe && seen.has(key)) continue;
      if (dedupe) seen.add(key);
      // Augment with media identifiers so the caller can build a
      // back-link if it wants.
      const code = it.code || (it.pk ? pkToShortcode(it.pk) : null);
      yield Object.assign({}, owner, {
        _media_shortcode: code,
        _media_pk: it.pk ? String(it.pk) : null,
      });
      yielded += 1;
      if (yielded >= limit) return;
    }
    pageNum += 1;
    nextMaxId = json.next_max_id ? String(json.next_max_id) : null;
    if (!nextMaxId || !json.more_available) return;
    if (pageNum >= 200) {
      logger.warn(`IG.webScraper.tagged: bailing after ${pageNum} pages — likely runaway pagination`);
      return;
    }
  }
}

module.exports = {
  // user lookup
  getUserIdByUsername,
  getMediaInfo,
  // generators
  paginateFriendList,
  paginateMediaLikers,
  paginateMediaCommenters,
  paginateUserTags,
  // utilities
  parseMediaInput,
  shortcodeToPk,
  pkToShortcode,
};
