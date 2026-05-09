const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const reportController = {
  /**
   * Generate a channel analytics report.
   *
   * Query params: channelId (required), period (24h|7d|30d|90d|custom), periodStart, periodEnd
   * periodStart and periodEnd are required only when period=custom.
   */
  generateChannelReport: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const channelId = req.params.id;
    const { period, periodStart, periodEnd } = req.query;

    if (!channelId) {
      throw new AppError('channelId is required', 400, 'MISSING_CHANNEL_ID');
    }

    const reportPeriod = period || '7d';

    let customDates = {};
    if (reportPeriod === 'custom') {
      if (!periodStart || !periodEnd) {
        throw new AppError(
          'periodStart and periodEnd are required when period is "custom"',
          400,
          'MISSING_CUSTOM_DATES'
        );
      }
      customDates = { periodStart, periodEnd };
    }

    const report = await reportService.generateChannelReport(channelId, reportPeriod, userId, customDates);

    await reportService.logActivity(
      userId,
      'report_generate',
      'report',
      null,
      {
        reportType: 'channel',
        channelId: String(channelId),
        period: reportPeriod,
      }
    );

    logger.info(`Channel report generated for ${channelId} by user ${userId}`, {
      period: reportPeriod,
    });

    return res.status(200).json({
      success: true,
      data: report,
    });
  }),

  /**
   * Generate a group analytics report.
   *
   * Query params: groupId (required), period (24h|7d|30d|90d|custom), periodStart, periodEnd
   */
  generateGroupReport: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const groupId = req.params.id;
    const { period, periodStart, periodEnd } = req.query;

    if (!groupId) {
      throw new AppError('groupId is required', 400, 'MISSING_GROUP_ID');
    }

    const reportPeriod = period || '7d';

    let customDates = {};
    if (reportPeriod === 'custom') {
      if (!periodStart || !periodEnd) {
        throw new AppError(
          'periodStart and periodEnd are required when period is "custom"',
          400,
          'MISSING_CUSTOM_DATES'
        );
      }
      customDates = { periodStart, periodEnd };
    }

    const report = await reportService.generateGroupReport(groupId, reportPeriod, userId, customDates);

    await reportService.logActivity(
      userId,
      'report_generate',
      'report',
      null,
      {
        reportType: 'group',
        groupId: String(groupId),
        period: reportPeriod,
      }
    );

    logger.info(`Group report generated for ${groupId} by user ${userId}`, {
      period: reportPeriod,
    });

    return res.status(200).json({
      success: true,
      data: report,
    });
  }),

  /**
   * Generate a user activity report for a specific Telegram user.
   *
   * Query params: userId (required) - the target user's Telegram ID
   */
  generateUserReport: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const targetUserId = req.params.id;

    if (!targetUserId) {
      throw new AppError('userId query parameter is required (the target user Telegram ID)', 400, 'MISSING_TARGET_USER_ID');
    }

    const report = await reportService.generateUserReport(targetUserId, userId);

    await reportService.logActivity(
      userId,
      'report_generate',
      'report',
      null,
      {
        reportType: 'user',
        targetUserId: String(targetUserId),
      }
    );

    logger.info(`User report generated for target ${targetUserId} by user ${userId}`);

    return res.status(200).json({
      success: true,
      data: report,
    });
  }),

  /**
   * Generate a session performance report.
   *
   * Query params: sessionId (required), period (24h|7d|30d|90d|custom), periodStart, periodEnd
   */
  generateSessionReport: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;
    const { period, periodStart, periodEnd } = req.query;

    if (!sessionId) {
      throw new AppError('sessionId is required', 400, 'MISSING_SESSION_ID');
    }

    const reportPeriod = period || '7d';

    let customDates = {};
    if (reportPeriod === 'custom') {
      if (!periodStart || !periodEnd) {
        throw new AppError(
          'periodStart and periodEnd are required when period is "custom"',
          400,
          'MISSING_CUSTOM_DATES'
        );
      }
      customDates = { periodStart, periodEnd };
    }

    const report = await reportService.generateSessionReport(sessionId, reportPeriod, userId, customDates);

    await reportService.logActivity(
      userId,
      'report_generate',
      'report',
      null,
      {
        reportType: 'session',
        sessionId: Number(sessionId),
        period: reportPeriod,
      }
    );

    logger.info(`Session report generated for session ${sessionId} by user ${userId}`, {
      period: reportPeriod,
    });

    return res.status(200).json({
      success: true,
      data: report,
    });
  }),

  /**
   * Save a generated report to the database.
   *
   * Expects req.body: { reportType, targetId?, targetTitle?, periodStart?, periodEnd?, data }
   */
  saveReport: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { reportType, targetId, targetTitle, periodStart, periodEnd, data } = req.body;

    if (!reportType) {
      throw new AppError('reportType is required', 400, 'MISSING_REPORT_TYPE');
    }

    if (!data || typeof data !== 'object') {
      throw new AppError('Report data is required and must be a valid object', 400, 'MISSING_REPORT_DATA');
    }

    const result = await reportService.saveReport(
      userId,
      reportType,
      targetId,
      targetTitle,
      periodStart,
      periodEnd,
      data
    );

    await reportService.logActivity(
      userId,
      'report_generate',
      'report',
      result.reportId,
      {
        reportType,
        targetId,
        targetTitle,
        saved: true,
      }
    );

    logger.info(`Report saved by user ${userId}`, {
      reportId: result.reportId,
      reportType,
    });

    return res.status(201).json({
      success: true,
      data: result,
    });
  }),

  /**
   * List saved reports with pagination and optional filter.
   *
   * Query params: page, limit, reportType
   */
  getSavedReports: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const reportType = req.query.reportType || undefined;

    const { reports, pagination } = await reportService.getSavedReports(userId, {
      page,
      limit,
      reportType,
    });

    return res.status(200).json({
      success: true,
      data: {
        reports,
        pagination,
      },
    });
  }),

  /**
   * Get a specific saved report by its ID.
   *
   * Report ID comes from req.params.id.
   */
  getReport: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const reportId = req.params.id;

    if (!reportId) {
      throw new AppError('Report ID is required', 400, 'MISSING_REPORT_ID');
    }

    const report = await reportService.getReportById(reportId, userId);

    return res.status(200).json({
      success: true,
      data: report,
    });
  }),

  /**
   * Export a saved report in the specified format.
   *
   * Report ID comes from req.params.id.
   * Query params: format (csv|json, default: json)
   */
  exportReport: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const reportId = req.params.id;
    const format = req.body.format || req.query.format || 'json';

    if (!reportId) {
      throw new AppError('Report ID is required', 400, 'MISSING_REPORT_ID');
    }

    const { content, filename, mimeType, reportType } = await reportService.exportReport(reportId, format, userId);

    await reportService.logActivity(
      userId,
      'report_export',
      'report',
      reportId,
      { format, reportType }
    );

    logger.info(`Report ${reportId} exported as ${format} by user ${userId}`, {
      format,
      reportType,
    });

    // Set appropriate headers for file download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', Buffer.byteLength(content));

    return res.status(200).send(content);
  }),

  /**
   * Delete a saved report.
   *
   * Report ID comes from req.params.id.
   */
  deleteReport: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const reportId = req.params.id;

    if (!reportId) {
      throw new AppError('Report ID is required', 400, 'MISSING_REPORT_ID');
    }

    const result = await reportService.deleteReport(reportId, userId);

    await reportService.logActivity(
      userId,
      'report_delete',
      'report',
      reportId,
      {}
    );

    logger.info(`Report ${reportId} deleted by user ${userId}`);

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Get the activity log with optional filters.
   *
   * Query params: page, limit, action, entityType
   */
  getActivityLog: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const action = req.query.action || undefined;
    const entityType = req.query.entityType || undefined;

    const { activities, pagination } = await reportService.getActivityLog(userId, {
      page,
      limit,
      action,
      entityType,
    });

    return res.status(200).json({
      success: true,
      data: {
        activities,
        pagination,
      },
    });
  }),

  // ---------------------------------------------------------------------
  // Panel-wide reports (institutional-level)
  // ---------------------------------------------------------------------

  /**
   * GET /api/reports/overview - Panel-wide overview report.
   *
   * Query params: period (24h|7d|30d|90d|custom|all, default 7d),
   * periodStart, periodEnd (required for period=custom).
   */
  getOverview: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { period, periodStart, periodEnd } = req.query;
    const reportPeriod = period || '7d';
    const customDates = (reportPeriod === 'custom')
      ? { periodStart, periodEnd }
      : {};

    const overview = await reportService.getOverview(userId, reportPeriod, customDates);

    return res.status(200).json({
      success: true,
      data: overview,
    });
  }),

  /**
   * GET /api/reports/sessions/summary - Per-session aggregated stats.
   *
   * Query params: page, limit, sortBy (sent|failed|scraped|jobs|created_at),
   * sortDir (asc|desc).
   */
  getSessionsSummary: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const sortBy = req.query.sortBy || 'sent';
    const sortDir = req.query.sortDir || 'desc';

    const result = await reportService.getSessionsSummary(userId, {
      page, limit, sortBy, sortDir,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * GET /api/reports/messaging/summary - Messaging job report.
   *
   * Query params: page, limit, jobType, status, periodStart, periodEnd.
   */
  getMessagingSummary: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const result = await reportService.getMessagingSummary(userId, {
      page: req.query.page ? parseInt(req.query.page, 10) : 1,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 20,
      jobType: req.query.jobType || undefined,
      status: req.query.status || undefined,
      periodStart: req.query.periodStart || undefined,
      periodEnd: req.query.periodEnd || undefined,
    });
    return res.status(200).json({ success: true, data: result });
  }),

  /**
   * GET /api/reports/scraping/summary - Scraping job report.
   *
   * Query params: page, limit, status, targetType, periodStart, periodEnd.
   */
  getScrapingSummary: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const result = await reportService.getScrapingSummary(userId, {
      page: req.query.page ? parseInt(req.query.page, 10) : 1,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 20,
      status: req.query.status || undefined,
      targetType: req.query.targetType || undefined,
      periodStart: req.query.periodStart || undefined,
      periodEnd: req.query.periodEnd || undefined,
    });
    return res.status(200).json({ success: true, data: result });
  }),

  /**
   * GET /api/reports/group-ops/summary - Group-operations report.
   *
   * Query params: page, limit, status, operation, periodStart, periodEnd.
   */
  getGroupOpsSummary: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const result = await reportService.getGroupOpsSummary(userId, {
      page: req.query.page ? parseInt(req.query.page, 10) : 1,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 20,
      status: req.query.status || undefined,
      operation: req.query.operation || undefined,
      periodStart: req.query.periodStart || undefined,
      periodEnd: req.query.periodEnd || undefined,
    });
    return res.status(200).json({ success: true, data: result });
  }),

  /**
   * GET /api/reports/lists/summary - Lists report.
   *
   * Query params: page, limit, type.
   */
  getListsSummary: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const result = await reportService.getListsSummary(userId, {
      page: req.query.page ? parseInt(req.query.page, 10) : 1,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 20,
      type: req.query.type || undefined,
    });
    return res.status(200).json({ success: true, data: result });
  }),

  /**
   * GET /api/reports/export/overview - Download the panel overview as
   * CSV or JSON.
   *
   * Query params: format (csv|json, default json), period, periodStart, periodEnd.
   */
  exportOverview: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const format = (req.query.format || 'json').toLowerCase();
    const period = req.query.period || '7d';
    const customDates = (period === 'custom')
      ? { periodStart: req.query.periodStart, periodEnd: req.query.periodEnd }
      : {};

    const { content, filename, mimeType } = await reportService.exportOverview(
      userId, period, format, customDates
    );

    await reportService.logActivity(userId, 'report_export', 'report', null, {
      reportType: 'overview',
      period,
      format,
    });

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', Buffer.byteLength(content));
    return res.status(200).send(content);
  }),
};

module.exports = reportController;
