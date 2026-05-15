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
const lookupWatchService = require('../services/lookupWatchService');
const lookupBudget = require('../services/lookupBudgetService');
const lookupAudit  = require('../services/lookupAuditService');
const userLookupKeys = require('../services/userLookupKeysService');
const lookupRisk = require('../services/lookupRiskService');
const resetOracleWatch = require('../providers/instagram/lookup/resetOracleWatch');
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

  // ---------------------------------------------------------------------
  // Watch CRUD (PR #7)
  // ---------------------------------------------------------------------
  createWatch: asyncHandler(async (req, res) => {
    _assertIg(req);
    const { username, cadenceHours } = req.body || {};
    const watch = await lookupWatchService.create({ userId: req.user.id, username, cadenceHours });
    res.status(201).json({ success: true, data: { watch } });
  }),

  listWatches: asyncHandler(async (req, res) => {
    _assertIg(req);
    const watches = await lookupWatchService.list({
      userId: req.user.id,
      includeInactive: req.query.includeInactive === '1' || req.query.includeInactive === 'true',
    });
    res.json({ success: true, data: { watches } });
  }),

  deleteWatch: asyncHandler(async (req, res) => {
    _assertIg(req);
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid watch id', 400, 'VALIDATION_ERROR');
    const r = await lookupWatchService.remove({ userId: req.user.id, id });
    if (!r.ok) throw new AppError('Watch not found', 404, 'NOT_FOUND');
    res.json({ success: true, data: { ok: true } });
  }),

  runWatchNow: asyncHandler(async (req, res) => {
    _assertIg(req);
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid watch id', 400, 'VALIDATION_ERROR');
    const w = await lookupWatchService.get({ userId: req.user.id, id });
    if (!w) throw new AppError('Watch not found', 404, 'NOT_FOUND');
    const result = await resetOracleWatch.run({ username: w.username, userId: req.user.id, watchId: w.id });
    await lookupWatchService.markRunResult({ id: w.id, cadenceHours: w.cadence_hours });
    res.json({ success: true, data: result });
  }),

  // ---------------------------------------------------------------------
  // Per-user budget (PR #8)
  // ---------------------------------------------------------------------
  getBudget: asyncHandler(async (req, res) => {
    _assertIg(req);
    const current = await lookupBudget.getCurrent(req.user.id);
    res.json({ success: true, data: { budget: current } });
  }),

  setBudget: asyncHandler(async (req, res) => {
    _assertIg(req);
    const { capUsd, warnAtPct, hardBlockAtPct } = req.body || {};
    const cap = Number(capUsd);
    if (!Number.isFinite(cap) || cap < 0) throw new AppError('Invalid cap', 400, 'VALIDATION_ERROR');
    const row = await lookupBudget.setCap({
      userId: req.user.id,
      capUsd: cap,
      warnAtPct: Number(warnAtPct) || 80,
      hardBlockAtPct: Number(hardBlockAtPct) || 100,
    });
    res.json({ success: true, data: { budget: row } });
  }),

  // ---------------------------------------------------------------------
  // Per-user API key vault (PR #5 / #6)
  // ---------------------------------------------------------------------
  listKeys: asyncHandler(async (req, res) => {
    _assertIg(req);
    const [rows, configured] = await Promise.all([
      userLookupKeys.listKeys(req.user.id),
      userLookupKeys.configuredProviders(req.user.id),
    ]);
    res.json({
      success: true,
      data: {
        keys: rows,
        configured,
        providers: userLookupKeys.PROVIDERS,
      },
    });
  }),

  upsertKey: asyncHandler(async (req, res) => {
    _assertIg(req);
    const { provider, key, meta, label } = req.body || {};
    if (!provider || !key) throw new AppError('provider and key required', 400, 'VALIDATION_ERROR');
    const row = await userLookupKeys.upsertKey({
      userId: req.user.id,
      provider, key,
      meta: meta || {},
      label: label || null,
    });
    res.json({ success: true, data: { key: row } });
  }),

  deleteKey: asyncHandler(async (req, res) => {
    _assertIg(req);
    const { provider } = req.params;
    if (!provider) throw new AppError('provider required', 400, 'VALIDATION_ERROR');
    const r = await userLookupKeys.deleteKey({ userId: req.user.id, provider });
    res.json({ success: true, data: r });
  }),

  // ---------------------------------------------------------------------
  // Audit log (operator-visible, scoped to their own org)
  // ---------------------------------------------------------------------
  listAudit: asyncHandler(async (req, res) => {
    _assertIg(req);
    const { jobId, action, page, limit } = req.query;
    const out = await lookupAudit.list({
      userId: req.user.id,
      jobId: jobId ? parseInt(jobId, 10) : null,
      action,
      page, limit,
    });
    res.json({ success: true, data: out });
  }),

  // ---------------------------------------------------------------------
  // Dashboards (PR #8) — admin-only.
  // ---------------------------------------------------------------------
  riskDashboard: asyncHandler(async (req, res) => {
    _assertIg(req);
    if (req.user.role !== 'admin' && req.user.role !== 'owner') {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
    const [risk, slo, recentJobs] = await Promise.all([
      lookupRisk.riskCohort(),
      lookupRisk.sloLatencyDashboard(),
      lookupRisk.recentRiskJobs({ limit: 50 }),
    ]);
    res.json({ success: true, data: { risk, slo, recentJobs } });
  }),

  usageRollup: asyncHandler(async (req, res) => {
    _assertIg(req);
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
    const row = await lookupRisk.usageRollup({ userId: req.user.id, days });
    res.json({ success: true, data: { rollup: row, days } });
  }),
};

module.exports = lookupController;
