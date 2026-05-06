/**
 * Instagram client pool — analog of TelegramService for Instagram.
 *
 * Owns a Map<sessionId, IgApiClient> keyed by the per-row session id,
 * exposes `getClient(session)` / `releaseClient(sessionId)` so the per-
 * feature subsystems (scrape, messaging, threads, ...) reuse a logged-in
 * client across operations.
 *
 * Phase 1 hardening (anti-ban):
 *   - Every client is built via `clientFactory.createPinnedClient`, which
 *     overrides the bundled stale APP_VERSION (`222.0.0.13.114`, 2021)
 *     with one from `igAppVersions.json`, pins `state.language` /
 *     `state.timezoneOffset` to the per-session locale, and seeds
 *     `state.generateDevice` from the per-session seed (`identity.
 *     getOrCreateSeed`) — same seed across reconnects so deviceId /
 *     uuid / phoneId / adid / build never silently re-roll.
 *   - Cookie restore is atomic: if any required cookie (sessionid,
 *     ds_user_id, csrftoken) is missing after restore, throw an
 *     actionable error instead of letting the caller send requests
 *     with empty auth.
 *   - When `security.instagram.require_proxy` is true (default) and
 *     the session row has no `proxy_url`, throw `PROXY_REQUIRED`
 *     before returning the client. Data-centre IPs from the panel
 *     host trip checkpoint_required on the first request.
 *   - Cookie-uploaded sessions get `api_mode='web'` — the IgApiClient
 *     is still returned for the rare cases that need device-only
 *     state (e.g. building headers for igFetch), but the caller
 *     contract is "do NOT call mobile-API endpoints with this client".
 */

'use strict';

const logger = require('../../utils/logger');
const { encrypt, decrypt } = require('../../utils/crypto');
const { pool } = require('../../config/database');
const clientFactory = require('./clientFactory');

let _IgApiClient = null;
let _IgCheckpointError = null;
let _IgLoginTwoFactorRequiredError = null;

function _loadIgRuntime() {
  if (_IgApiClient) return;
  // eslint-disable-next-line global-require
  const ig = require('instagram-private-api');
  _IgApiClient = ig.IgApiClient;
  _IgCheckpointError = ig.IgCheckpointError;
  _IgLoginTwoFactorRequiredError = ig.IgLoginTwoFactorRequiredError;
}

const _clientPool = new Map(); // sessionId -> { client, lastUsed, warmed, apiMode }

function _now() { return Date.now(); }

const REQUIRED_AUTH_COOKIES = ['sessionid', 'ds_user_id', 'csrftoken'];

function _hasRequiredCookies(blob) {
  if (!blob) return false;
  let cookieList = [];
  if (blob.cookies && Array.isArray(blob.cookies.cookies)) {
    cookieList = blob.cookies.cookies;
  } else if (Array.isArray(blob.cookies)) {
    cookieList = blob.cookies;
  } else if (Array.isArray(blob)) {
    cookieList = blob;
  }
  const names = new Set();
  for (const c of cookieList) {
    const n = c && (c.key || c.name);
    if (n) names.add(n);
  }
  return REQUIRED_AUTH_COOKIES.every((n) => names.has(n));
}

async function _isProxyRequired() {
  // Lazy require avoids circular init issues during cold start.
  // eslint-disable-next-line global-require
  const settings = require('../../services/systemSettingsService');
  try {
    const v = await settings.getSetting('security.instagram.require_proxy');
    if (v === false || v === 'false') return false;
    return true; // default true — fail closed
  } catch (_err) {
    return true;
  }
}

/**
 * Return (or create) an IgApiClient for a given session row.
 *
 *   await provider.client.getClient(session) → IgApiClient
 *   await provider.client.getClient(session, { bypassProxy: true }) → IgApiClient
 *     built with proxyUrl=null and NOT cached, so subsequent normal
 *     calls still receive the proxied long-lived client.
 *
 * Restores cookies + per-session pinned device/locale/version state
 * from `session_data` and `platform_state.fingerprint`. Throws clean
 * errors if the session is missing a proxy (and one is required) or
 * if the cookie blob doesn't carry valid auth cookies.
 *
 * `opts.bypassProxy` is the per-call override used by scrape jobs that
 * the operator explicitly asked to run from the panel's egress IP.
 * The session row itself is not mutated; the bypass applies to this
 * call only.
 */
