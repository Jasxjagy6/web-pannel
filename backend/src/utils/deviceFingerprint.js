/**
 * Device fingerprint pool — Anti-Detect Layer
 * --------------------------------------------------------------------
 * Telegram inspects (and remembers) the four init-connection fields:
 *   - deviceModel        e.g. "Samsung SM-G998B"
 *   - systemVersion      e.g. "Android 14"
 *   - appVersion         e.g. "10.10.1 (33212)"
 *   - langCode           e.g. "en"
 *   - systemLangCode     e.g. "en"
 *
 * If 100 sessions all login with `Mozilla/5.0 (X11; Linux x86_64)` the
 * spam detector trivially groups them as a single bot farm. So we keep
 * a pool of realistic profiles and assign one **persistently** to each
 * session — the same identity is replayed on every reconnect, because
 * a real phone never randomly changes its model between connections.
 *
 * The pool is grouped by platform; each platform has matching osVersion
 * + appVersion combinations that look like real Telegram client builds.
 *
 * Public API:
 *   pickRandomProfile()                  -> raw profile (deterministic seed
 *                                           via `pickByHash(seed)` if needed)
 *   buildIdentity(profile?, opts?)       -> {
 *                                              deviceModel, systemVersion,
 *                                              appVersion, langCode,
 *                                              systemLangCode, platform,
 *                                              profileId, generatedAt
 *                                            }
 *   randomLangFor(country)               -> 'en' | 'ru' | 'es' | ...
 *   listProfiles()                       -> [...all profiles]
 */

'use strict';

const crypto = require('crypto');

/**
 * App-version strings are kept slightly behind the absolute latest official
 * build so we don't ride the leading edge (which itself is a fingerprint).
 *
 * Sources (manually curated, generic):
 *   - Telegram Android: https://telegram.org/android/changelogs
 *   - Telegram iOS / TDesktop public release notes
 */
