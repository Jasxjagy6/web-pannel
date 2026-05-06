const accountSettingsService = require('../services/accountSettingsService');
const { asyncHandler } = require('../utils/errorHandler');
const { resolveSessionIdsFromRequest } = require('../utils/resolveSessions');
const logger = require('../utils/logger');

module.exports = {
  /**
   * POST /api/account-settings/update
   * Update account settings for multiple sessions
   */
  updateMultipleSessions: asyncHandler(async (req, res) => {
    const {
      sessionIds: rawSessionIds,
      firstName,
      lastName,
      username,
      bio,
      updateFlags,
    } = req.body;

    const userId = req.user?.id;
    const sessionIds = await resolveSessionIdsFromRequest(req, rawSessionIds || []);

    logger.info(`Account settings update request from user ${userId}`, {
      sessionCount: sessionIds?.length || 0,
      flags: updateFlags,
    });

    const result = await accountSettingsService.updateMultipleSessions({
      sessionIds,
      firstName,
      lastName,
      username,
      bio,
      profilePhotoPath: req.body.profilePhotoPath,
      updateFlags,
    }, userId);

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * POST /api/account-settings/upload-photo
   * Upload profile photo file
   */
  uploadProfilePhoto: asyncHandler(async (req, res) => {
    const userId = req.user?.id;

    if (!req.files || !req.files.photo) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Photo file is required',
          code: 'NO_PHOTO',
        },
      });
    }

    const file = req.files.photo;
    const filePath = await accountSettingsService.saveProfilePhoto(file, userId);

    return res.status(200).json({
      success: true,
      data: {
        filePath,
        fileName: file.name,
      },
    });
  }),

  /**
   * GET /api/account-settings/:sessionId
   * Get account settings for a session
   */
  getAccountSettings: asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const userId = req.user?.id;

    const settings = await accountSettingsService.getAccountSettings(sessionId, userId);

    return res.status(200).json({
      success: true,
      data: settings,
    });
  }),
};
