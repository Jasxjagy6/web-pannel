/**
 * HTTP surface for the bulk-login job runner.
 *
 * Endpoints (mounted under /api/sessions/bulk-login):
 *   POST   /start                 → { jobId }
 *   GET    /:jobId/status         → public job view
 *   POST   /:jobId/cancel
 *
 * Mirrors the shape of the clone-export controller so the frontend
 * can reuse the same polling pattern.
 */

'use strict';

const { AppError, asyncHandler } = require('../utils/errorHandler');
const service = require('../services/sessionBulkLoginService');

module.exports = {
  /**
   * POST /start — body: { sessionIds: [..], interRowDelayMs? }
   */
  start: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) {
      throw new AppError('Authentication required', 401, 'NO_AUTH');
    }
    const { sessionIds, interRowDelayMs } = req.body || {};
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError(
        'sessionIds must be a non-empty array of panel session IDs',
        400,
        'BAD_SESSION_IDS'
      );
    }
    try {
      const { jobId } = await service.startBulkLoginJob({
        userId,
        sessionIds,
        interRowDelayMs,
      });
      res.status(202).json({ jobId });
    } catch (err) {
      throw new AppError(err.message, 400, 'BULK_LOGIN_START_FAILED');
    }
  }),

  /**
   * GET /:jobId/status
   */
  status: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) throw new AppError('Authentication required', 401, 'NO_AUTH');
    const view = service.getJobStatus(req.params.jobId, userId);
    if (!view) {
      throw new AppError('Bulk-login job not found', 404, 'JOB_NOT_FOUND');
    }
    res.json(view);
  }),

  /**
   * POST /:jobId/cancel
   */
  cancel: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) throw new AppError('Authentication required', 401, 'NO_AUTH');
    const ok = service.cancelJob(req.params.jobId, userId);
    if (!ok) throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    res.json({ ok: true });
  }),
};
