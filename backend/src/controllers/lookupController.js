/**
 * REST controller for Instagram identity-lookup jobs.
 *
 * Routes (mounted under /api/instagram/lookup):
 *   POST   /                      createAndStart  — create + enqueue in one call
 *   GET    /jobs                  listJobs
 *   GET    /jobs/:id              getJob
 *   GET    /jobs/:id/progress     getProgress
 *   POST   /jobs/:id/cancel       cancelJob
 *   DELETE /jobs/:id              deleteJob
 *   GET    /jobs/:id/findings     listFindings
 *   POST   /jobs/:id/export       exportJob
 *
 * The platform middleware (`parsePlatform('instagram')`) is applied at
 * mount-time, so this controller assumes `req.platform === 'instagram'`.
 */

'use strict';

const lookupService = require('../services/lookupService');
const { AppError, asyncHandler } = require('../utils/errorHandler');

function _assertIg(req) {
  if (req.platform && req.platform !== 'instagram') {
    throw new AppError('Lookup is only available on the Instagram platform.', 400, 'PLATFORM_UNSUPPORTED');
  }
}

const lookupController = {
  /**
   * POST /api/instagram/lookup
   *
   * Body: { username, methods?, options?, statedPurpose }
   *   - username       required, 1-30 chars, a-z 0-9 . _
   *   - methods        optional, array of method codes (see VALID_METHODS).
   *                    Defaults to [profile_info, reset_oracle,
   *                    cross_platform, geo_from_posts, dork].
   *   - options        optional, free-form JSON. Recognised keys:
   *                      - budgetUsdCap: cap on paid-API spend per job.
   *                      - serpApiKey:   override SERPAPI_KEY for this job.
   *   - statedPurpose  required (>=8 chars). Recorded for audit.
   */
  createAndStart: asyncHandler(async (req, res) => {
    _assertIg(req);
    const { username, methods, options, statedPurpose } = req.body || {};
    const job = await lookupService.createJob({
      userId: req.user.id,
      username,
      methods,
      options,
      statedPurpose,
      clientIp: req.ip,
    });
    const start = await lookupService.startJob(job.id, { async: true });
    res.status(201).json({
      success: true,
      data: { job, queueJobId: start.queueJobId, status: start.status },
    });
  }),

  /**
   * GET /api/instagram/lookup/jobs
   */
  listJobs: asyncHandler(async (req, res) => {
    _assertIg(req);
    const { page, limit, status } = req.query;
    const out = await lookupService.listJobs({
      userId: req.user.id, page, limit, status,
    });
    res.json({ success: true, data: out });
  }),

  /**
   * GET /api/instagram/lookup/jobs/:id
   */
  getJob: asyncHandler(async (req, res) => {
    _assertIg(req);
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) throw new AppError('Invalid job id', 400, 'VALIDATION_ERROR');
    const job = await lookupService.getJob(jobId);
    if (!job) throw new AppError('Lookup job not found', 404, 'NOT_FOUND');
    if (job.user_id !== req.user.id && req.user.role !== 'admin') {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    res.json({ success: true, data: { job } });
  }),

  /**
   * GET /api/instagram/lookup/jobs/:id/progress
   */
  getProgress: asyncHandler(async (req, res) => {
    _assertIg(req);
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) throw new AppError('Invalid job id', 400, 'VALIDATION_ERROR');
    const out = await lookupService.getProgress(jobId);
    if (out.job.user_id !== req.user.id && req.user.role !== 'admin') {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    res.json({ success: true, data: out });
  }),

  /**
   * GET /api/instagram/lookup/jobs/:id/findings
   */
  listFindings: asyncHandler(async (req, res) => {
    _assertIg(req);
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) throw new AppError('Invalid job id', 400, 'VALIDATION_ERROR');
    const job = await lookupService.getJob(jobId);
    if (!job) throw new AppError('Lookup job not found', 404, 'NOT_FOUND');
    if (job.user_id !== req.user.id && req.user.role !== 'admin') {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const findings = await lookupService.listFindings(jobId, {
      kind: req.query.kind,
      limit: req.query.limit,
    });
    res.json({ success: true, data: { findings } });
  }),

  /**
   * POST /api/instagram/lookup/jobs/:id/cancel
   */
  cancelJob: asyncHandler(async (req, res) => {
    _assertIg(req);
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) throw new AppError('Invalid job id', 400, 'VALIDATION_ERROR');
    const job = await lookupService.cancelJob(jobId, { userId: req.user.id });
    res.json({ success: true, data: { job } });
  }),

  /**
   * DELETE /api/instagram/lookup/jobs/:id
   */
  deleteJob: asyncHandler(async (req, res) => {
    _assertIg(req);
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) throw new AppError('Invalid job id', 400, 'VALIDATION_ERROR');
    const out = await lookupService.deleteJob(jobId, { userId: req.user.id });
    res.json({ success: true, data: out });
  }),

  /**
   * POST /api/instagram/lookup/jobs/:id/export
   *
   * Body: { format: 'csv' | 'json' }
   */
  exportJob: asyncHandler(async (req, res) => {
    _assertIg(req);
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) throw new AppError('Invalid job id', 400, 'VALIDATION_ERROR');
    const job = await lookupService.getJob(jobId);
    if (!job) throw new AppError('Lookup job not found', 404, 'NOT_FOUND');
    if (job.user_id !== req.user.id && req.user.role !== 'admin') {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const format = (req.body && req.body.format) || (req.query && req.query.format) || 'csv';
    const out = await lookupService.exportJob(jobId, format);
    res.setHeader('Content-Type', out.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.body);
  }),
};

module.exports = lookupController;
