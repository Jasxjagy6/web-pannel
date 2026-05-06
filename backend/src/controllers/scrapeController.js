const scrapeService = require('../services/scrapeService');
const reportService = require('../services/reportService');
const monitorService = require('../services/scrapeMonitorService');
const telegramService = require('../services/telegramService');
const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

function _isInstagram(req) { return req && req.platform === 'instagram'; }

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
      // Instagram-specific
      targetType: bodyTargetType,
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

    if (_isInstagram(req)) {
      // For Instagram, "scrapeGroup" maps to a followers/following/likers job.
      // The frontend sends `targetType: 'followers' | 'following' | 'likers'`
      // and the targets array carries usernames (or media PKs for likers).
      const igTargetType = ['followers', 'following', 'likers', 'commenters', 'tagged']
        .includes(bodyTargetType) ? bodyTargetType : 'followers';

      // Per-job proxy override (frontend "Use proxy" checkbox). Default
      // is true (respect the per-session proxy binding); when the
      // operator unticks the box we propagate use_proxy=false through
      // the job options so the scrape executor skips proxy enforcement
      // for this single job. Accept any body shape — `useProxy`,
      // `use_proxy`, or `proxy: false` — to be defensive.
      const bodyUseProxy =
        typeof req.body.useProxy !== 'undefined' ? req.body.useProxy
          : typeof req.body.use_proxy !== 'undefined' ? req.body.use_proxy
            : (req.body.proxy === false ? false : undefined);
      const useProxy = bodyUseProxy === false ? false : true;

      const job = await req.provider.scrape.createScrapeJob({
        userId,
        sessionIds: sessions.map((x) => parseInt(x, 10)),
        targetType: igTargetType,
        targetIdentifiers: targets.map(String),
        limit: parseInt(limit, 10) || 1000,
        options: { saveToList, listName, use_proxy: useProxy },
      });

      await reportService.logActivity(userId, 'scrape_start', 'scrape_job', job.id, {
        platform: 'instagram',
        targetType: igTargetType,
        sessionCount: sessions.length,
        targetCount: targets.length,
        limit,
        useProxy,
      });

      return res.status(202).json({
        success: true,
        data: {
          jobId: job.id,
          status: job.status,
          targetType: job.target_type,
          createdAt: job.created_at,
          sessionCount: sessions.length,
          targetCount: targets.length,
          platform: 'instagram',
        },
      });
    }

    // Telegram path (unchanged behaviour)
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
      platform: 'telegram',
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
    if (_isInstagram(req)) {
      const job = await req.provider.scrape.getJob(req.params.id, req.user.id);
      if (!job) throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
      return res.json({ success: true, data: job });
    }
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
    if (_isInstagram(req)) {
      const progress = await req.provider.scrape.getProgress(req.params.id, req.user.id);
      if (!progress) throw new AppError('Job progress not found', 404, 'PROGRESS_NOT_FOUND');
      return res.json({ success: true, data: progress });
    }
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

    if (_isInstagram(req)) {
      const filterObj = {};
      if (req.query.status) filterObj.status = req.query.status;
      if (req.query.target_type) filterObj.target_type = req.query.target_type;
      const data = await req.provider.scrape.listJobs(userId, {
        page, limit, sort, order, filter: filterObj,
      });
      const pagination = {
        currentPage: data.page,
        pageSize: data.limit,
        total: data.total,
        totalPages: Math.max(1, Math.ceil(data.total / data.limit)),
        hasNext: page * limit < data.total,
        hasPrev: page > 1,
      };
      return res.json({ success: true, data: { jobs: data.jobs, pagination } });
    }

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
    if (_isInstagram(req)) {
      const out = await req.provider.scrape.cancelJob(req.params.id, req.user.id);
      return res.json({ success: true, message: 'Job cancelled', data: out });
    }
    await scrapeService.cancelJob(req.params.id);
    res.json({ success: true, message: 'Job cancelled' });
  }),

  /**
   * Get scrape statistics.
   */
  getScrapeStats: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    if (_isInstagram(req)) {
      const stats = await req.provider.scrape.getStats(userId);
      return res.json({ success: true, data: stats });
    }
    const stats = await scrapeService.getStats(userId);
    res.json({ success: true, data: stats });
  }),

  /**
   * Export scraped users with filters.
   */
  exportJob: asyncHandler(async (req, res) => {
    const jobId = req.params.id;
    const format = req.body.format || req.query.format || 'csv';
    const ig = _isInstagram(req);

    // Get filters. v19: default excludeBots to FALSE so the export
    // reflects exactly what the scrape captured — operators were
    // running scrapes with bot-filtering off and then getting CSVs
    // that silently stripped every bot row anyway because the export
    // endpoint was opt-out instead of opt-in. Callers that want a
    // bots-removed CSV can still pass `excludeBots: true` explicitly.
    const _bool = (v, fallback) => {
      if (v === undefined || v === null) return fallback;
      if (typeof v === 'boolean') return v;
      return String(v).toLowerCase() === 'true';
    };
    const filters = {
      excludeBots: _bool(req.body.excludeBots, false),
      requireUsername: _bool(req.body.requireUsername, false),
      requirePhone: _bool(req.body.requirePhone, false),
      requirePhoto: _bool(req.body.requirePhoto, false),
      minBotScore: 0,
      maxBotScore: parseFloat(req.body.maxBotScore) || 1.0,
      columns: req.body.columns || null, // null = all columns
    };

    // Get job — scoped by platform
    const job = ig
      ? await req.provider.scrape.getJob(jobId, req.user.id)
      : await scrapeService.getJob(jobId);
    if (!job) {
      throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    }

    // Build query with filters
    const conditions = ['job_id = $1'];
    const params = [jobId];
    let paramIdx = 2;

    if (ig) {
      conditions.push(`platform = 'instagram'`);
    } else {
      conditions.push(`(platform = 'telegram' OR platform IS NULL)`);
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
    }

    const whereClause = conditions.join(' AND ');

    // Get columns. v19: surface every enriched field we capture so
    // CSV/JSON exports aren't artificially narrow. Operators can still
    // override via `body.columns`.
    const tgColumns = [
      'telegram_id', 'username', 'first_name', 'last_name', 'phone',
      'is_bot', 'is_premium', 'is_verified', 'is_scam', 'is_fake',
      'is_restricted', 'is_deleted', 'is_support', 'is_contact',
      'is_mutual_contact', 'is_close_friend', 'lang_code', 'status',
      'last_seen', 'access_hash', 'dc_id', 'has_profile_photo', 'bio',
      'restriction_reason', 'bot_score', 'bot_flags',
      'account_created_at', 'scraped_at',
    ];
    const igColumns = [
      'instagram_pk', 'username', 'full_name', 'is_private', 'is_verified',
      'is_business', 'account_type', 'has_profile_photo',
      'has_anonymous_profile_picture', 'thumbnail_url', 'profile_pic_id',
      'latest_reel_media', 'has_chaining', 'social_context', 'bio',
      'scraped_at',
    ];
    const allColumns = ig ? igColumns : tgColumns;
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
    const ig = _isInstagram(req);

    const job = ig
      ? await req.provider.scrape.getJob(jobId, userId)
      : await scrapeService.getJob(jobId);
    if (!job) {
      throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    }

    // Delete users and job — only matching this platform's data
    if (ig) {
      await pool.query(
        `DELETE FROM scraped_users WHERE job_id = $1 AND platform = 'instagram'`,
        [jobId]
      );
      await pool.query(
        `DELETE FROM scraping_jobs WHERE id = $1 AND user_id = $2 AND platform = 'instagram'`,
        [jobId, userId]
      );
    } else {
      await pool.query('DELETE FROM scraped_users WHERE job_id = $1', [jobId]);
      await pool.query('DELETE FROM scraping_jobs WHERE id = $1', [jobId]);
    }

    res.json({ success: true, message: 'Job deleted' });
  }),

  // ========================================================================
  // SCRAPE PREVIEW + ADMIN-ONLY DETECTION (used by the scraping upgrade)
  // ========================================================================

  /**
   * POST /api/scrape/preview
   *
   * Probe each requested target with the first available session and tell
   * the UI which targets are *admin-only* (chat hides its participant
   * roster from non-admins). For those targets the UI offers the user the
   * option to launch a period-bounded MONITOR job instead of failing.
   */
  previewTargets: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionIdRaw = req.body.sessionId
      ?? (Array.isArray(req.body.sessionIds) ? req.body.sessionIds[0] : null);
    const targetType = req.body.targetType || 'group';
    const targets = Array.isArray(req.body.targets)
      ? req.body.targets
      : (req.body.target ? [req.body.target] : []);

    if (!sessionIdRaw) throw new AppError('sessionId required', 400, 'MISSING_SESSION');
    if (!targets.length) throw new AppError('targets required', 400, 'MISSING_TARGETS');

    const sessionId = parseInt(sessionIdRaw, 10);
    const owned = await pool.query(
      `SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND is_logged_in=TRUE`,
      [sessionId, userId]
    );
    if (!owned.rows[0]) {
      throw new AppError('Session not found or not logged in', 400, 'INVALID_SESSION');
    }

    const results = [];
    for (const t of targets) {
      try {
        const probe = await telegramService.probeScrapeAccess(String(sessionId), String(t));
        results.push({ target: String(t), targetType, ...probe });
      } catch (err) {
        results.push({
          target: String(t), targetType, canScrape: false, isAdminOnly: false,
          reason: err.message, info: {},
        });
      }
    }
    res.json({ success: true, data: { results } });
  }),

  // ========================================================================
  // SCRAPE MONITOR (period-bounded passive scraper for admin-only chats)
  // ========================================================================

  createMonitor: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const {
      sessionIds, sessionId, targetId, targetType,
      durationSeconds, durationDays, durationHours, durationMinutes,
      targetTitle, reason, options, autoStart,
      dedupEnabled, allowDuplicates,
    } = req.body || {};

    const sessions = Array.isArray(sessionIds) && sessionIds.length
      ? sessionIds
      : (sessionId ? [parseInt(sessionId, 10)] : []);

    let duration = parseInt(durationSeconds, 10);
    if (!Number.isFinite(duration) || duration <= 0) {
      const days = parseFloat(durationDays) || 0;
      const hours = parseFloat(durationHours) || 0;
      const minutes = parseFloat(durationMinutes) || 0;
      duration = Math.floor(days * 86400 + hours * 3600 + minutes * 60);
    }

    // v10: Resolve the dedup toggle. Accept all of:
    //   { dedupEnabled: true|false }
    //   { allowDuplicates: true|false }   (mirror; true = dedup OFF)
    //   { options: { dedupEnabled / allowDuplicates: ... } }
    // Any unset field defers to the next, and the service falls back
    // to the v6 default (dedup ON) if none are present.
    let resolvedDedup;
    if (dedupEnabled !== undefined) resolvedDedup = !!dedupEnabled;
    else if (allowDuplicates !== undefined) resolvedDedup = !allowDuplicates;

    const job = await monitorService.createJob({
      userId,
      sessionIds: sessions,
      targetId,
      targetType: targetType || 'group',
      targetTitle: targetTitle || null,
      durationSeconds: duration,
      reason: reason || null,
      options: options || {},
      autoStart: autoStart !== false,
      dedupEnabled: resolvedDedup,
    });

    await reportService.logActivity(userId, 'monitor_start', 'scrape_monitor', job.id, {
      sessionCount: sessions.length, targetId, durationSeconds: duration,
    });

    res.status(202).json({ success: true, data: job });
  }),

  listMonitors: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const status = req.query.status || undefined;
    const search = req.query.search || undefined;
    const data = await monitorService.listJobs(userId, { page, limit, status, search });
    res.json({ success: true, data });
  }),

  getMonitor: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const data = await monitorService.getJob(parseInt(req.params.id, 10), userId);
    res.json({ success: true, data });
  }),

  pauseMonitor: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const data = await monitorService.pauseJob(parseInt(req.params.id, 10), userId);
    res.json({ success: true, data });
  }),

  resumeMonitor: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const data = await monitorService.resumeJob(parseInt(req.params.id, 10), userId);
    res.json({ success: true, data });
  }),

  stopMonitor: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const data = await monitorService.stopJob(parseInt(req.params.id, 10), userId, 'cancelled');
    res.json({ success: true, data });
  }),

  cancelAllMonitors: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const data = await monitorService.cancelAll(userId);
    res.json({ success: true, data });
  }),

  monitorUsers: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = parseInt(req.params.id, 10);
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 50);
    const search = req.query.search || undefined;
    const data = await monitorService.listScrapedUsers(jobId, userId, { page, limit, search });
    res.json({ success: true, data });
  }),

  exportMonitor: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = parseInt(req.params.id, 10);
    const format = (req.body?.format || req.query.format || 'csv').toLowerCase();
    // Authorize via list (which verifies ownership) and grab everything in one go.
    const { users } = await monitorService.listScrapedUsers(jobId, userId, {
      page: 1, limit: 100000,
    });

    let content; let mime; let ext;
    if (format === 'json') {
      content = JSON.stringify(users, null, 2);
      mime = 'application/json'; ext = 'json';
    } else if (format === 'txt') {
      content = users.map((u) => {
        const parts = [];
        if (u.username) parts.push(`@${u.username}`);
        if (u.first_name) parts.push(u.first_name);
        if (u.phone) parts.push(u.phone);
        return parts.join(' | ');
      }).join('\n');
      mime = 'text/plain'; ext = 'txt';
    } else {
      const cols = [
        'telegram_id', 'username', 'first_name', 'last_name', 'phone',
        'is_bot', 'is_premium', 'is_verified', 'is_scam', 'is_fake',
        'is_restricted', 'is_deleted', 'is_support', 'is_contact',
        'is_mutual_contact', 'is_close_friend', 'lang_code', 'status',
        'access_hash', 'dc_id', 'has_profile_photo', 'bio',
        'restriction_reason', 'message_count', 'first_seen_at', 'last_seen_at',
      ];
      const escape = (val) => {
        if (val === null || val === undefined) return '';
        const s = String(val);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = cols.join(',');
      const rows = users.map((u) => cols.map((c) => escape(u[c])).join(','));
      content = [header, ...rows].join('\n');
      mime = 'text/csv'; ext = 'csv';
    }

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename=monitor_${jobId}.${ext}`);
    res.send(content);
  }),
};

module.exports = scrapeController;