const PROFILES = [
  // ---------------- Android phones ----------------
  {
    id: 'android_pixel_8_pro',
    platform: 'android',
    deviceModels: ['Pixel 8 Pro', 'Pixel 8', 'Pixel 7 Pro', 'Pixel 7'],
    systemVersions: ['Android 14', 'Android 13', 'Android 14 SDK 34'],
    appVersions: ['10.14.0 (33212)', '10.13.3 (33189)', '10.12.0 (33150)'],
  },
  {
    id: 'android_samsung_s24',
    platform: 'android',
    deviceModels: [
      'Samsung SM-S928B',
      'Samsung SM-S921B',
      'Samsung SM-G998B',
      'Samsung SM-A546B',
    ],
    systemVersions: ['Android 14', 'Android 13', 'Android 12'],
    appVersions: ['10.13.0 (33189)', '10.11.0 (33098)', '10.9.1 (33042)'],
  },
  {
    id: 'android_xiaomi',
    platform: 'android',
    deviceModels: [
      'Xiaomi 23046PNC9G',
      'Xiaomi 2201117TG',
      'Redmi Note 12',
      'Redmi Note 11',
    ],
    systemVersions: ['Android 13', 'Android 12'],
    appVersions: ['10.12.0 (33150)', '10.10.1 (33075)', '10.8.2 (33013)'],
  },
  {
    id: 'android_oneplus',
    platform: 'android',
    deviceModels: ['OnePlus 11', 'OnePlus 10 Pro', 'OnePlus Nord 3'],
    systemVersions: ['Android 14', 'Android 13'],
    appVersions: ['10.13.3 (33189)', '10.11.0 (33098)'],
  },

  // ---------------- iPhones ----------------
  {
    id: 'ios_iphone_15',
    platform: 'ios',
    deviceModels: ['iPhone 15 Pro', 'iPhone 15', 'iPhone 15 Pro Max'],
    systemVersions: ['iOS 17.4', 'iOS 17.3.1', 'iOS 17.2.1', 'iOS 17.1.2'],
    appVersions: ['10.13', '10.12.1', '10.11.2'],
  },
  {
    id: 'ios_iphone_14',
    platform: 'ios',
    deviceModels: ['iPhone 14 Pro', 'iPhone 14', 'iPhone 14 Plus'],
    systemVersions: ['iOS 17.3.1', 'iOS 17.2.1', 'iOS 16.7.5', 'iOS 16.6.1'],
    appVersions: ['10.13', '10.12.1', '10.11.2', '10.10'],
  },
  {
    id: 'ios_iphone_13',
    platform: 'ios',
    deviceModels: ['iPhone 13 Pro', 'iPhone 13', 'iPhone 13 mini'],
    systemVersions: ['iOS 17.2.1', 'iOS 16.7.5', 'iOS 16.6.1'],
    appVersions: ['10.12.1', '10.11.2', '10.10'],
  },

  // ---------------- Desktop (TDesktop) ----------------
  {
    id: 'tdesktop_windows',
    platform: 'desktop',
    deviceModels: ['Desktop', 'Desktop PC', 'PC'],
    systemVersions: ['Windows 11', 'Windows 10', 'Windows 11 Pro 23H2'],
    appVersions: ['4.16.5 x64', '4.15.2 x64', '4.14.6 x64'],
  },
  {
    id: 'tdesktop_macos',
    platform: 'desktop',
    deviceModels: ['MacBook Pro', 'iMac', 'Mac Studio', 'Macbook Air'],
    systemVersions: ['macOS 14.4', 'macOS 14.3.1', 'macOS 13.6.5'],
    appVersions: ['10.13', '10.12.1', '10.11.2'],
  },
  {
    id: 'tdesktop_linux',
    platform: 'desktop',
    deviceModels: ['PC 64bit', 'Linux Desktop'],
    systemVersions: ['Ubuntu 22.04', 'Fedora 39', 'Arch Linux'],
    appVersions: ['4.16.5 x64', '4.15.2 x64'],
  },

  // ---------------- Web (Telegram Web K) ----------------
  {
    id: 'web_chrome',
    platform: 'web',
    deviceModels: ['Chrome', 'Chrome 121', 'Chrome 122'],
    systemVersions: ['Windows 11', 'macOS 14', 'Linux'],
    appVersions: ['1.7.0 K', '1.6.7 K', '1.6.5 K'],
  },
  {
    id: 'web_safari',
    platform: 'web',
    deviceModels: ['Safari', 'Safari 17.3'],
    systemVersions: ['macOS 14.3', 'macOS 14.4'],
    appVersions: ['1.7.0 K', '1.6.7 K'],
  },
];

/**
 * Country code → preferred Telegram lang_code. Keep this list short; for
 * everything else we default to 'en'. Aligning lang to proxy country
 * makes the fingerprint look more cohesive.
 */
const COUNTRY_LANG = {
  ru: 'ru-RU', ua: 'uk-UA', by: 'ru-BY', kz: 'ru-KZ', kg: 'ru-KG',
  in: 'en-IN', us: 'en-US', gb: 'en-GB', ca: 'en-CA', au: 'en-AU', nz: 'en-NZ',
  br: 'pt-BR', pt: 'pt-PT', es: 'es-ES', mx: 'es-MX', ar: 'es-AR', co: 'es-CO', cl: 'es-CL',
  fr: 'fr-FR', be: 'fr-BE', ch: 'de-CH', de: 'de-DE', at: 'de-AT',
  it: 'it-IT', nl: 'nl-NL', se: 'sv-SE', no: 'nb-NO', fi: 'fi-FI', dk: 'da-DK',
  pl: 'pl-PL', cz: 'cs-CZ', sk: 'sk-SK', hu: 'hu-HU', ro: 'ro-RO', bg: 'bg-BG',
  tr: 'tr-TR', ir: 'fa-IR', ae: 'ar-AE', sa: 'ar-SA', eg: 'ar-EG', iq: 'ar-IQ',
  cn: 'zh-Hans-CN', tw: 'zh-Hant-TW', hk: 'zh-Hant-HK', jp: 'ja-JP', kr: 'ko-KR',
  vn: 'vi-VN', th: 'th-TH', id: 'id-ID', my: 'ms-MY', ph: 'en-PH', sg: 'en-SG',
  pk: 'en-PK', bd: 'bn-BD',
};

