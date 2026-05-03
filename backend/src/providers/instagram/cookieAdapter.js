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

  // Phase 1 hardening: cookie-uploaded sessions are pinned api_mode='web'.
  // We MUST NOT call the mobile API (`client.account.currentUser()`)
  // during upload — that call goes to `i.instagram.com` with the
  // bundled stale IG app UA, against a sessionid issued by a real
  // browser, and reliably returns `checkpoint_required` from a panel
  // host. Instead we resolve username via the web `/api/v1/users/<pk>/info/`
  // endpoint, which trusts the sessionid cookie directly.
  //
  // We still build a temp IgApiClient (via clientFactory) to derive
  // the per-session pinned device fingerprint fields (deviceString /
  // deviceId / uuid / phoneId / adid / build) that are persisted in
  // the session blob — those are needed later for any code path that
  // does need device-flavoured headers, and they are deterministic
  // from the seed so they stay stable across reconnects.
  const seed = dsUserId ? `ig_${dsUserId}` : `ig_uploaded_${Date.now()}`;
  const clientFactory = require('./clientFactory');
  const webFingerprintsTable = require('./webFingerprints.json');
  const crypto = require('crypto');
  const { client, appVersion, locale } = clientFactory.createPinnedClient({
    seed,
    proxyUrl: opts.proxyUrl || null,
  });
  await client.state.deserializeCookieJar(JSON.stringify(jar));

  // Pick a deterministic web fingerprint at upload time. If the
  // browser-cookie export carries a `userAgent` sibling (Cookie-Editor
  // does this), prefer that exact UA so the pinned headers match the
  // browser the cookies were issued under. Otherwise fall back to a
  // deterministic pick from `webFingerprints.json` based on the seed.
  let pinnedWebFingerprint = null;
  if (opts.sourceUserAgent && typeof opts.sourceUserAgent === 'string') {
    pinnedWebFingerprint = {
      id: 'cookie_source_ua',
      userAgent: opts.sourceUserAgent,
      secChUa: opts.sourceSecChUa || null,
      secChUaMobile: opts.sourceSecChUaMobile || null,
      secChUaPlatform: opts.sourceSecChUaPlatform || null,
      acceptLanguage: opts.sourceAcceptLanguage || 'en-US,en;q=0.9',
      pinned_at: new Date().toISOString(),
    };
  } else {
    const profiles = webFingerprintsTable.profiles || [];
    const h = crypto.createHash('sha256').update(seed).digest();
    const idx = profiles.length === 0 ? 0 : h.readUInt32BE(0) % profiles.length;
    pinnedWebFingerprint = Object.assign(
      {},
      profiles[idx] || {},
      { pinned_at: new Date().toISOString() }
    );
  }

  let username = (opts.username || '').toLowerCase() || null;
  let igPk = dsUserId ? Number(dsUserId) : null;
  let probeWarning = null;

  // Resolve username via the web user-info endpoint. Uses the same
  // pinned web fingerprint we'll use for every subsequent request,
  // so IG sees one consistent client right from upload time.
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
      const headers = {
        cookie: cookieHeader,
        'x-ig-app-id': '936619743392459',
        'x-csrftoken': (csrfCookie && csrfCookie.value) || '',
        'user-agent': pinnedWebFingerprint.userAgent,
        'accept-language': pinnedWebFingerprint.acceptLanguage,
        referer: 'https://www.instagram.com/',
      };
      if (pinnedWebFingerprint.secChUa) headers['sec-ch-ua'] = pinnedWebFingerprint.secChUa;
      if (pinnedWebFingerprint.secChUaMobile) headers['sec-ch-ua-mobile'] = pinnedWebFingerprint.secChUaMobile;
      if (pinnedWebFingerprint.secChUaPlatform) headers['sec-ch-ua-platform'] = pinnedWebFingerprint.secChUaPlatform;

      const r = await fetch(
        `https://www.instagram.com/api/v1/users/${encodeURIComponent(dsUserId)}/info/`,
        { headers }
      );
      if (r.ok) {
        const j = await r.json();
        if (j && j.user && j.user.username) {
          username = String(j.user.username).toLowerCase();
          if (j.user.pk) igPk = Number(j.user.pk);
          logger.info(`IG.cookieAdapter: resolved username via web API: ${username}`);
        }
      } else if (r.status === 401 || r.status === 403) {
        probeWarning = `web user-info probe HTTP ${r.status}`;
        logger.warn(`IG.cookieAdapter: ${probeWarning}`);
      } else {
        probeWarning = `web user-info probe HTTP ${r.status}`;
        logger.warn(`IG.cookieAdapter: ${probeWarning}`);
      }
    } catch (webErr) {
      probeWarning = webErr.message;
      logger.warn(`IG.cookieAdapter: web user-info probe failed: ${webErr.message}`);
    }
  }
  if (!username) username = dsUserId ? `ig_${dsUserId}` : `ig_uploaded_${Date.now()}`;

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
      // Phase 1: pin api_mode, app version, locale, fingerprint seed
      // and web fingerprint at upload time so getClient() / igFetch()
      // / identity.getOrCreatePlatformState() never have to guess.
      api_mode: 'web',
      appVersion,
      locale,
      fingerprint: {
        seed,
        deviceId: client.state.deviceId,
        uuid: client.state.uuid,
        phoneId: client.state.phoneId,
        adid: client.state.adid,
        build: client.state.build,
        created_at: new Date().toISOString(),
      },
      webFingerprint: pinnedWebFingerprint,
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
