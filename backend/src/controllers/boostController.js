const boostService = require('../services/boostService');
const { asyncHandler } = require('../utils/errorHandler');

module.exports = {
  listAccounts: asyncHandler(async (req, res) => {
    const accounts = await boostService.listPremiumAccounts(req.user.id, {
      refresh: req.query.refresh === 'true',
    });
    res.json({ success: true, data: { accounts } });
  }),

  inspectAccount: asyncHandler(async (req, res) => {
    const slots = await boostService.inspectAccount(req.user.id, Number(req.params.sessionId));
    res.json({ success: true, data: slots });
  }),

  createJob: asyncHandler(async (req, res) => {
    const result = await boostService.createJob(req.body || {}, req.user.id);
    res.status(202).json({ success: true, data: result });
  }),

  listJobs: asyncHandler(async (req, res) => {
    const jobs = await boostService.listJobs(req.user.id, req.query || {});
    res.json({ success: true, data: { jobs } });
  }),

  getJob: asyncHandler(async (req, res) => {
    const job = await boostService.getJob(req.params.id, req.user.id);
    res.json({ success: true, data: job });
  }),

  cancelJob: asyncHandler(async (req, res) => {
    const result = await boostService.cancelJob(req.params.id, req.user.id);
    res.json({ success: true, data: result });
  }),
};
