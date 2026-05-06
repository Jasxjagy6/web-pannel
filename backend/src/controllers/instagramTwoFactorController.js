/**
 * Instagram-only 2FA controller.
 *
 * Telegram exposes a "cloud password" plus optional hint, settable
 * with a single SRP exchange. Instagram exposes none of that — its
 * 2FA is a TOTP secret enrolled per-account, optionally with SMS or
 * WhatsApp as a backup. Trying to reuse the TG twoFAJobController for
 * IG would lie about what's actually happening, so this lives as its
 * own thin controller mounted at /api/instagram/two-factor/*.
 *
 * The mounting in index.js only attaches this router under
 * /api/instagram/<router>, so we don't need a runtime platform guard
 * — but we keep one anyway as a defensive backstop.
 */

const { asyncHandler, AppError } = require('../utils/errorHandler');
const reportService = require('../services/reportService');
const logger = require('../utils/logger');

function _ensureIg(req) {
  if (req.platform !== 'instagram') {
    throw new AppError(
      'This endpoint is Instagram-only.',
      400,
      'WRONG_PLATFORM'
    );
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
  /** GET /api/instagram/two-factor/:sessionId */
  status: asyncHandler(async (req, res) => {
    _ensureIg(req);
    const sessionId = _sessionId(req);
    const userId = req.user.id;
    const out = await req.provider.twoFA.status({ userId, sessionId });
    return res.json({ success: true, data: out });
  }),

  /** POST /api/instagram/two-factor/:sessionId/enable */
  enable: asyncHandler(async (req, res) => {
    _ensureIg(req);
    const sessionId = _sessionId(req);
    const userId = req.user.id;
    const out = await req.provider.twoFA.enable({ userId, sessionId });
    reportService
      .logActivity(userId, 'instagram_2fa_enable', 'session', sessionId, {})
      .catch(() => {});
    logger.info(`IG 2FA enable user=${userId} session=${sessionId}`);
    return res.json({ success: true, data: out });
  }),

  /** POST /api/instagram/two-factor/:sessionId/disable */
  disable: asyncHandler(async (req, res) => {
    _ensureIg(req);
    const sessionId = _sessionId(req);
    const userId = req.user.id;
    const out = await req.provider.twoFA.disable({ userId, sessionId });
    reportService
      .logActivity(userId, 'instagram_2fa_disable', 'session', sessionId, {})
      .catch(() => {});
    logger.info(`IG 2FA disable user=${userId} session=${sessionId}`);
    return res.json({ success: true, data: out });
  }),

  /** POST /api/instagram/two-factor/:sessionId/rotate (disable→enable) */
  rotate: asyncHandler(async (req, res) => {
    _ensureIg(req);
    const sessionId = _sessionId(req);
    const userId = req.user.id;
    const out = await req.provider.twoFA.change({ userId, sessionId });
    reportService
      .logActivity(userId, 'instagram_2fa_rotate', 'session', sessionId, {})
      .catch(() => {});
    logger.info(`IG 2FA rotate user=${userId} session=${sessionId}`);
    return res.json({ success: true, data: out });
  }),
};
