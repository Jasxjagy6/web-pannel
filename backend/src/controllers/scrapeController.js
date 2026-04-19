const scrapeService = require('../services/scrapeService');
const reportService = require('../services/reportService');
const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const scrapeController = {
  /**
   * Create and start a scraping job.
   * 
   * Accepts:
   * - sessionIds: number[] (1-10 sessions)
   * - targetIds: string[] (1-50 groups/channels) OR targetId for single
   * - targetType: 'group' | 'channel'
   * - limit: number per target
   * - filterBots: boolean
   * - botFilterOptions: object with advanced filters
   * - saveToList: boolean
   * - listName: string
   * - async: boolean (default true)
   */
  scrapeGroup: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const {
      sessionIds,
      sessionId,
      targetIds,
      groupId,
      targetId,
      limit = 1000,
      filterBots = true,
      botFilterOptions,
      saveToList = false,
      listName,
      interGroupDelay = 5,
      floodProtection = true,
      async = true,
    } = req.body;

    // Build session IDs array
    const sessions = sessionIds || (sessionId ? [parseInt(sessionId)] : []);
    
    // Build target IDs array
    const targets = targetIds || (groupId ? [groupId] : (targetId ? [targetId] : []));

    if (!sessions.length) {
      throw new AppError('sessionIds or sessionId is required', 400, 'MISSING_SESSIONS');
    }
    if (!targets.length) {
      throw new AppError('targetIds, groupId, or targetId is required', 400, 'MISSING_TARGETS');
    }

    // Create job
    const job = await scrapeService.createScrapeJob({
      sessionIds: sessions,
      targetIds: targets,
      targetType: 'group',
      limit: parseInt(limit),
      options: {
        filterBots,
        botFilterOptions,
        saveToList,
        listName,
        interGroupDelay,
        floodProtection,
      },
      userId,
    });

    // Start job
    const result = await scrapeService.startScrapeJob(job.jobId, async !== false);

    // Log activity
    await reportService.logActivity(userId, 'scrape_start', 'scrape_job', job.jobId, {
      sessionCount: sessions.length,
      targetCount: targets.length,
      limit,
      filterBots,
      async,
    });

    res.status(async ? 202 : 200).json({
      success: true,
      data: {
        ...result,
        sessionCount: sessions.length,
        targetCount: targets.length,
      },
    });
  }),

  /**
   * Scrape channel subscribers (same multi-session support).
   */
  scrapeChannel: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const {
      sessionIds,
      sessionId,
      targetIds,
      channelId,
      targetId,
      limit = 1000,
      filterBots = true,
      botFilterOptions,
      saveToList = false,
      listName,
      async = true,
    } = req.body;

    const sessions = sessionIds || (sessionId ? [parseInt(sessionId)] : []);
    const targets = targetIds || (channelId ? [channelId] : (targetId ? [targetId] : []));

    if (!sessions.length) {
      throw new AppError('sessionIds or sessionId is required', 400, 'MISSING_SESSIONS');
    }
    if (!targets.length) {
      throw new AppError('targetIds, channelId, or targetId is required', 400, 'MISSING_TARGETS');
    }

    const job = await scrapeService.createScrapeJob({
      sessionIds: sessions,
      targetIds: targets,
      targetType: 'channel',
      limit: parseInt(limit),
      options: {
        filterBots,
        botFilterOptions,
        saveToList,
        listName,
      },
      userId,
    });

    const result = await scrapeService.startScrapeJob(job.jobId, async !== false);

    await reportService.logActivity(userId, 'scrape_start', 'scrape_job', job.jobId, {
      sessionCount: sessions.length,
      targetCount: targets.length,
      targetType: 'channel',
      limit,
    });

    res.status(async ? 202 : 200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Get job details.
   */
  getJob: asyncHandler(async (req, res) => {
    const job = await scrapeService.getJob(req.params.id);
    if (!job) {
      throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    }
    res.json({ success: true, data: job });
  }),

  /**
   * Get job progress.
   */
  getJobProgress: asyncHandler(async (req, res) => {
    const progress = await scrapeService.getProgress(req.params.id);
    if (!progress) {
      throw new AppError('Job progress not found', 404, 'PROGRESS_NOT_FOUND');
    }
    res.json({ success: true, data: progress });
  }),

  /**
   * List jobs with pagination.
   */
  listJobs: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const sort = req.query.sort || 'created_at';
    const order = req.query.order || 'DESC';
    const filter = req.query.filter || undefined;

    const { jobs, pagination } = await scrapeService.listJobs(userId, {
      page,
      limit,
      sort,
      order,
      filter,
    });

    res.json({
      success: true,
      data: { jobs, pagination },
    });
  }),

  /**
   * Cancel a job.
   */
  cancelJob: asyncHandler(async (req, res) => {
    await scrapeService.cancelJob(req.params.id);
    res.json({ success: true, message: 'Job cancelled' });
  }),

  /**
   * Get scrape statistics.
   */
  getScrapeStats: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const stats = await scrapeService.getStats(userId);
    res.json({ success: true, data: stats });
  }),

  /**
   * Export scraped users with filters.
   */
  exportJob: asyncHandler(async (req, res) => {
    const jobId = req.params.id;
    const format = req.body.format || req.query.format || 'csv';
    
    // Get filters
    const filters = {
      excludeBots: req.body.excludeBots !== undefined ? req.body.excludeBots === 'true' : true,
      requireUsername: req.body.requireUsername === 'true',
      requirePhone: req.body.requirePhone === 'true',
      requirePhoto: req.body.requirePhoto === 'true',
      minBotScore: 0,
      maxBotScore: parseFloat(req.body.maxBotScore) || 1.0,
      columns: req.body.columns || null, // null = all columns
    };

    // Get job
    const job = await scrapeService.getJob(jobId);
    if (!job) {
      throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    }

    // Build query with filters
    const conditions = ['job_id = $1'];
    const params = [jobId];
    let paramIdx = 2;

    if (filters.excludeBots) {
      conditions.push(`(is_bot = FALSE OR is_bot IS NULL)`);
    }
    if (filters.requireUsername) {
      conditions.push(`username IS NOT NULL AND username != ''`);
    }
    if (filters.requirePhone) {
      conditions.push(`phone IS NOT NULL AND phone != ''`);
    }
    if (filters.maxBotScore < 1.0) {
      conditions.push(`bot_score <= $${paramIdx}`);
      params.push(filters.maxBotScore);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    // Get columns
    const allColumns = [
      'telegram_id', 'username', 'first_name', 'last_name', 'phone',
      'is_bot', 'is_premium', 'access_hash', 'bot_score', 'bot_flags',
      'account_created_at', 'has_profile_photo', 'bio', 'scraped_at'
    ];
    const columns = filters.columns || allColumns;
    const colSelect = columns.join(', ');

    const usersResult = await pool.query(
      `SELECT ${colSelect} FROM scraped_users WHERE ${whereClause} ORDER BY id ASC`,
      params
    );

    const users = usersResult.rows;

    // Generate export
    let content, mimeType, extension;

    if (format === 'json') {
      content = JSON.stringify(users, null, 2);
      mimeType = 'application/json';
      extension = 'json';
    } else if (format === 'csv') {
      const headers = columns.join(',');
      const rows = users.map(u => 
        columns.map(col => {
          const val = u[col];
          if (val === null || val === undefined) return '';
          if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
            return `"${val.replace(/"/g, '""')}"`;
          }
          return val;
        }).join(',')
      );
      content = [headers, ...rows].join('\n');
      mimeType = 'text/csv';
      extension = 'csv';
    } else {
      // TXT format
      content = users.map(u => {
        const parts = [];
        if (u.username) parts.push(`@${u.username}`);
        if (u.first_name) parts.push(u.first_name);
        if (u.phone) parts.push(u.phone);
        return parts.join(' | ');
      }).join('\n');
      mimeType = 'text/plain';
      extension = 'txt';
    }

    // Log export
    await reportService.logActivity(req.user.id, 'export', 'scrape_job', jobId, {
      format,
      recordCount: users.length,
      filters,
    });

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename=scrape_${jobId}.${extension}`);
    res.send(content);
  }),

  /**
   * Delete a scrape job.
   */
  deleteJob: asyncHandler(async (req, res) => {
    const jobId = req.params.id;
    const userId = req.user.id;

    // Verify ownership
    const job = await scrapeService.getJob(jobId);
    if (!job) {
      throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    }

    // Delete users and job
    await pool.query('DELETE FROM scraped_users WHERE job_id = $1', [jobId]);
    await pool.query('DELETE FROM scraping_jobs WHERE id = $1', [jobId]);

    res.json({ success: true, message: 'Job deleted' });
  }),
};

module.exports = scrapeController;
