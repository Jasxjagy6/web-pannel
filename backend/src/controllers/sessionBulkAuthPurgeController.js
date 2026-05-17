/**
 * HTTP surface for the bulk auth-purge job runner.
 *
 * Endpoints (mounted under /api/sessions/bulk-auth-purge):
 *   POST   /start                 → { jobId }
 *   GET    /:jobId/status         → public job view
 *   POST   /:jobId/cancel
 *
 * Mirrors the shape of the bulk-login controller so the frontend
 * reuses the same polling pattern.
 */

'use strict';

const { AppError, asyncHandler } = require('../utils/errorHandler');
const service = require('../services/sessionBulkAuthPurgeService');

module.exports = {
  /**
   * POST /start — body: { sessionIds: [..], interSessionDelayMs?, interDeviceDelayMs? }
   */
  start: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) {
      throw new AppError('Authentication required', 401, 'NO_AUTH');
    }
    const { sessionIds, interSessionDelayMs, interDeviceDelayMs } = req.body || {};
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError(
        'sessionIds must be a non-empty array of panel session IDs',
        400,
        'BAD_SESSION_IDS'
      );
    }
    try {
      const { jobId } = await service.startBulkAuthPurgeJob({
        userId,
        sessionIds,
        interSessionDelayMs,
        interDeviceDelayMs,
      });
      res.status(202).json({ jobId });
    } catch (err) {
      throw new AppError(err.message, 400, 'BULK_AUTH_PURGE_START_FAILED');
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
      throw new AppError('Bulk auth-purge job not found', 404, 'JOB_NOT_FOUND');
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
