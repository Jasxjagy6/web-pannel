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
   * GET /api/account-settings/randomize/pools
   * Returns the pool data the Randomize Mode samples from.
   */
  getRandomizePools: asyncHandler(async (req, res) => {
    const pools = accountSettingsService.getRandomizePools();
    return res.status(200).json({ success: true, data: pools });
  }),

  /**
   * GET /api/account-settings/randomize/avatars/:id
   * Streams a bundled avatar JPG so the frontend preview can render it.
   */
  getRandomAvatar: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const filePath = accountSettingsService.getAvatarFilePath(id);
    if (!filePath) {
      return res.status(404).json({
        success: false,
        error: { message: 'Avatar not found', code: 'AVATAR_NOT_FOUND' },
      });
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(filePath);
  }),

  /**
   * POST /api/account-settings/randomize/apply
   * Applies the per-session assignments produced by Randomize Mode.
   */
  applyRandomized: asyncHandler(async (req, res) => {
    const { assignments } = req.body;
    const userId = req.user?.id;

    logger.info(`Randomize apply request from user ${userId}`, {
      sessionCount: Array.isArray(assignments) ? assignments.length : 0,
    });

    const result = await accountSettingsService.applyRandomizedAssignments(
      { assignments },
      userId
    );

    return res.status(200).json({ success: true, data: result });
  }),

  /**
   * POST /api/account-settings/profile-list/preview
   * Build the per-session assignments for "Apply Profile List" without
   * touching Telegram. Returns the cycled name / username (with
   * random-suffix repeats) / bio / avatar choice for each session so
   * the frontend can render a preview table the operator can re-roll.
   */
  previewProfileList: asyncHandler(async (req, res) => {
    const { listId, sessionIds: rawSessionIds, updateUsernames, updatePhotos, updateBios } = req.body;
    const userId = req.user?.id;
    const sessionIds = await resolveSessionIdsFromRequest(req, rawSessionIds || []);
    const result = await accountSettingsService.previewProfileListAssignments(
      { listId, sessionIds, updateUsernames, updatePhotos, updateBios },
      userId
    );
    return res.status(200).json({ success: true, data: result });
  }),

  /**
   * POST /api/account-settings/profile-list/apply
   * Apply a profile list across the given sessions. Accepts either a
   * `listId` (re-builds assignments server-side) or an explicit
   * `assignments` array (the preview the operator already re-rolled).
   */
  applyProfileList: asyncHandler(async (req, res) => {
    const {
      listId,
      sessionIds: rawSessionIds,
      assignments,
      updateUsernames,
      updatePhotos,
      updateBios,
    } = req.body;
    const userId = req.user?.id;
    const sessionIds = await resolveSessionIdsFromRequest(req, rawSessionIds || []);
    logger.info(`Profile-list apply request from user ${userId}`, {
      listId,
      sessionCount: sessionIds?.length || 0,
      withAssignments: Array.isArray(assignments),
    });
    const result = await accountSettingsService.applyProfileListToSessions(
      { listId, sessionIds, assignments, updateUsernames, updatePhotos, updateBios },
      userId
    );
    return res.status(200).json({ success: true, data: result });
  }),

  /**
   * POST /api/account-settings/remove-photos
   * Wipe every profile photo (visible avatar + history) for each of the
   * given sessions. Destructive — there is no undo. Returns a per-session
   * report so the frontend can surface failures.
   */
  removeAllProfilePhotos: asyncHandler(async (req, res) => {
    const { sessionIds: rawSessionIds } = req.body;
    const userId = req.user?.id;
    const sessionIds = await resolveSessionIdsFromRequest(req, rawSessionIds || []);

    logger.info(`Bulk profile-photo removal request from user ${userId}`, {
      sessionCount: sessionIds?.length || 0,
    });

    const result = await accountSettingsService.removeAllProfilePhotos(
      { sessionIds },
      userId
    );

    return res.status(200).json({ success: true, data: result });
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
