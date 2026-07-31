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
const dedicatedProxyService = require('../services/dedicatedProxyService');

module.exports = {
  preview: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) throw new AppError('Authentication required', 401, 'NO_AUTH');
    const { sessionIds, allInactive } = req.body || {};
    if (allInactive !== true && (!Array.isArray(sessionIds) || sessionIds.length === 0)) {
      throw new AppError('sessionIds must be a non-empty array', 400, 'BAD_SESSION_IDS');
    }
    const plan = await dedicatedProxyService.createLoginPlan(userId, {
      sessionIds,
      allInactive: allInactive === true,
    });
    res.json({ success: true, data: plan });
  }),

  /**
   * POST /start — body: { sessionIds: [..], interRowDelayMs? }
   */
  start: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) {
      throw new AppError('Authentication required', 401, 'NO_AUTH');
    }
    const { sessionIds, allInactive, interRowDelayMs, proxyPlanId, skipUnassigned } = req.body || {};
    if (!proxyPlanId && allInactive !== true && (!Array.isArray(sessionIds) || sessionIds.length === 0)) {
      throw new AppError(
        'sessionIds must be a non-empty array of panel session IDs',
        400,
        'BAD_SESSION_IDS'
      );
    }
    const result = await service.startBulkLoginJob({
      userId,
      sessionIds,
      allInactive: allInactive === true,
      interRowDelayMs,
      proxyPlanId,
      skipUnassigned: skipUnassigned === true,
    });
    res.status(202).json(result);
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