/**
 * Country code → primary IANA timezone (used as a stable proxy for
 * "local hour" decisions in the circadian-curfew). Always returns a
 * valid IANA name; defaults to 'UTC' for unknown countries.
 */
const COUNTRY_TZ = {
  ru: 'Europe/Moscow', ua: 'Europe/Kyiv', by: 'Europe/Minsk', kz: 'Asia/Almaty', kg: 'Asia/Bishkek',
  in: 'Asia/Kolkata', us: 'America/New_York', gb: 'Europe/London', ca: 'America/Toronto', au: 'Australia/Sydney', nz: 'Pacific/Auckland',
  br: 'America/Sao_Paulo', pt: 'Europe/Lisbon', es: 'Europe/Madrid', mx: 'America/Mexico_City', ar: 'America/Argentina/Buenos_Aires', co: 'America/Bogota', cl: 'America/Santiago',
  fr: 'Europe/Paris', be: 'Europe/Brussels', ch: 'Europe/Zurich', de: 'Europe/Berlin', at: 'Europe/Vienna',
  it: 'Europe/Rome', nl: 'Europe/Amsterdam', se: 'Europe/Stockholm', no: 'Europe/Oslo', fi: 'Europe/Helsinki', dk: 'Europe/Copenhagen',
  pl: 'Europe/Warsaw', cz: 'Europe/Prague', sk: 'Europe/Bratislava', hu: 'Europe/Budapest', ro: 'Europe/Bucharest', bg: 'Europe/Sofia',
  tr: 'Europe/Istanbul', ir: 'Asia/Tehran', ae: 'Asia/Dubai', sa: 'Asia/Riyadh', eg: 'Africa/Cairo', iq: 'Asia/Baghdad',
  cn: 'Asia/Shanghai', tw: 'Asia/Taipei', hk: 'Asia/Hong_Kong', jp: 'Asia/Tokyo', kr: 'Asia/Seoul',
  vn: 'Asia/Ho_Chi_Minh', th: 'Asia/Bangkok', id: 'Asia/Jakarta', my: 'Asia/Kuala_Lumpur', ph: 'Asia/Manila', sg: 'Asia/Singapore',
  pk: 'Asia/Karachi', bd: 'Asia/Dhaka',
};

/**
 * Return a deterministic-but-uniform integer for a given seed string.
 * Used so the same sessionId always picks the same profile.
 */
function hashIndex(seed, modulo) {
  if (!seed) return Math.floor(Math.random() * modulo);
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  // Take first 4 bytes as a uint32, then mod.
  const n = h.readUInt32BE(0);
  return n % modulo;
}

