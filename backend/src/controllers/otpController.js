const otpService = require('../services/otpService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const { resolveSessionIdsFromRequest } = require('../utils/resolveSessions');

const otpController = {
  /** POST /api/otp/jobs */
  createJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionIds: rawSessionIds, durationSeconds } = req.body || {};
    const expanded = await resolveSessionIdsFromRequest(req, rawSessionIds || []);
    const result = await otpService.createJob({
      userId,
      sessionIds: Array.isArray(expanded) ? expanded.map(Number) : [],
      durationSeconds: durationSeconds ? Number(durationSeconds) : undefined,
    });
    await reportService.logActivity(userId, 'otp_job', 'otp_job', result.jobId, {
      total: result.total,
      durationSeconds: result.durationSeconds,
    }).catch(() => {});
    return res.status(201).json({ success: true, data: result });
  }),

  /** GET /api/otp/jobs */
  listJobs: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit, 10) || 50;
    const jobs = await otpService.listJobs(userId, { limit });
    return res.json({ success: true, data: { jobs } });
  }),

  /** GET /api/otp/jobs/:id */
  getJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = Number(req.params.id);
    if (!jobId) throw new AppError('Invalid job id', 400, 'BAD_ID');
    const job = await otpService.getJob(jobId, userId);
    return res.json({ success: true, data: { job } });
  }),
};

module.exports = otpController;
