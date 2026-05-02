const reportService = require('../services/reportService');
const sessionService = require('../services/sessionService');
const scrapeService = require('../services/scrapeService');
const messageService = require('../services/messageService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

function _isInstagram(req) { return req && req.platform === 'instagram'; }

const dashboardController = {
  /**
   * Get comprehensive dashboard statistics for the authenticated user.
   *
   * Aggregates data from sessions, scraping, messaging, group operations,
   * and lists into a single response. Also includes top performing sessions
   * and recent activity.
   *
   * Query params: period (optional: 24h|7d|30d|90d, default: 7d)
   * Note: period is logged but the underlying service returns all-time + time-bucketed data.
   */
  getStats: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const period = req.query.period || '7d';

    logger.info(`Dashboard stats requested by user ${userId}`, { period, platform: req.platform });

    // Instagram dashboard: scope all numbers to the IG platform via the
    // IG provider so TG numbers don't bleed into the IG header KPI cards.
    if (_isInstagram(req)) {
      const provider = req.provider;
      const [igSessionStats, igScrapeStats, recent] = await Promise.all([
        provider.sessions.getSessionStats(userId),
        provider.scrape.getStats(userId),
        reportService.getActivityLog(userId, { page: 1, limit: 10 }),
      ]);
      const response = {
        platform: 'instagram',
        overview: {
          sessions: {
            total: igSessionStats.total || 0,
            active: igSessionStats.active || 0,
            loggedIn: igSessionStats.logged_in || 0,
            banned: igSessionStats.banned || 0,
          },
          scraping: {
            totalJobs: igScrapeStats.total_jobs || 0,
            completedJobs: igScrapeStats.completed_jobs || 0,
            failedJobs: igScrapeStats.failed_jobs || 0,
            activeJobs: igScrapeStats.active_jobs || 0,
            totalUsersFound: igScrapeStats.total_users_scraped || 0,
            byTargetType: igScrapeStats.by_target_type || {},
          },
        },
        sessionStats: {
          total: igSessionStats.total || 0,
          active: igSessionStats.active || 0,
          loggedIn: igSessionStats.logged_in || 0,
          banned: igSessionStats.banned || 0,
        },
        scrapeStats: {
          totalJobs: igScrapeStats.total_jobs || 0,
          completedJobs: igScrapeStats.completed_jobs || 0,
          failedJobs: igScrapeStats.failed_jobs || 0,
          totalUsersScraped: igScrapeStats.total_users_scraped || 0,
          jobsByType: igScrapeStats.by_target_type || {},
        },
        recentActivity: (recent.activities || []).filter(
          (a) => !a.metadata || !a.metadata.platform || a.metadata.platform === 'instagram'
        ),
        generatedAt: new Date().toISOString(),
        period,
      };
      return res.status(200).json({ success: true, data: response });
    }

    // Get the core dashboard stats from report service
    const [
      dashboardStats,
      scrapeStats,
      messagingStats,
      sessionStats,
    ] = await Promise.all([
      reportService.getDashboardStats(userId),
      scrapeService.getStats(userId),
      messageService.getMessagingStats(userId),
      sessionService.getSessionStats(userId),
    ]);

    // Build a comprehensive response merging all data sources
    const response = {
      overview: {
        sessions: dashboardStats.sessions,
        scraping: {
          totalJobs: dashboardStats.scraping.totalJobs,
          totalUsersFound: dashboardStats.scraping.totalUsersFound,
          uniqueUsers: dashboardStats.scraping.uniqueScrapedUsers,
          completedJobs: dashboardStats.scraping.completedJobs,
          failedJobs: dashboardStats.scraping.failedJobs,
          successRate: dashboardStats.scraping.successRate,
          today: dashboardStats.scraping.today,
          thisWeek: dashboardStats.scraping.thisWeek,
          thisMonth: dashboardStats.scraping.thisMonth,
        },
        messaging: {
          totalJobs: dashboardStats.messaging.totalJobs,
          totalSent: dashboardStats.messaging.totalSent,
          totalFailed: dashboardStats.messaging.totalFailed,
          totalSkipped: dashboardStats.messaging.totalSkipped,
          successRate: dashboardStats.messaging.successRate,
          today: dashboardStats.messaging.today,
          thisWeek: dashboardStats.messaging.thisWeek,
          thisMonth: dashboardStats.messaging.thisMonth,
        },
        groupOperations: dashboardStats.groupOperations,
        lists: dashboardStats.lists,
      },
      successRates: dashboardStats.successRates,
      topSessions: dashboardStats.topSessions,
      recentActivity: dashboardStats.recentActivity,
      scrapeStats: {
        totalJobs: scrapeStats.totalJobs,
        completedJobs: scrapeStats.completedJobs,
        failedJobs: scrapeStats.failedJobs,
        cancelledJobs: scrapeStats.cancelledJobs,
        pendingJobs: scrapeStats.pendingJobs,
        runningJobs: scrapeStats.runningJobs,
        totalUsersScraped: scrapeStats.totalUsersScraped,
        successRate: scrapeStats.successRate,
        averageUsersPerJob: scrapeStats.averageUsersPerJob,
        lastJobDate: scrapeStats.lastJobDate,
        jobsByType: scrapeStats.jobsByType,
        recentJobs: scrapeStats.recentJobs,
      },
      messagingStats: {
        totalJobs: messagingStats.totalJobs,
        totalMessages: messagingStats.totalMessages,
        totalSent: messagingStats.totalSent,
        totalFailed: messagingStats.totalFailed,
        totalSkipped: messagingStats.totalSkipped,
        successRate: messagingStats.successRate,
        jobsByStatus: messagingStats.jobsByStatus,
        messagesByStatus: messagingStats.messagesByStatus,
        recentActivity: messagingStats.recentActivity,
        topSessions: messagingStats.topSessions,
        dailyStats: messagingStats.dailyStats,
      },
      sessionStats: {
        total: sessionStats.total,
        active: sessionStats.active,
        inactive: sessionStats.inactive,
        uploaded: sessionStats.uploaded,
        error: sessionStats.error,
        revoked: sessionStats.revoked,
        loggedIn: sessionStats.loggedIn,
        loggedOut: sessionStats.loggedOut,
        totalAccounts: sessionStats.totalAccounts,
        accountsByType: sessionStats.accountsByType,
      },
      generatedAt: new Date().toISOString(),
      period,
    };

    await reportService.logActivity(
      userId,
      'report_generate',
      'dashboard',
      null,
      {
        reportType: 'dashboard',
        period,
      }
    );

    logger.info(`Dashboard stats returned for user ${userId}`, { period });

    return res.status(200).json({
      success: true,
      data: response,
    });
  }),

  /**
   * Get recent activity log for the dashboard.
   *
   * Query params: limit (default: 10), action (optional filter), entityType (optional filter)
   * Returns the most recent activity entries for display on the dashboard.
   */
  getActivity: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;
    const action = req.query.action || undefined;
    const entityType = req.query.entityType || undefined;

    const { activities, pagination } = await reportService.getActivityLog(userId, {
      page: 1,
      limit: Math.min(limit, 50),
      action,
      entityType,
    });

    // Build a summary for quick dashboard consumption
    const activitySummary = {
      total: pagination.total,
      activities: activities,
      actionBreakdown: {},
    };

    // Compute action breakdown from the activities
    for (const activity of activities) {
      if (!activitySummary.actionBreakdown[activity.action]) {
        activitySummary.actionBreakdown[activity.action] = 0;
      }
      activitySummary.actionBreakdown[activity.action]++;
    }

    logger.info(`Dashboard activity fetched by user ${userId}`, {
      count: activities.length,
      action,
      entityType,
    });

    return res.status(200).json({
      success: true,
      data: activitySummary,
    });
  }),

  /**
   * Get available quick actions based on the user's current state.
   *
   * Analyzes the user's sessions, running jobs, and lists to determine
   * which quick actions are available and their current status.
   * Returns action suggestions like "start scraping", "send messages",
   * "import list", etc., along with prerequisites needed.
   */
  getQuickActions: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    // Fetch user state in parallel
    const [sessionStats, scrapeStats, messagingStats] = await Promise.all([
      sessionService.getSessionStats(userId),
      scrapeService.getStats(userId),
      messageService.getMessagingStats(userId),
    ]);

    const quickActions = [];

    // Determine session-related actions
    const hasActiveSessions = sessionStats.active > 0;
    const hasLoggedInSessions = sessionStats.loggedIn > 0;
    const hasUploadedSessions = sessionStats.uploaded > 0;
    const hasErrorSessions = sessionStats.error > 0;

    if (hasActiveSessions) {
      quickActions.push({
        action: 'scrape_group',
        label: 'Scrape Group Members',
        description: 'Scrape members from a Telegram group',
        available: true,
        prerequisites: [],
        icon: 'scrape',
        category: 'scraping',
      });

      quickActions.push({
        action: 'scrape_channel',
        label: 'Scrape Channel Subscribers',
        description: 'Scrape subscribers from a Telegram channel',
        available: true,
        prerequisites: [],
        icon: 'scrape',
        category: 'scraping',
      });

      quickActions.push({
        action: 'send_message',
        label: 'Send Messages',
        description: 'Send messages to a list of users',
        available: true,
        prerequisites: [],
        icon: 'message',
        category: 'messaging',
      });

      quickActions.push({
        action: 'bulk_message',
        label: 'Bulk Message Campaign',
        description: 'Send messages to multiple users using multiple sessions',
        available: true,
        prerequisites: [],
        icon: 'bulk_message',
        category: 'messaging',
      });

      quickActions.push({
        action: 'send_to_group',
        label: 'Send Message to Group',
        description: 'Send a message directly to a Telegram group',
        available: true,
        prerequisites: [],
        icon: 'group_message',
        category: 'messaging',
      });

      quickActions.push({
        action: 'forward_message',
        label: 'Forward Message',
        description: 'Forward a message from one chat to another',
        available: true,
        prerequisites: [],
        icon: 'forward',
        category: 'messaging',
      });
    }

    if (hasLoggedInSessions === 0 && hasActiveSessions === 0) {
      quickActions.push({
        action: 'login_session',
        label: 'Login a Session',
        description: 'Connect a session to Telegram to start using the panel',
        available: true,
        prerequisites: hasUploadedSessions ? [] : ['upload_session'],
        icon: 'login',
        category: 'sessions',
      });
    }

    if (hasUploadedSessions > 0) {
      quickActions.push({
        action: 'login_sessions',
        label: `Login ${hasUploadedSessions} Session(s)`,
        description: 'Activate uploaded sessions to connect them to Telegram',
        available: true,
        prerequisites: [],
        icon: 'login',
        category: 'sessions',
      });
    }

    if (hasErrorSessions > 0) {
      quickActions.push({
        action: 'check_errors',
        label: `${hasErrorSessions} Session(s) in Error State`,
        description: 'Review and fix sessions that are in an error state',
        available: true,
        prerequisites: [],
        icon: 'error',
        category: 'sessions',
        urgency: 'high',
      });
    }

    // Scraping-related quick actions
    const hasRunningScrapeJobs = scrapeStats.runningJobs > 0;
    const hasPendingScrapeJobs = scrapeStats.pendingJobs > 0;

    if (hasRunningScrapeJobs > 0) {
      quickActions.push({
        action: 'view_running_scrapes',
        label: `${hasRunningScrapeJobs} Scrape Job(s) Running`,
        description: 'View and monitor running scraping jobs',
        available: true,
        prerequisites: [],
        icon: 'running',
        category: 'scraping',
      });
    }

    if (hasPendingScrapeJobs > 0) {
      quickActions.push({
        action: 'view_pending_scrapes',
        label: `${hasPendingScrapeJobs} Scrape Job(s) Pending`,
        description: 'View pending scraping jobs waiting to start',
        available: true,
        prerequisites: [],
        icon: 'pending',
        category: 'scraping',
      });
    }

    // Messaging-related quick actions
    const runningMsgJobs = messagingStats.jobsByStatus && messagingStats.jobsByStatus.running
      ? messagingStats.jobsByStatus.running
      : 0;

    if (runningMsgJobs > 0) {
      quickActions.push({
        action: 'view_running_messages',
        label: `${runningMsgJobs} Messaging Job(s) Running`,
        description: 'View and monitor running messaging jobs',
        available: true,
        prerequisites: [],
        icon: 'running',
        category: 'messaging',
      });
    }

    // List-related quick actions
    quickActions.push({
      action: 'import_list',
      label: 'Import Contact List',
      description: 'Import contacts from CSV, JSON, or TXT file',
      available: true,
      prerequisites: [],
      icon: 'import',
      category: 'lists',
    });

    // Quick actions for creating lists from scrape jobs
    if (scrapeStats.completedJobs > 0) {
      quickActions.push({
        action: 'create_list_from_scrape',
        label: 'Create List from Scraped Data',
        description: 'Create a new contact list from completed scrape job results',
        available: true,
        prerequisites: [],
        icon: 'list_create',
        category: 'lists',
      });
    }

    // Report-related quick actions
    quickActions.push({
      action: 'generate_report',
      label: 'Generate Report',
      description: 'Generate analytics and performance reports',
      available: true,
      prerequisites: [],
      icon: 'report',
      category: 'reports',
    });

    // Sort quick actions by category and urgency
    quickActions.sort((a, b) => {
      const urgencyOrder = { high: 0, medium: 1, low: 2, normal: 3 };
      const aUrgency = urgencyOrder[a.urgency] || urgencyOrder.normal;
      const bUrgency = urgencyOrder[b.urgency] || urgencyOrder.normal;
      if (aUrgency !== bUrgency) return aUrgency - bUrgency;
      return a.category.localeCompare(b.category);
    });

    // Build the response
    const response = {
      actions: quickActions,
      categories: [
        { id: 'sessions', label: 'Sessions', count: quickActions.filter((a) => a.category === 'sessions').length },
        { id: 'scraping', label: 'Scraping', count: quickActions.filter((a) => a.category === 'scraping').length },
        { id: 'messaging', label: 'Messaging', count: quickActions.filter((a) => a.category === 'messaging').length },
        { id: 'lists', label: 'Lists', count: quickActions.filter((a) => a.category === 'lists').length },
        { id: 'reports', label: 'Reports', count: quickActions.filter((a) => a.category === 'reports').length },
      ],
      userState: {
        totalSessions: sessionStats.total,
        activeSessions: sessionStats.active,
        loggedInSessions: sessionStats.loggedIn,
        runningScrapeJobs: scrapeStats.runningJobs,
        pendingScrapeJobs: scrapeStats.pendingJobs,
        totalScrapeJobs: scrapeStats.totalJobs,
        totalMessagingJobs: messagingStats.totalJobs,
      },
    };

    logger.info(`Quick actions fetched by user ${userId}`, {
      actionCount: quickActions.length,
    });

    return res.status(200).json({
      success: true,
      data: response,
    });
  }),
};

module.exports = dashboardController;
