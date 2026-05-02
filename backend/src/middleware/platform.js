const { AppError } = require('../utils/errorHandler');

/**
 * Multi-platform routing middleware.
 *
 * Two ways to detect the platform on an incoming request:
 *
 *   1. URL prefix: every per-account router is mounted twice — at
 *      `/api/telegram/<router>` and `/api/instagram/<router>` — and we
 *      bind the platform via `parsePlatform('telegram')` /
 *      `parsePlatform('instagram')` factory calls inline at mount time.
 *
 *   2. Header / query / body, used by:
 *      - the legacy `/api/<router>` alias kept for one release cycle so
 *        existing clients don't break,
 *      - global routers (e.g. /api/billing, /api/auth) that need to know
 *        which platform the user is asking about without a URL prefix.
 *
 * In both cases the resolved value is stored on `req.platform` and a
 * `X-Platform: <value>` response header is added so the frontend / proxies
 * can confirm the routing.
 *
 * The default — applied when nothing else is set — is `'telegram'`.
 */

const VALID_PLATFORMS = ['telegram', 'instagram'];
const DEFAULT_PLATFORM = 'telegram';

function _normalize(value) {
  if (!value) return null;
  const lower = String(value).trim().toLowerCase();
  return VALID_PLATFORMS.includes(lower) ? lower : null;
}

/**
 * Factory: returns a middleware that hard-binds the request to the given
 * platform. Used at mount time for `/api/telegram/*` and `/api/instagram/*`.
 *
 *   app.use('/api/telegram', parsePlatform('telegram'), telegramRoutes);
 */
function parsePlatform(forced) {
  const normalized = _normalize(forced) || DEFAULT_PLATFORM;
  return (req, res, next) => {
    req.platform = normalized;
    // Lazily resolve the provider on first access so we don't pay the
    // require() cost of either platform's runtime if the request never
    // touches them (e.g. health checks, auth).
    let _provider = null;
    Object.defineProperty(req, 'provider', {
      configurable: true,
      enumerable: false,
      get() {
        if (!_provider) {
          // eslint-disable-next-line global-require
          const { getProvider } = require('../providers');
          _provider = getProvider(req.platform);
        }
        return _provider;
      },
    });
    res.setHeader('X-Platform', normalized);
    next();
  };
}

/**
 * Resolve the platform for a request that DOESN'T have a hard-bound prefix.
 * Looks in this order:
 *   1. existing req.platform (a previous middleware already set it)
 *   2. X-Platform header
 *   3. ?platform= query string
 *   4. body.platform
 *   5. fallback to 'telegram'
 *
 * The legacy `/api/*` alias uses this to default to telegram while still
 * letting a forward-thinking client opt in by sending `X-Platform: instagram`.
 */
function resolvePlatform(req, res, next) {
  if (!req.platform) {
    const fromHeader = _normalize(req.headers['x-platform']);
    const fromQuery = _normalize(req.query?.platform);
    const fromBody = _normalize(req.body?.platform);
    req.platform = fromHeader || fromQuery || fromBody || DEFAULT_PLATFORM;
  }
  if (!Object.getOwnPropertyDescriptor(req, 'provider')) {
    let _provider = null;
    Object.defineProperty(req, 'provider', {
      configurable: true,
      enumerable: false,
      get() {
        if (!_provider) {
          // eslint-disable-next-line global-require
          const { getProvider } = require('../providers');
          _provider = getProvider(req.platform);
        }
        return _provider;
      },
    });
  }
  res.setHeader('X-Platform', req.platform);
  next();
}

/**
 * Strict variant: throws a 400 if the platform isn't a recognised value.
 * Used by routes that absolutely require an explicit platform argument
 * (e.g. /billing/checkout when bundle is not requested).
 */
function requirePlatform(req, _res, next) {
  if (!req.platform || !VALID_PLATFORMS.includes(req.platform)) {
    return next(new AppError(
      `Unknown platform "${req.platform || ''}". Expected one of ${VALID_PLATFORMS.join(', ')}.`,
      400,
      'UNKNOWN_PLATFORM'
    ));
  }
  next();
}

module.exports = {
  parsePlatform,
  resolvePlatform,
  requirePlatform,
  VALID_PLATFORMS,
  DEFAULT_PLATFORM,
};