async function getClient(session, opts = {}) {
  _loadIgRuntime();
  if (!session || !session.id) {
    throw new Error('getClient(): session row required');
  }
  const bypassProxy =
    opts && opts.bypassProxy === true
      ? true
      : !!(session && session._bypassProxy === true);

  // Cache hit only honoured for the default (proxied) path. A
  // bypassProxy call always builds a fresh, non-cached client so
  // we never serve a no-proxy client to a later non-bypass caller.
  const cached = _clientPool.get(session.id);
  if (cached && cached.client && !bypassProxy) {
    cached.lastUsed = _now();
    return cached.client;
  }

  // Hydrate the per-session pinned slots (seed, appVersion, locale,
  // api_mode). This persists missing slots before returning so the
  // client we build now is the same one any other concurrent caller
  // would build.
  // eslint-disable-next-line global-require
  const identity = require('./identity');
  const pinned = await identity.getOrCreatePlatformState(session);

  // Proxy enforcement — data-centre egress is the #1 cause of
  // checkpoint_required on uploaded sessions. Skipped when the caller
  // explicitly asked to bypass proxy for this call (operator-driven
  // scrape from the panel IP).
  if (!bypassProxy && !session.proxy_url && (await _isProxyRequired())) {
    const e = new Error(
      `Instagram session ${session.id} (${session.username || ''}) has no proxy assigned. ` +
      `Direct egress from the panel host trips Instagram's data-centre filter on the first ` +
      `request. Assign a residential proxy via /api/proxies, untick "Use proxy" on the ` +
      `scrape form to run this single job from the panel IP, or disable ` +
      `security.instagram.require_proxy in system_settings to override globally.`
    );
    e.statusCode = 400;
    e.code = 'PROXY_REQUIRED';
    throw e;
  }

  const effectiveProxyUrl = bypassProxy ? null : (session.proxy_url || null);
  const { client, appVersion, locale } = clientFactory.createPinnedClient({
    seed: pinned.seed,
    appVersion: pinned.appVersion,
    locale: pinned.locale,
    proxyUrl: effectiveProxyUrl,
  });

  // Restore previous cookies + device blob if we have one. Atomic:
  // either every required cookie is present, or we refuse to use the
  // client (mark needs_attention).
  if (session.session_data) {
    let blob = null;
    try {
      const decrypted = decrypt(session.session_data);
      blob = JSON.parse(decrypted);
    } catch (err) {
      const e = new Error(
        `Failed to decrypt/parse Instagram session blob for sessionId=${session.id}: ${err.message}`
      );
      e.kind = 'login_required';
      e.statusCode = 401;
      throw e;
    }

    if (!_hasRequiredCookies(blob)) {
      const e = new Error(
        `Instagram session ${session.id} is missing required auth cookies ` +
        `(${REQUIRED_AUTH_COOKIES.join(', ')}). Re-upload a fresh cookie export.`
      );
      e.kind = 'login_required';
      e.statusCode = 401;
      // Best-effort flip the row so the operator sees it in the UI.
      try {
        await pool.query(
          `UPDATE sessions
              SET warmup_state = COALESCE(warmup_state, '{}'::jsonb)
                                 || jsonb_build_object(
                                      'state', 'needs_attention',
                                      'last_error', 'missing required auth cookies',
                                      'last_failed_at', NOW()::text),
                  updated_at = NOW()
            WHERE id = $1`,
          [session.id]
        );
      } catch (_e) { /* swallow */ }
      // Phase 3.B15 — record cookie_missing detection event so the
      // admin dashboard surfaces this distinct from network errors.
      try {
        // eslint-disable-next-line global-require
        const detectionEvents = require('./detectionEvents');
        detectionEvents.record({
          sessionId: session.id,
          userId: session.user_id || null,
          eventKind: 'cookie_missing',
          apiPath: 'client.getClient',
          httpStatus: 401,
          requestFingerprint: {
            api_mode: pinned.apiMode,
            app_version: appVersion && appVersion.app_version,
          },
        }).catch(() => {});
      } catch (_recErr) { /* swallow */ }
      throw e;
    }

    try {
      if (blob.cookies) {
        await client.state.deserializeCookieJar(JSON.stringify(blob.cookies));
      }
      // Restore the persisted device fields ONLY when they match the
      // pinned seed's regenerated fields (sanity: the persisted blob
      // was generated from the same seed, so these should agree). Out
      // of caution we always prefer the freshly-regenerated values
      // from the pinned seed — that's what guarantees stability across
      // process restarts even if the persisted blob ever drifts.
      // (No assignment here — keep the factory-generated values.)
    } catch (err) {
      const e = new Error(
        `Failed to restore Instagram cookie jar for sessionId=${session.id}: ${err.message}`
      );
      e.kind = 'login_required';
      e.statusCode = 401;
      // Phase 3.B17 — restore failure should mark the session
      // needs_attention rather than continuing with a partially
      // initialised cookie jar.
      try {
        await pool.query(
          `UPDATE sessions
              SET warmup_state = COALESCE(warmup_state, '{}'::jsonb)
                                 || jsonb_build_object(
                                      'state', 'needs_attention',
                                      'last_error', 'cookie restore failed: ' || $2::text,
                                      'last_failed_at', NOW()::text),
                  updated_at = NOW()
            WHERE id = $1`,
          [session.id, String(err.message || '').slice(0, 240)]
        );
      } catch (_e) { /* swallow */ }
      try {
        // eslint-disable-next-line global-require
        const detectionEvents = require('./detectionEvents');
        detectionEvents.record({
          sessionId: session.id,
          userId: session.user_id || null,
          eventKind: 'decrypt_failed',
          apiPath: 'client.deserializeCookieJar',
          httpStatus: 401,
          responseBody: String(err.message || '').slice(0, 240),
        }).catch(() => {});
      } catch (_recErr) { /* swallow */ }
      throw e;
    }
  }

  if (!bypassProxy) {
    _clientPool.set(session.id, {
      client,
      lastUsed: _now(),
      warmed: false,
      apiMode: pinned.apiMode,
      appVersion: appVersion.app_version,
      language: locale.language,
    });
  }

  logger.info(
    `IG.getClient sessionId=${session.id} username=${session.username} ` +
    `apiMode=${pinned.apiMode} appVersion=${appVersion.app_version} ` +
    `language=${locale.language} proxy=${effectiveProxyUrl ? 'yes' : (bypassProxy ? 'bypassed' : 'no')}`
  );
  return client;
}

