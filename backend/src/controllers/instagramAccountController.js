/**
 * Instagram-only Account-Settings controller.
 *
 * Telegram has separate first/last name + username fields and a
 * shared photo-upload utility. Instagram has a single full_name plus
 * biography, external_url, gender, phone_number, email, and
 * profile_picture (binary upload). Trying to bend the TG controller
 * would lose those fields.
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

const ALLOWED_PATCH_KEYS = new Set([
  'username',
  'full_name',
  'biography',
  'phone_number',
  'email',
  'external_url',
  'gender',
  '_admin_override',
]);

module.exports = {
  /** GET /api/instagram/account/:sessionId */
  get: asyncHandler(async (req, res) => {
    _ensureIg(req);
    const sessionId = _sessionId(req);
    const userId = req.user.id;
    const out = await req.provider.accountSettings.get({ userId, sessionId });
    return res.json({ success: true, data: out });
  }),

  /** PATCH /api/instagram/account/:sessionId */
  update: asyncHandler(async (req, res) => {
    _ensureIg(req);
    const sessionId = _sessionId(req);
    const userId = req.user.id;
    const body = req.body || {};

    // Whitelist patch keys to avoid leaking arbitrary fields into the
    // editProfile call. profile_picture comes via /upload-photo (multipart).
    const patch = {};
    for (const k of Object.keys(body)) {
      if (ALLOWED_PATCH_KEYS.has(k)) patch[k] = body[k];
    }
    if (Object.keys(patch).length === 0) {
      throw new AppError(
        'Empty patch — provide at least one of: ' +
          Array.from(ALLOWED_PATCH_KEYS).filter((x) => x !== '_admin_override').join(', '),
        400,
        'EMPTY_PATCH'
      );
    }

    const out = await req.provider.accountSettings.update({
      userId, sessionId, patch,
    });
    reportService
      .logActivity(userId, 'instagram_account_update', 'session', sessionId, {
        keys: Object.keys(patch),
      })
      .catch(() => {});
    logger.info(
      `IG account update user=${userId} session=${sessionId} ` +
      `keys=${Object.keys(patch).join(',')}`
    );
    return res.json({ success: true, data: out });
  }),

  /**
   * POST /api/instagram/account/:sessionId/photo  (multipart photo)
   *
   * Re-uses the existing fileUpload middleware and reads the file
   * straight off req.files.photo (express-fileupload). The buffer
   * is passed to provider.accountSettings.update with
   * patch.profile_picture_buffer.
   */
  uploadPhoto: asyncHandler(async (req, res) => {
    _ensureIg(req);
    const sessionId = _sessionId(req);
    const userId = req.user.id;
    if (!req.files || !req.files.photo) {
      throw new AppError('Photo file is required', 400, 'NO_PHOTO');
    }
    const file = req.files.photo;
    const buf = file.data;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw new AppError('Uploaded photo is empty', 400, 'EMPTY_PHOTO');
    }
    if (buf.length > 8 * 1024 * 1024) {
      throw new AppError('Photo must be smaller than 8 MB', 400, 'PHOTO_TOO_LARGE');
    }
    const out = await req.provider.accountSettings.update({
      userId,
      sessionId,
      patch: { profile_picture_buffer: buf },
    });
    reportService
      .logActivity(userId, 'instagram_account_pfp_update', 'session', sessionId, {
        bytes: buf.length,
      })
      .catch(() => {});
    logger.info(
      `IG pfp update user=${userId} session=${sessionId} bytes=${buf.length}`
    );
    return res.json({ success: true, data: out });
  }),
};
