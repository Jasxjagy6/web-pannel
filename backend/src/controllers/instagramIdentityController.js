/**
 * Instagram-only Identity / Anti-Detect controller.
 *
 * Telegram has a single per-API-id device-info string and the panel
 * pins it for the session. Instagram's anti-bot story is much wider:
 *   - mobile API: device model, ANDROID_VERSION, ANDROID_RELEASE,
 *     deviceId, uuid, phoneId, adid, build, app_version, locale
 *   - web API: a separately pinned `webFingerprint` (UA / locale /
 *     accept-language)
 *
 * The TG /anti-detect surface returns a Telegram-shape identity blob
 * which is meaningless for IG, so we expose the IG-specific snapshot
 * here. `generate` rotates the device blob — gated by IG-side
 * cooldowns (min account age + min days since last rotation) unless
 * the operator forces it.
 */

const { asyncHandler, AppError } = require('../utils/errorHandler');
const reportService = require('../services/reportService');
const logger = require('../utils/logger');

function _ensureIg(req) {
  if (req.platform !== 'instagram') {
    throw new AppError('This endpoint is Instagram-only.', 400, 'WRONG_PLATFORM');
  }
}

function _sessionId(req) {
  const id = Number(req.params.sessionId);
  if (!id || Number.isNaN(id)) {
    throw new AppError('Invalid session id', 400, 'BAD_ID');
  }
  return id;
}

module.exports = {
  /** GET /api/instagram/identity/:sessionId */
  get: asyncHandler(async (req, res) => {
    _ensureIg(req);
    const sessionId = _sessionId(req);
    const userId = req.user.id;
    const fingerprint = await req.provider.identity.list({ userId, sessionId });

    // Pull the rest of the platform_state (locale, web fingerprint,
    // appVersion, apiMode, cooldowns) for the operator dashboard.
    // pool is required lazily to avoid circular init.
    // eslint-disable-next-line global-require
    const { pool } = require('../config/database');
    const r = await pool.query(
      `SELECT platform_state, created_at, proxy_url, status,
              warmup_state, is_logged_in
         FROM sessions
        WHERE id = $1 AND user_id = $2 AND platform = 'instagram'`,
      [sessionId, userId]
    );
    if (r.rowCount === 0) {
      throw new AppError('Session not found', 404, 'NOT_FOUND');
    }
    const row = r.rows[0];
    const ps = row.platform_state || {};
    return res.json({
      success: true,
      data: {
        fingerprint,
        appVersion: ps.appVersion || null,
        locale: ps.locale || null,
        apiMode: ps.apiMode || null,
        webFingerprint: ps.webFingerprint || null,
        cooldowns: ps.cooldowns || {},
        session: {
          created_at: row.created_at,
          proxy_url: row.proxy_url,
          status: row.status,
          warmup_state: row.warmup_state,
          is_logged_in: row.is_logged_in,
        },
      },
    });
  }),

  /** POST /api/instagram/identity/:sessionId/rotate */
  rotate: asyncHandler(async (req, res) => {
    _ensureIg(req);
    const sessionId = _sessionId(req);
    const userId = req.user.id;
    const force = req.body && req.body.force === true;
    const seed = req.body && typeof req.body.seed === 'string' ? req.body.seed : null;
    const out = await req.provider.identity.generate({
      userId, sessionId, seed, force,
    });
    reportService
      .logActivity(userId, 'instagram_identity_rotate', 'session', sessionId, {
        forced: !!force,
        seed_supplied: !!seed,
      })
      .catch(() => {});
    logger.info(
      `IG identity rotate user=${userId} session=${sessionId} ` +
      `force=${!!force} seed_supplied=${!!seed}`
    );
    return res.json({ success: true, data: out });
  }),
};
