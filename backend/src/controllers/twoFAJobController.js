const twoFAJobService = require('../services/twoFAJobService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const twoFAJobController = {
  /** POST /api/2fa-jobs/bulk */
  createBulkJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionIds, oldPassword, newPassword } = req.body || {};

    const result = await twoFAJobService.createBulkJob({
      userId,
      sessionIds: Array.isArray(sessionIds) ? sessionIds.map(Number) : [],
      oldPassword,
      newPassword,
    });

    await reportService.logActivity(userId, 'twofa_bulk_job', 'twofa_job', result.jobId, {
      total: result.total,
    }).catch(() => {});

    return res.status(201).json({ success: true, data: result });
  }),

  /** POST /api/2fa-jobs/individual */
  createIndividualJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError('items array required', 400, 'NO_ITEMS');
    }
    const result = await twoFAJobService.createIndividualJob({ userId, items });
    await reportService.logActivity(userId, 'twofa_individual_job', 'twofa_job', result.jobId, {
      total: result.total,
    }).catch(() => {});
    return res.status(201).json({ success: true, data: result });
  }),

  /** GET /api/2fa-jobs */
  listJobs: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit, 10) || 50;
    const jobs = await twoFAJobService.listJobs(userId, { limit });
    return res.json({ success: true, data: { jobs } });
  }),

  /** GET /api/2fa-jobs/:id */
  getJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = Number(req.params.id);
    if (!jobId) throw new AppError('Invalid job id', 400, 'BAD_ID');
    const job = await twoFAJobService.getJob(jobId, userId);
    return res.json({ success: true, data: { job } });
  }),
};

module.exports = twoFAJobController;