/**
 * Persist the client state (cookies + device fingerprint) back to the DB
 * so the next process boot can reconnect without a fresh login.
 */
async function persistClientState(sessionId, client) {
  if (!client) return;
  const cookies = JSON.parse(await client.state.serializeCookieJar());
  const blob = {
    cookies,
    deviceString: client.state.deviceString,
    deviceId: client.state.deviceId,
    uuid: client.state.uuid,
    phoneId: client.state.phoneId,
    adid: client.state.adid,
    build: client.state.build,
  };
  const encrypted = encrypt(JSON.stringify(blob));
  await pool.query(
    `UPDATE sessions
        SET session_data = $1,
            updated_at = NOW()
      WHERE id = $2`,
    [encrypted, sessionId]
  );
}

/**
 * Forget a client (logout / explicit eviction).
 */
function releaseClient(sessionId) {
  _clientPool.delete(sessionId);
}

/**
 * For unit tests / admin tools.
 */
function poolSize() {
  return _clientPool.size;
}

/**
 * Best-effort ping. Used by sessions.heartbeat to mark expired/invalid
 * sessions in the DB.
 */
async function ping(client) {
  try {
    const me = await client.account.currentUser();
    return { ok: true, user: { pk: me.pk, username: me.username, full_name: me.full_name } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Type-guard re-exports so subsystems can do
 *   if (err instanceof igClient.IgCheckpointError) { ... }
 */
function isCheckpointError(err) {
  _loadIgRuntime();
  return err instanceof _IgCheckpointError;
}
function isTwoFactorError(err) {
  _loadIgRuntime();
  return err instanceof _IgLoginTwoFactorRequiredError;
}

/**
 * Tag the cached pool entry as warmed (used by the cold-start
 * simulation in B8 to avoid replaying the simulation on every call).
 */
function markWarmed(sessionId) {
  const e = _clientPool.get(sessionId);
  if (e) e.warmed = true;
}

function isWarmed(sessionId) {
  const e = _clientPool.get(sessionId);
  return !!(e && e.warmed);
}

function getApiMode(sessionId) {
  const e = _clientPool.get(sessionId);
  return e ? e.apiMode : null;
}

module.exports = {
  getClient,
  persistClientState,
  releaseClient,
  poolSize,
  ping,
  isCheckpointError,
  isTwoFactorError,
  markWarmed,
  isWarmed,
  getApiMode,
};