function pickByHash(arr, seed, salt = '') {
  return arr[hashIndex(`${seed}:${salt}`, arr.length)];
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Pick a random profile from the pool (no seed). */
function pickRandomProfile() {
  return PROFILES[Math.floor(Math.random() * PROFILES.length)];
}

/** Pick a deterministic profile from a seed (e.g. session_id). */
function pickProfileForSeed(seed) {
  return PROFILES[hashIndex(seed, PROFILES.length)];
}

/**
 * Build a concrete identity from a profile.
 *
 * @param {object|null} profile     One of PROFILES; null → random.
 * @param {object} [opts]
 * @param {string} [opts.seed]      Stable seed (e.g. sessionId) — when
 *                                  provided, all sub-picks are
 *                                  deterministic.
 * @param {string} [opts.country]   ISO 3166-1 alpha-2 (lower-case).
 *                                  Used to pick a matching lang_code.
 * @param {string} [opts.lang]      Override lang explicitly.
 * @returns {{
 *   profileId: string,
 *   platform: string,
 *   deviceModel: string,
 *   systemVersion: string,
 *   appVersion: string,
 *   langCode: string,
 *   systemLangCode: string,
 *   generatedAt: string,
 * }}
 */
function buildIdentity(profile, opts = {}) {
  const p = profile || (opts.seed ? pickProfileForSeed(opts.seed) : pickRandomProfile());

  const pick = (arr, salt) =>
    opts.seed ? pickByHash(arr, opts.seed, salt) : pickRandom(arr);

  const langCode = opts.lang
    || (opts.country ? randomLangFor(opts.country) : 'en');

  return {
    profileId: p.id,
    platform: p.platform,
    deviceModel: pick(p.deviceModels, 'device'),
    systemVersion: pick(p.systemVersions, 'os'),
    appVersion: pick(p.appVersions, 'app'),
    langCode,
    systemLangCode: langCode,
    country: opts.country ? String(opts.country).toLowerCase() : null,
    timezone: opts.country ? tzFor(opts.country) : null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Map a country code (lowercase) to a Telegram lang_code.
 */
function randomLangFor(country) {
  if (!country) return 'en-US';
  const c = String(country).toLowerCase();
  return COUNTRY_LANG[c] || 'en';
}

/**
 * Map a country code (lowercase) to an IANA timezone. Defaults to 'UTC'
 * for unknown countries.
 */
function tzFor(country) {
  if (!country) return 'UTC';
  const c = String(country).toLowerCase();
  return COUNTRY_TZ[c] || 'UTC';
}

/**
 * Return the current local hour (0-23) for a given country.
 * Used by behaviorService for the circadian curfew.
 */
function localHourFor(country) {
  const tz = tzFor(country);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz });
    const parts = fmt.formatToParts(new Date());
    const h = parts.find((p) => p.type === 'hour');
    if (h) {
      const n = parseInt(h.value, 10);
      if (Number.isFinite(n)) return ((n % 24) + 24) % 24;
    }
  } catch {
    /* ignore — fall through */
  }
  return new Date().getUTCHours();
}

/**
 * Validate an identity object and return a sanitized copy. Used when
 * loading possibly-corrupt JSON from the DB.
 */
function sanitizeIdentity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {
    profileId: typeof raw.profileId === 'string' ? raw.profileId : 'legacy',
    platform: typeof raw.platform === 'string' ? raw.platform : 'unknown',
    deviceModel: typeof raw.deviceModel === 'string' && raw.deviceModel ? raw.deviceModel : null,
    systemVersion: typeof raw.systemVersion === 'string' && raw.systemVersion ? raw.systemVersion : null,
    appVersion: typeof raw.appVersion === 'string' && raw.appVersion ? raw.appVersion : null,
    langCode: typeof raw.langCode === 'string' && raw.langCode ? raw.langCode : 'en',
    systemLangCode: typeof raw.systemLangCode === 'string' && raw.systemLangCode ? raw.systemLangCode : 'en',
    country: typeof raw.country === 'string' && raw.country ? raw.country.toLowerCase() : null,
    timezone: typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : null,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date().toISOString(),
  };
  // Reject if any of the four telegram-meaningful fields are missing.
  if (!out.deviceModel || !out.systemVersion || !out.appVersion) return null;
  return out;
}

/** Translate a stored identity into the GramJS client option subset. */
function toClientOptions(identity) {
  if (!identity) return {};
  return {
    deviceModel: identity.deviceModel,
    systemVersion: identity.systemVersion,
    appVersion: identity.appVersion,
    langCode: identity.langCode || 'en',
    systemLangCode: identity.systemLangCode || identity.langCode || 'en',
  };
}

module.exports = {
  PROFILES,
  COUNTRY_LANG,
  COUNTRY_TZ,
  pickRandomProfile,
  pickProfileForSeed,
  buildIdentity,
  randomLangFor,
  tzFor,
  localHourFor,
  sanitizeIdentity,
  toClientOptions,
  listProfiles: () => PROFILES.slice(),
};
