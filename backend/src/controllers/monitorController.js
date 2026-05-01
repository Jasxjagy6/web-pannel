const monitorService = require('../services/monitorService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');

const HOURS = 60 * 60;
const DAYS = 24 * HOURS;

function publicJob(j) {
  if (!j) return null;
  return {
    id: j.id,
    userId: j.user_id,
    scrapingJobId: j.scraping_job_id,
    target: j.target,
    targetType: j.target_type,
    targetId: j.target_id,
    targetTitle: j.target_title,
    durationSeconds: j.duration_seconds,
    startedAt: j.started_at,
    endsAt: j.ends_at,
    pausedAt: j.paused_at,
    pauseRemainingSeconds: j.pause_remaining_seconds,
    sessionIds: j.session_ids,
    lastOffsetId: j.last_offset_id != null ? String(j.last_offset_id) : null,
    nextPollAt: j.next_poll_at,
    scrapedCount: j.scraped_count,
    ticksCompleted: j.ticks_completed,
    consecutiveErrors: j.consecutive_errors,
    status: j.status,
    lastError: j.last_error,
    options: j.options,
    usersCount: j.users_count != null ? Number(j.users_count) : undefined,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  };
}

const monitorController = {
  /**
   * POST /api/scrape/monitor
   * Body: { sessionIds: number[], target: string, durationHours?, durationDays?, durationSeconds?, scrapingJobId? }
   */
  createJob: asyncHandler(async (req, res) => {
    const { sessionIds, target, durationHours, durationDays, durationSeconds, scrapingJobId, options } = req.body || {};
    let secs = 0;
    if (durationSeconds) secs = parseInt(durationSeconds, 10);
    else if (durationHours) secs = Math.round(parseFloat(durationHours) * HOURS);
    else if (durationDays) secs = Math.round(parseFloat(durationDays) * DAYS);
    if (!secs || !Number.isFinite(secs) || secs <= 0) {
      throw new AppError('duration is required (durationDays/durationHours/durationSeconds)', 400, 'INVALID_DURATION');
    }
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('sessionIds is required (non-empty array)', 400, 'INVALID_SESSIONS');
    }
    if (!target) {
      throw new AppError('target is required', 400, 'INVALID_TARGET');
    }

    let job;
    try {
      job = await monitorService.createMonitorJob({
        userId: req.user.id,
        sessionIds,
        target: String(target),
        durationSeconds: secs,
        scrapingJobId: scrapingJobId ? parseInt(scrapingJobId, 10) : null,
        options: options || {},
      });
    } catch (e) {
      throw new AppError(e.message, 400, 'CREATE_FAILED');
    }

    await reportService.logActivity(req.user.id, 'monitor_start', 'monitor_job', job.id, {
      target: job.target, durationSeconds: secs, sessionIds,
    }).catch(() => {});

    res.status(201).json({ success: true, data: publicJob(job) });
  }),

  list: asyncHandler(async (req, res) => {
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const jobs = await monitorService.listJobs({ userId: req.user.id, limit });
    res.json({ success: true, data: { jobs: jobs.map(publicJob) } });
  }),

  get: asyncHandler(async (req, res) => {
    const j = await monitorService.getJob({ userId: req.user.id, jobId: parseInt(req.params.id, 10) });
    if (!j) throw new AppError('Job not found', 404, 'NOT_FOUND');
    res.json({ success: true, data: publicJob(j) });
  }),

  users: asyncHandler(async (req, res) => {
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const search = req.query.search || null;
    const jobId = parseInt(req.params.id, 10);
    try {
      const r = await monitorService.listUsers({ userId: req.user.id, jobId, limit, offset, search });
      res.json({ success: true, data: r });
    } catch (e) {
      throw new AppError(e.message, 404, 'NOT_FOUND');
    }
  }),

  pause: asyncHandler(async (req, res) => {
    const j = await monitorService.pauseJob({
      userId: req.user.id, jobId: parseInt(req.params.id, 10),
    }).catch((e) => { throw new AppError(e.message, 400, 'PAUSE_FAILED'); });
    res.json({ success: true, data: publicJob(j) });
  }),

  resume: asyncHandler(async (req, res) => {
    const j = await monitorService.resumeJob({
      userId: req.user.id, jobId: parseInt(req.params.id, 10),
    }).catch((e) => { throw new AppError(e.message, 400, 'RESUME_FAILED'); });
    res.json({ success: true, data: publicJob(j) });
  }),

  stop: asyncHandler(async (req, res) => {
    const j = await monitorService.stopJob({
      userId: req.user.id, jobId: parseInt(req.params.id, 10),
    }).catch((e) => { throw new AppError(e.message, 400, 'STOP_FAILED'); });
    await reportService.logActivity(req.user.id, 'monitor_stop', 'monitor_job', j.id, {}).catch(() => {});
    res.json({ success: true, data: publicJob(j) });
  }),

  cancelAll: asyncHandler(async (req, res) => {
    const r = await monitorService.cancelAll({ userId: req.user.id });
    await reportService.logActivity(req.user.id, 'monitor_cancel_all', 'monitor_job', null, r).catch(() => {});
    res.json({ success: true, data: r });
  }),
};

module.exports = monitorController;
