/**
 * storyController — REST surface for the "Upload Story" feature.
 *
 * Routes are mounted under /api/stories (Telegram-only). Media is uploaded
 * first (multipart) to get an on-disk path, then a job is created that
 * targets a set of sessions (or a session list). Non-premium sessions are
 * skipped automatically. History is exposed via list/get/items.
 */

const storyService = require('../services/storyService');
const { resolveSessionIdsFromRequest } = require('../utils/resolveSessions');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;

const storyController = {
  /**
   * POST /api/stories/upload-media  (multipart: field "media")
   * Saves the file and returns { mediaPath, mediaName, mediaType }.
   */
  uploadMedia: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    if (!req.files || !req.files.media) {
      throw new AppError('media file is required', 400, 'NO_MEDIA');
    }
    const file = req.files.media;
    const name = file.name || '';
    let mediaType = null;
    if (IMAGE_EXT.test(name) || /^image\//.test(file.mimetype || '')) mediaType = 'photo';
    else if (VIDEO_EXT.test(name) || /^video\//.test(file.mimetype || '')) mediaType = 'video';
    if (!mediaType) {
      throw new AppError('Unsupported media type — use a JPG/PNG image or MP4 video', 400, 'BAD_MEDIA');
    }

    const { filePath, fileName } = await storyService.saveStoryMedia(file, userId);
    res.json({
      success: true,
      data: { mediaPath: filePath, mediaName: fileName, mediaType },
    });
  }),

  /**
   * POST /api/stories/jobs
   * Body: { mediaPath, mediaType, mediaName?, caption?, linkUrl?, privacy?,
   *         periodSeconds?, pinToProfile?, sessionIds?|sessionListId }
   */
  createJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const {
      mediaPath, mediaType, mediaName, caption, linkUrl, privacy,
      periodSeconds, pinToProfile, sessionIds: rawSessionIds,
    } = req.body || {};

    const sessionIds = await resolveSessionIdsFromRequest(req, rawSessionIds || []);
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('sessionIds (or a non-empty sessionListId) is required', 400, 'NO_SESSIONS');
    }

    const result = await storyService.createJob({
      mediaPath,
      mediaType,
      mediaName,
      caption,
      linkUrl,
      privacy,
      periodSeconds: periodSeconds != null ? parseInt(periodSeconds, 10) : undefined,
      pinToProfile: pinToProfile === true || pinToProfile === 'true',
      sessionIds,
    }, userId);

    logger.info(`Story job ${result.jobId} created by user ${userId}`, result);
    res.status(202).json({ success: true, data: result });
  }),

  /** GET /api/stories/jobs?limit=&offset= */
  listJobs: asyncHandler(async (req, res) => {
    const rows = await storyService.listJobs(req.user.id, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, data: { jobs: rows } });
  }),

  /** GET /api/stories/jobs/:id */
  getJob: asyncHandler(async (req, res) => {
    const job = await storyService.getJob(req.params.id, req.user.id);
    res.json({ success: true, data: job });
  }),

  /** GET /api/stories/jobs/:id/items */
  getJobItems: asyncHandler(async (req, res) => {
    const items = await storyService.getJobItems(req.params.id, req.user.id);
    res.json({ success: true, data: { items } });
  }),

  /** POST /api/stories/jobs/:id/cancel */
  cancelJob: asyncHandler(async (req, res) => {
    const result = await storyService.cancelJob(req.params.id, req.user.id);
    res.json({ success: true, data: result });
  }),
};

module.exports = storyController;
