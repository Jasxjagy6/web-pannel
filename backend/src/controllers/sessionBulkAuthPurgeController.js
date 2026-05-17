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
   * POST /preview — body: { sessionIds: [..] }
   *
   * Read-only "what would happen" probe used by the frontend BEFORE
   * the operator confirms the kill. Returns per-session device list
   * plus an `eligible` verdict; the operator must see this and tick
   * a confirm checkbox before /start will accept the job.
   */
  preview: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) throw new AppError('Authentication required', 401, 'NO_AUTH');
    const { sessionIds } = req.body || {};
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError(
        'sessionIds must be a non-empty array of panel session IDs',
        400,
        'BAD_SESSION_IDS'
      );
    }
    try {
      const result = await service.previewPurge({ userId, sessionIds });
      res.json(result);
    } catch (err) {
      throw new AppError(err.message, 400, 'BULK_AUTH_PURGE_PREVIEW_FAILED');
    }
  }),

  /**
   * POST /start — body: { sessionIds: [..], acknowledged: true,
   *                       interSessionDelayMs?, interDeviceDelayMs? }
   *
   * `acknowledged: true` is REQUIRED. The frontend must show the
   * preview, get the operator to tick the confirm checkbox, and only
   * then set this flag. The service will reject without it.
   */
  start: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) {
      throw new AppError('Authentication required', 401, 'NO_AUTH');
    }
    const {
      sessionIds,
      interSessionDelayMs,
      interDeviceDelayMs,
      acknowledged,
    } = req.body || {};
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
        acknowledged,
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
