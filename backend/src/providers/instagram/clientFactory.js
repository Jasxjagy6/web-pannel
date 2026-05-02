/**
 * IgApiClient factory — anti-ban hardening (Phase 1, B1+B4).
 *
 * The bundled `instagram-private-api@1.46.x` ships with hardcoded
 * APP_VERSION='222.0.0.13.114' and APP_VERSION_CODE='350696709' (from
 * Sept 2021). Every mobile-API request the panel sends is therefore
 * stamped with a User-Agent that no real Instagram phone has used in
 * years — the moment Instagram's risk model sees that UA on a logged-in
 * sessionid, it returns checkpoint_required. Plus the library's
 * default `state.timezoneOffset` derives from the host's local TZ
 * (always UTC inside our container) and `state.language` is fixed at
 * `en_US`, so every panel session looks identical and headquartered in
 * UTC, which is the canonical "data-centre fingerprint" pattern.
 *
 * This factory wraps `new IgApiClient()` and:
 *   1. Picks an APP_VERSION/CODE/BLOKS triple from a per-session pinned
 *      slot in `platform_state.appVersion`. New sessions choose one
 *      from `igAppVersions.json` based on the pinned device seed (so
 *      the choice is deterministic and stable across reconnects).
 *   2. Sets `state.language` and `state.timezoneOffset` from the
 *      session's pinned locale (`platform_state.locale`). Generates a
 *      coherent default at first use from the proxy URL or `en_US/0`.
 *   3. Calls `state.generateDevice(seed)` with the pinned seed (B2;
 *      see `identity.getOrCreateSeed`).
 *   4. Sets `state.proxyUrl` if the session has one bound.
 *
 * Returned client is otherwise a plain IgApiClient — every existing
 * call site (scrape, messaging, threads) keeps working without
 * modification.
 */

'use strict';

const crypto = require('crypto');
const igAppVersions = require('./igAppVersions.json');

let _IgApiClient = null;
function _loadIg() {
  if (_IgApiClient) return _IgApiClient;
  // eslint-disable-next-line global-require
  _IgApiClient = require('instagram-private-api').IgApiClient;
  return _IgApiClient;
}

// ---------------------------------------------------------------------
// App version pinning
// ---------------------------------------------------------------------

/**
 * Deterministically pick an entry from `igAppVersions.versions` based
 * on a stable seed (the per-session device seed). Same seed → same
 * version on every reconnect, so the account never silently "upgrades"
 * its mobile app between requests.
 */
function pickAppVersion(seed) {
  const versions = (igAppVersions && igAppVersions.versions) || [];
  if (versions.length === 0) {
    return {
      app_version: '222.0.0.13.114',
      app_version_code: '350696709',
      bloks_version_id: '009f03b18280bb343b0862d663f31ac80c5fb30dfae9df1c44d1eb19c3eef083',
      fb_analytics_application_id: '567067343352427',
    };
  }
  const h = crypto.createHash('sha256').update(String(seed || '')).digest();
  const idx = h.readUInt32BE(0) % versions.length;
  return versions[idx];
}

// ---------------------------------------------------------------------
// Locale + timezone pinning
// ---------------------------------------------------------------------

/**
 * Default locale derived from the proxy egress region (passed by
 * caller; we don't do GeoIP lookups here). Falls back to en_US.
 */
const _localeByRegion = {
  US: { language: 'en_US', timezoneOffset: -28800 },  // PST
  CA: { language: 'en_CA', timezoneOffset: -18000 },  // EST
  GB: { language: 'en_GB', timezoneOffset: 0 },
  DE: { language: 'de_DE', timezoneOffset: 3600 },
  FR: { language: 'fr_FR', timezoneOffset: 3600 },
  ES: { language: 'es_ES', timezoneOffset: 3600 },
  IT: { language: 'it_IT', timezoneOffset: 3600 },
  IN: { language: 'en_IN', timezoneOffset: 19800 },
  PK: { language: 'en_PK', timezoneOffset: 18000 },
  RU: { language: 'ru_RU', timezoneOffset: 10800 },
  TR: { language: 'tr_TR', timezoneOffset: 10800 },
  BR: { language: 'pt_BR', timezoneOffset: -10800 },
  MX: { language: 'es_MX', timezoneOffset: -21600 },
  AR: { language: 'es_AR', timezoneOffset: -10800 },
  JP: { language: 'ja_JP', timezoneOffset: 32400 },
  KR: { language: 'ko_KR', timezoneOffset: 32400 },
  ID: { language: 'id_ID', timezoneOffset: 25200 },
  PH: { language: 'en_PH', timezoneOffset: 28800 },
  AE: { language: 'en_AE', timezoneOffset: 14400 },
  SA: { language: 'ar_SA', timezoneOffset: 10800 },
  AU: { language: 'en_AU', timezoneOffset: 36000 },
};

/**
 * Build a coherent locale record from a region hint (or default).
 * Stable for the same input.
 */
function buildDefaultLocale(regionHint) {
  const region = String(regionHint || '').toUpperCase();
  const base = _localeByRegion[region] || _localeByRegion.US;
  return {
    language: base.language,
    timezoneOffset: base.timezoneOffset,
    regionHint: region in _localeByRegion ? region : 'US',
  };
}

// ---------------------------------------------------------------------
// Public — create + pin a client
// ---------------------------------------------------------------------

/**
 * Create a fresh IgApiClient with version + locale + device pinned.
 *
 * @param {object} pinned
 * @param {string} pinned.seed                 device-fingerprint seed
 * @param {object} [pinned.appVersion]         { app_version, app_version_code, bloks_version_id, fb_analytics_application_id }
 * @param {object} [pinned.locale]             { language, timezoneOffset, regionHint }
 * @param {string} [pinned.proxyUrl]
 * @returns {{ client, appVersion, locale }}
 */
function createPinnedClient(pinned = {}) {
  const IgApiClient = _loadIg();
  const client = new IgApiClient();

  const appVersion = pinned.appVersion || pickAppVersion(pinned.seed || 'fallback-seed');
  const locale = pinned.locale || buildDefaultLocale();

  // Override the bundled constants per-instance so we don't mutate the
  // shared `require('./core/constants')` object (other code in the same
  // process keeps the original values).
  const orig = client.state.constants;
  client.state.constants = Object.assign({}, orig, {
    APP_VERSION: appVersion.app_version,
    APP_VERSION_CODE: appVersion.app_version_code,
    BLOKS_VERSION_ID: appVersion.bloks_version_id,
    FACEBOOK_ANALYTICS_APPLICATION_ID:
      appVersion.fb_analytics_application_id || orig.FACEBOOK_ANALYTICS_APPLICATION_ID,
  });

  client.state.language = locale.language;
  client.state.timezoneOffset = String(locale.timezoneOffset);

  if (pinned.proxyUrl) {
    client.state.proxyUrl = pinned.proxyUrl;
  }

  // Device fingerprint is pinned by seed (B2 — caller is expected to
  // pass the same seed across reconnects so deviceId / uuid / phoneId /
  // adid / build never silently re-roll).
  if (pinned.seed) {
    client.state.generateDevice(pinned.seed);
  }

  return { client, appVersion, locale };
}

module.exports = {
  createPinnedClient,
  pickAppVersion,
  buildDefaultLocale,
};
