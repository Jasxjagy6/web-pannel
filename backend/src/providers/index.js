/**
 * Provider registry — resolves a platform string to a provider object.
 *
 * Every controller route handler that touches per-account state should call
 * `getProvider(req.platform).<noun>.<verb>(...)` instead of importing one of
 * the legacy services directly. This is the seam that keeps controllers
 * platform-agnostic (§3 of INSTAGRAM_PANEL_ARCHITECTURE.md).
 *
 * Provider shape:
 *   {
 *     platform: 'telegram' | 'instagram',
 *     capabilities: { [feature: string]: boolean },
 *     sessions:        { upload, list, login, logout, status, download, ... },
 *     create:          { start, verify, password, resend, cancel },
 *     scrape:          { start, cancel, list, export },
 *     messaging:       { sendBulk, sendToTarget, forward?, list },
 *     threads:         { list, get, send }                  // IG-only
 *     lists:           { create, list, get, update, delete, items },
 *     reports:         { generate, list, ... },
 *     otp:             { requestCode?, list, poll },
 *     twoFA:           { enable, disable, change, listJobs },
 *     privacy:         { set, get },
 *     accountSettings: { update, get },
 *     proxies:         { list, create, validate, delete, assign },
 *     identity:        { generate, list, assign },
 *     behavior:        { start, stop, status },
 *   }
 *
 * The Telegram provider is a thin facade that re-exports the existing
 * services at the noun.verb shape; the Instagram provider is a stub until
 * Phase 2 lands the real implementation.
 */

const VALID_PLATFORMS = ['telegram', 'instagram'];

const _providers = {};

function _load(platform) {
  if (_providers[platform]) return _providers[platform];
  // Lazy-load so that requiring the registry doesn't pull in instagram-private-api
  // or GramJS at boot time if neither platform is in use yet.
  if (platform === 'telegram') {
    _providers.telegram = require('./telegram');
  } else if (platform === 'instagram') {
    _providers.instagram = require('./instagram');
  } else {
    throw new Error(`Unknown platform: ${platform}`);
  }
  return _providers[platform];
}

/**
 * Resolve a platform string to its provider. Defaults to 'telegram' when
 * the value is missing/falsy so legacy callers without a req.platform keep
 * working.
 */
function getProvider(platform) {
  const p = (platform || 'telegram').toLowerCase();
  if (!VALID_PLATFORMS.includes(p)) {
    throw new Error(`Unknown platform: ${platform}`);
  }
  return _load(p);
}

/**
 * Convenience helper: read req.platform (set by parsePlatform/resolvePlatform)
 * and return its provider. Throws AppError(400) if no platform was resolved.
 */
function providerFor(req) {
  const platform = (req && req.platform) || 'telegram';
  return getProvider(platform);
}

module.exports = {
  VALID_PLATFORMS,
  getProvider,
  providerFor,
};
