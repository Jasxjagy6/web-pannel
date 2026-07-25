'use strict';

const service = require('../services/usernameValidationService');
const linkFilterService = require('../services/linkUsernameFilterService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');

function assertTelegram(req) {
  if (req.platform && req.platform !== 'telegram') {
    throw new AppError(
      'Live username validation is available for Telegram lists only',
      400,
      'TELEGRAM_ONLY'
    );
  }
}

module.exports = {
  start: asyncHandler(async (req, res) => {
    assertTelegram(req);
    const job = await service.startJob({
      userId: req.user.id,
      sourceListId: req.body?.sourceListId,
      sessionListId: req.body?.sessionListId,
      sessionListIds: req.body?.sessionListIds,
      resultListName: req.body?.resultListName,
      retryAfterFloodWait: req.body?.retryAfterFloodWait === true,
    });
    reportService.logActivity(
      req.user.id,
      'list_username_validation_start',
      'list',
      job.sourceListId,
      {
        jobId: job.id,
        sessionListIds: job.sessionListIds,
        resultListId: job.resultListId,
        totalUsernames: job.totalCount,
        retryAfterFloodWait: job.retryAfterFloodWait,
      }
    ).catch(() => {});
    res.status(202).json({ success: true, data: job });
  }),

  list: asyncHandler(async (req, res) => {
    assertTelegram(req);
    const jobs = await service.listJobs(req.user.id, { limit: req.query.limit });
    res.json({ success: true, data: { jobs } });
  }),

  get: asyncHandler(async (req, res) => {
    assertTelegram(req);
    const job = await service.getJob(req.user.id, req.params.jobId);
    res.json({ success: true, data: job });
  }),

  cancel: asyncHandler(async (req, res) => {
    assertTelegram(req);
    const job = await service.cancelJob(req.user.id, req.params.jobId);
    res.json({ success: true, data: job });
  }),

  /** Queue a persisted, sessionless t.me validation job. */
  linkFilter: asyncHandler(async (req, res) => {
    assertTelegram(req);
    const job = await linkFilterService.startJob({
      userId: req.user.id,
      sourceListId: req.body?.sourceListId,
      resultListName: req.body?.resultListName,
    });
    await reportService.logActivity(
      req.user.id,
      'list_username_link_filter',
      'list',
      job.sourceListId,
      {
        jobId: job.id,
        resultListId: job.resultListId,
        totalUsernames: job.totalCount,
      }
    ).catch(() => {});
    res.status(202).json({ success: true, data: job });
  }),
};
