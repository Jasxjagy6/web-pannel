/**
 * Cookie format adapter for Instagram session uploads.
 *
 * The panel's native `upload-session` payload is:
 *   { username, sessionBlob: { cookies: <tough-cookie jar JSON>,
 *                              deviceString, deviceId, uuid, phoneId, adid, build },
 *     proxyUrl? }
 *
 * However users commonly export IG cookies from a browser extension
 * (Cookie-Editor, EditThisCookie, Firefox JSON export, etc.). Those
 * exports are a flat array of cookie records:
 *   [ { name, value, domain, path, secure, httpOnly, sameSite,
 *       hostOnly, expirationDate, ... }, ... ]
 *
 * This adapter:
 *   1. Detects whether an uploaded JSON document is a browser-cookie
 *      array (or { cookies: [...] } wrapper).
 *   2. Builds an instagram-private-api-compatible tough-cookie jar JSON
 *      that the IG client can later restore via deserializeCookieJar.
 *   3. Restores an IG client from those cookies, calls
 *      `client.account.currentUser()` to resolve the IG `pk` and
 *      `username` of the session owner. That username becomes the
 *      session row's display name.
 *   4. Serializes the resulting state (cookies + device fingerprint)
 *      into the panel's canonical sessionBlob shape so the rest of
 *      the upload/registerSession flow is unchanged.
 */

const logger = require('../../utils/logger');

const IG_COOKIE_DOMAINS = new Set([
  'instagram.com',
  '.instagram.com',
  'i.instagram.com',
  'www.instagram.com',
]);

const REQUIRED_AUTH_COOKIES = ['sessionid', 'ds_user_id', 'csrftoken'];

function _isBrowserCookieRecord(rec) {
  if (!rec || typeof rec !== 'object') return false;
  return typeof rec.name === 'string' && typeof rec.value === 'string';
}

/**
 * Returns true if `parsed` looks like a raw browser cookie export
 * rather than the panel's native { username, sessionBlob } record.
 */
function looksLikeBrowserCookies(parsed) {
  if (Array.isArray(parsed) && parsed.every(_isBrowserCookieRecord)) {
    return true;
  }
  if (parsed && typeof parsed === 'object'
      && Array.isArray(parsed.cookies)
      && parsed.cookies.every(_isBrowserCookieRecord)) {
    return true;
  }
  return false;
}

function _normaliseCookieArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.cookies)) return parsed.cookies;
  return [];
}

/**
 * Translate a browser cookie array into a tough-cookie jar JSON
 * that `client.state.deserializeCookieJar(...)` accepts.
 *
 * Returns { cookies: <jarJson>, dsUserId: string|null }.
 */
function browserCookiesToJar(cookieArr) {
  const cookies = [];
  let dsUserId = null;

  const nowIso = new Date().toISOString();
  for (const c of cookieArr) {
    if (!c || !c.name) continue;

    let domain = (c.domain || '').toLowerCase();
    if (domain.startsWith('.')) domain = domain.slice(1);
    if (!domain) domain = 'instagram.com';
    // Only keep cookies that are actually in the Instagram cookie scope.
    // Cross-domain noise (e.g. facebook.com) would just be wasted bytes.
    if (!IG_COOKIE_DOMAINS.has(domain) && !domain.endsWith('instagram.com')) {
      continue;
    }

    if (c.name === 'ds_user_id' && typeof c.value === 'string') {
      dsUserId = c.value;
    }

    let expires;
    if (typeof c.expirationDate === 'number' && Number.isFinite(c.expirationDate)) {
      expires = new Date(c.expirationDate * 1000).toISOString();
    }

    cookies.push({
      key: c.name,
      value: typeof c.value === 'string' ? c.value : String(c.value ?? ''),
      domain,
      path: c.path || '/',
      hostOnly: !!c.hostOnly,
      secure: c.secure !== false,
      httpOnly: !!c.httpOnly,
      ...(expires ? { expires } : {}),
      creation: nowIso,
      lastAccessed: nowIso,
    });
  }

  return {
    jar: {
      version: 'tough-cookie@2.5.0',
      storeType: 'MemoryCookieStore',
      rejectPublicSuffixes: true,
      cookies,
    },
    dsUserId,
  };
}

/**
 * Validate that the cookies look authenticated. Returns a missing-cookie
 * list (empty if all required auth cookies are present).
 */
function findMissingAuthCookies(cookieArr) {
  const haveByName = new Set();
  for (const c of cookieArr) {
    if (c && c.name) haveByName.add(c.name);
  }
  return REQUIRED_AUTH_COOKIES.filter((n) => !haveByName.has(n));
}

/**
 * Build a panel-canonical sessionBlob from a browser cookies export by
 * spinning up a temporary IgApiClient, restoring the cookies, calling
 * currentUser() to resolve the IG username for the row, and
 * serialising the device fingerprint + cookies back into the standard
 * blob shape.
 *
 * Throws AppError-shaped errors with statusCode set so the upload
 * controller surfaces a clean 4xx to the user instead of a 500.
 */
