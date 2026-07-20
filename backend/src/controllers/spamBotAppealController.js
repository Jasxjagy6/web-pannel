/**
 * HTTP surface for the @SpamBot appeal job runner.
 *
 * Endpoints (mounted under /api/sessions/spam-appeal):
 *   POST   /start          → { jobId, total }
 *   GET    /:jobId/status  → public job view
 *   POST   /:jobId/cancel
 *
 * Accepts an explicit `sessionIds` array OR one/more session lists
 * (`sessionListIds` / `sessionListId`), resolved server-side.
 */

'use strict';

const { AppError, asyncHandler } = require('../utils/errorHandler');
const { resolveSessionIdsFromRequest } = require('../utils/resolveSessions');
const service = require('../services/spamBotAppealService');

module.exports = {
  start: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) throw new AppError('Authentication required', 401, 'NO_AUTH');

    const { sessionIds: rawSessionIds, interSessionDelayMs } = req.body || {};
    const sessionIds = await resolveSessionIdsFromRequest(req, rawSessionIds || []);
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError(
        'sessionIds array (or a non-empty session list) is required',
        400,
        'NO_SESSIONS'
      );
    }
    try {
      const result = await service.startAppealJob({
        userId,
        sessionIds,
        interSessionDelayMs,
      });
      res.status(202).json(result);
    } catch (err) {
      throw new AppError(err.message, 400, 'SPAM_APPEAL_START_FAILED');
    }
  }),

  status: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) throw new AppError('Authentication required', 401, 'NO_AUTH');
    const view = service.getJobStatus(req.params.jobId, userId);
    if (!view) throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    res.json(view);
  }),

  cancel: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) throw new AppError('Authentication required', 401, 'NO_AUTH');
    const view = service.cancelJob(req.params.jobId, userId);
    if (!view) throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    res.json(view);
  }),
};