async function buildSessionFromBrowserCookies(parsed, opts = {}) {
  const cookieArr = _normaliseCookieArray(parsed);
  if (cookieArr.length === 0) {
    const e = new Error('Cookie export is empty');
    e.statusCode = 400;
    throw e;
  }

  const missing = findMissingAuthCookies(cookieArr);
  if (missing.length) {
    const e = new Error(
      `Cookie export is missing required Instagram auth cookies: ${missing.join(', ')}. ` +
      'Make sure you exported cookies while logged in to instagram.com.'
    );
    e.statusCode = 400;
    throw e;
  }

  const { jar, dsUserId } = browserCookiesToJar(cookieArr);

  // eslint-disable-next-line global-require
  const ig = require('instagram-private-api');
  const client = new ig.IgApiClient();

  // Stable device fingerprint per ds_user_id so reconnects don't reroll.
  client.state.generateDevice(dsUserId ? `ig_${dsUserId}` : `ig_uploaded_${Date.now()}`);
  if (opts.proxyUrl) client.state.proxyUrl = opts.proxyUrl;

  await client.state.deserializeCookieJar(JSON.stringify(jar));

  // Resolve username via the authenticated mobile API. This call also
  // doubles as a "session is alive" probe — but it can fail with
  // `checkpoint_required` when IG sees the panel host as a "new
  // device from a data centre" (see prompts.txt §7). That doesn't
  // necessarily mean the cookies are dead — public endpoints
  // (web profile info, followers/following) often still work — so
  // we degrade gracefully: warn, fall back to a ds_user_id-based
  // placeholder username, and let the scrape path try the real API.
  // Hard `login_required` is the only signal that the cookies are
  // truly invalid.
  let username = (opts.username || '').toLowerCase() || null;
  let igPk = dsUserId ? Number(dsUserId) : null;
  let probeWarning = null;
  try {
    const me = await client.account.currentUser();
    if (me && me.username) username = String(me.username).toLowerCase();
    if (me && me.pk) igPk = Number(me.pk);
  } catch (err) {
    const msg = (err && err.message) || 'currentUser() failed';
    const isLoginRequired = /login_required|unauthor/i.test(msg)
      && !/checkpoint/i.test(msg);
    if (isLoginRequired) {
      const e = new Error(
        'Uploaded cookies are not a logged-in Instagram session. ' +
        `Instagram replied: ${msg}`
      );
      e.statusCode = 401;
      throw e;
    }
    probeWarning = msg;
    logger.warn(`IG.cookieAdapter: currentUser() probe failed (${msg}); falling back to web API user-info endpoint`);
    // The mobile API can't get past the data-centre checkpoint, but
    // the web `/api/v1/users/<pk>/info/` endpoint trusts cookies and
    // returns the same username/full_name. Try that before falling
    // back to a synthetic `ig_<pk>` placeholder.
    if (!username && dsUserId) {
      try {
        const cookieHeader = cookieArr
          .filter((c) => {
            const dom = (c.domain || '').toLowerCase().replace(/^\./, '');
            return !dom || dom.endsWith('instagram.com');
          })
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');
        const csrfCookie = cookieArr.find((c) => c.name === 'csrftoken');
        const r = await fetch(
          `https://www.instagram.com/api/v1/users/${encodeURIComponent(dsUserId)}/info/`,
          {
            headers: {
              cookie: cookieHeader,
              'x-ig-app-id': '936619743392459',
              'x-csrftoken': (csrfCookie && csrfCookie.value) || '',
              'user-agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 ' +
                'Safari/537.36',
              referer: 'https://www.instagram.com/',
            },
          }
        );
        if (r.ok) {
          const j = await r.json();
          if (j && j.user && j.user.username) {
            username = String(j.user.username).toLowerCase();
            logger.info(`IG.cookieAdapter: resolved username via web API: ${username}`);
          }
        } else {
          logger.warn(`IG.cookieAdapter: web user-info probe HTTP ${r.status}`);
        }
      } catch (webErr) {
        logger.warn(`IG.cookieAdapter: web user-info probe failed: ${webErr.message}`);
      }
    }
    if (!username) username = dsUserId ? `ig_${dsUserId}` : `ig_uploaded_${Date.now()}`;
  }

  // Serialise the now-restored client state into the panel's canonical
  // sessionBlob shape. Going through the client (rather than embedding
  // the jar JSON we built directly) ensures any tough-cookie field
  // normalisation is consistent with what the rest of the panel
  // expects.
  //
  // `serializeCookieJar()` returns an already-parsed object in
  // instagram-private-api 1.46.x (despite the name), so don't JSON.parse
  // the result. We only stringify on the way back out via the encrypt
  // step in registerSession.
  const serializedJar = await client.state.serializeCookieJar();
  const cookies = typeof serializedJar === 'string'
    ? JSON.parse(serializedJar)
    : serializedJar;
  const sessionBlob = {
    cookies,
    deviceString: client.state.deviceString,
    deviceId: client.state.deviceId,
    uuid: client.state.uuid,
    phoneId: client.state.phoneId,
    adid: client.state.adid,
    build: client.state.build,
  };

  return {
    username,
    sessionBlob,
    platformState: {
      source: 'browser_cookies',
      ig_pk: igPk,
      uploaded_at: new Date().toISOString(),
      ...(probeWarning ? { probe_warning: probeWarning } : {}),
    },
  };
}

module.exports = {
  looksLikeBrowserCookies,
  browserCookiesToJar,
  findMissingAuthCookies,
  buildSessionFromBrowserCookies,
};
