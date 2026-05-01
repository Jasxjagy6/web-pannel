/**
 * ReportService - Generates analytics reports for sessions, scraping,
 * messaging, and group operations. Provides dashboard-level summaries,
 * trend comparisons, activity logging, and report export.
 *
 * All queries verify ownership of target resources (sessions, groups, lists)
 * belong to the requesting user before generating reports.
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const { applyPagination, applySorting, buildPagination } = require('../utils/pagination');
const moment = require('moment');

/**
 * Valid report types stored in the database.
 */
const VALID_REPORT_TYPES = [
  'session',
  'scrape',
  'messaging',
  'group',
  'channel',
  'user',
  'dashboard',
];

/**
 * Valid export formats.
 */
const VALID_EXPORT_FORMATS = ['csv', 'json'];

/**
 * Valid period strings that can be passed to report generators.
 */
const VALID_PERIODS = ['24h', '7d', '30d', '90d', 'custom'];

/**
 * Valid activity log actions.
 */
const VALID_ACTIONS = [
  'session_upload',
  'session_login',
  'session_logout',
  'session_delete',
  'scrape_start',
  'scrape_complete',
  'scrape_cancel',
  'scrape_fail',
  'message_send',
  'message_bulk_start',
  'message_bulk_complete',
  'message_bulk_cancel',
  'message_bulk_fail',
  'group_add_members',
  'group_add_complete',
  'group_add_cancel',
  'group_add_fail',
  'list_import',
  'list_export',
  'list_merge',
  'list_delete',
  'report_generate',
  'report_export',
  'report_delete',
  // Anti-Detect / Proxy lifecycle
  'proxy_added',
  'proxy_deleted',
  'device_identity_assigned',
  'device_identity_rotated',
  'behavior_warmup_tick',
  'behavior_warmup_run',
];

/**
 * Resolve a period string into { startDate, endDate } using moment.js.
 *
 * @param {string} period - Period string: '24h', '7d', '30d', '90d'
 * @returns {{ startDate: moment.Moment, endDate: moment.Moment }}
 * @private
 */
function resolvePeriod(period) {
  const endDate = moment().endOf('day');
  let startDate;

  switch (period) {
    case '24h':
      startDate = moment().subtract(24, 'hours');
      break;
    case '7d':
      startDate = moment().subtract(7, 'days').startOf('day');
      break;
    case '30d':
      startDate = moment().subtract(30, 'days').startOf('day');
      break;
    case '90d':
      startDate = moment().subtract(90, 'days').startOf('day');
      break;
    default:
      startDate = moment().subtract(7, 'days').startOf('day');
      break;
  }

  return { startDate, endDate };
}

/**
 * Resolve a custom period from explicit start and end dates.
 *
 * @param {string|Date} periodStart - Start of the period
 * @param {string|Date} periodEnd - End of the period
 * @returns {{ startDate: moment.Moment, endDate: moment.Moment }}
 * @private
 */
function resolveCustomPeriod(periodStart, periodEnd) {
  return {
    startDate: moment(periodStart).startOf('day'),
    endDate: moment(periodEnd || new Date()).endOf('day'),
  };
}

/**
 * Compute the previous period for trend comparison.
 *
 * @param {moment.Moment} startDate - Current period start
 * @param {moment.Moment} endDate - Current period end
 * @returns {{ startDate: moment.Moment, endDate: moment.Moment }}
 * @private
 */
function getPreviousPeriod(startDate, endDate) {
  const duration = endDate.diff(startDate);
  return {
    startDate: startDate.clone().subtract(duration),
    endDate: startDate.clone(),
  };
}

/**
 * Validate that a session belongs to the specified user.
 *
 * @param {number|string} sessionId - Session database ID
 * @param {number|string} userId - Owner user ID
 * @returns {Promise<object>} Session row
 * @throws {AppError} If session not found or not owned by user
 * @private
 */
async function validateSessionOwnership(sessionId, userId) {
  const result = await pool.query(
    'SELECT id, user_id, status, is_logged_in, phone FROM sessions WHERE id = $1 AND user_id = $2',
    [sessionId, userId]
  );

  if (result.rows.length === 0) {
    throw new AppError(
      `Session not found or access denied: ${sessionId}`,
      404,
      'SESSION_NOT_FOUND'
    );
  }

  return result.rows[0];
}

/**
 * Validate that a list belongs to the specified user.
 *
 * @param {number|string} listId - List database ID
 * @param {number|string} userId - Owner user ID
 * @returns {Promise<object>} List row
 * @throws {AppError} If list not found or not owned by user
 * @private
 */
async function validateListOwnership(listId, userId) {
  const result = await pool.query(
    'SELECT id, user_id, name, type, items_count FROM lists WHERE id = $1 AND user_id = $2',
    [listId, userId]
  );

  if (result.rows.length === 0) {
    throw new AppError(
      `List not found or access denied: ${listId}`,
      404,
      'LIST_NOT_FOUND'
    );
  }

  return result.rows[0];
}

/**
 * Validate that a scraping job belongs to the specified user.
 *
 * @param {number|string} jobId - Scraping job ID
 * @param {number|string} userId - Owner user ID
 * @returns {Promise<object>} Job row
 * @throws {AppError} If job not found or not owned by user
 * @private
 */
async function validateScrapeJobOwnership(jobId, userId) {
  const result = await pool.query(
    `SELECT sj.id, sj.session_id, sj.target_type, sj.target_id, sj.target_title,
            sj.status, sj.total_found, s.user_id
     FROM scraping_jobs sj
     INNER JOIN sessions s ON sj.session_id = s.id
     WHERE sj.id = $1 AND s.user_id = $2`,
    [jobId, userId]
  );

  if (result.rows.length === 0) {
    throw new AppError(
      `Scraping job not found or access denied: ${jobId}`,
      404,
      'SCRAPE_JOB_NOT_FOUND'
    );
  }

  return result.rows[0];
}

/**
 * Validate that a messaging job belongs to the specified user.
 *
 * @param {number|string} jobId - Messaging job ID
 * @param {number|string} userId - Owner user ID
 * @returns {Promise<object>} Job row
 * @throws {AppError} If job not found or not owned by user
 * @private
 */
async function validateMessagingJobOwnership(jobId, userId) {
  const result = await pool.query(
    `SELECT mj.id, mj.session_id, mj.job_type, mj.status, mj.total_count,
            mj.sent_count, mj.failed_count, mj.skipped_count, s.user_id
     FROM messaging_jobs mj
     INNER JOIN sessions s ON mj.session_id = s.id
     WHERE mj.id = $1 AND s.user_id = $2`,
    [jobId, userId]
  );

  if (result.rows.length === 0) {
    throw new AppError(
      `Messaging job not found or access denied: ${jobId}`,
      404,
      'MESSAGING_JOB_NOT_FOUND'
    );
  }

  return result.rows[0];
}

// =========================================================================
// ReportService Class
// =========================================================================

class ReportService {
  // =========================================================================
  // Channel Report
  // =========================================================================

  /**
   * Generate a report for a Telegram channel.
   *
   * Includes member growth over the period, message statistics from group
   operations tied to the channel, and engagement metrics.
   *
   * @param {number|string} channelId - The channel identifier (as stored in target_id)
   * @param {string} period - Time period: '24h', '7d', '30d', '90d', 'custom'
   * @param {number|string} userId - The requesting user ID
   * @param {object} customDates - Required when period === 'custom': { periodStart, periodEnd }
   * @returns {Promise<{
   *   reportType: string,
   *   channelId: string,
   *   period: { start: string, end: string },
   *   memberGrowth: object,
   *   messageStats: object,
   *   engagementMetrics: object,
   *   trends: object
   * }>}
   */
  async generateChannelReport(channelId, period, userId, customDates = {}) {
    logger.info(`Generating channel report for ${channelId}`, { userId, period });

    const { startDate, endDate } = period === 'custom'
      ? resolveCustomPeriod(customDates.periodStart, customDates.periodEnd)
      : resolvePeriod(period);

    const { startDate: prevStart, endDate: prevEnd } = getPreviousPeriod(startDate, endDate);

    // Member growth: count scraped users by scrape jobs targeting this channel
    const memberGrowthResult = await pool.query(
      `SELECT COUNT(DISTINCT su.telegram_id) as new_members
       FROM scraped_users su
       INNER JOIN scraping_jobs sj ON su.job_id = sj.id
       INNER JOIN sessions s ON sj.session_id = s.id
       WHERE s.user_id = $1
         AND sj.target_type = 'channel'
         AND sj.target_id = $2
         AND sj.created_at >= $3
         AND sj.created_at <= $4`,
      [userId, String(channelId), startDate.toISOString(), endDate.toISOString()]
    );

    const currentMembers = parseInt(memberGrowthResult.rows[0].new_members, 10);

    // Previous period member growth
    const prevMemberGrowthResult = await pool.query(
      `SELECT COUNT(DISTINCT su.telegram_id) as new_members
       FROM scraped_users su
       INNER JOIN scraping_jobs sj ON su.job_id = sj.id
       INNER JOIN sessions s ON sj.session_id = s.id
       WHERE s.user_id = $1
         AND sj.target_type = 'channel'
         AND sj.target_id = $2
         AND sj.created_at >= $3
         AND sj.created_at <= $4`,
      [userId, String(channelId), prevStart.toISOString(), prevEnd.toISOString()]
    );

    const previousMembers = parseInt(prevMemberGrowthResult.rows[0].new_members, 10);

    // Total scraped for this channel (all time)
    const totalScrapedResult = await pool.query(
      `SELECT COUNT(*) as total, COUNT(DISTINCT su.telegram_id) as unique_total
       FROM scraped_users su
       INNER JOIN scraping_jobs sj ON su.job_id = sj.id
       INNER JOIN sessions s ON sj.session_id = s.id
       WHERE s.user_id = $1
         AND sj.target_type = 'channel'
         AND sj.target_id = $2`,
      [userId, String(channelId)]
    );

    const totalScrapedRow = totalScrapedResult.rows[0];

    // Daily growth breakdown
    const dailyGrowthResult = await pool.query(
      `SELECT DATE(sj.created_at) as date, COUNT(DISTINCT su.telegram_id) as new_members
       FROM scraped_users su
       INNER JOIN scraping_jobs sj ON su.job_id = sj.id
       INNER JOIN sessions s ON sj.session_id = s.id
       WHERE s.user_id = $1
         AND sj.target_type = 'channel'
         AND sj.target_id = $2
         AND sj.created_at >= $3
         AND sj.created_at <= $4
       GROUP BY DATE(sj.created_at)
       ORDER BY date ASC`,
      [userId, String(channelId), startDate.toISOString(), endDate.toISOString()]
    );

    const dailyGrowth = dailyGrowthResult.rows.map((row) => ({
      date: row.date,
      newMembers: parseInt(row.new_members, 10),
    }));

    // Message stats: group operations targeting this channel
    const messageStatsResult = await pool.query(
      `SELECT
         COUNT(*) as total_operations,
         COALESCE(SUM(success_count), 0) as total_success,
         COALESCE(SUM(failed_count), 0) as total_failed,
         COALESCE(SUM(total_count), 0) as total_attempted
       FROM group_operations go
       INNER JOIN sessions s ON go.session_id = s.id
       WHERE s.user_id = $1
         AND go.target_group_id = $2
         AND go.operation = 'add_members'
         AND go.created_at >= $3
         AND go.created_at <= $4`,
      [userId, String(channelId), startDate.toISOString(), endDate.toISOString()]
    );

    const msgRow = messageStatsResult.rows[0];
    const totalOperations = parseInt(msgRow.total_operations, 10);
    const totalSuccess = parseInt(msgRow.total_success, 10);
    const totalFailed = parseInt(msgRow.total_failed, 10);
    const totalAttempted = parseInt(msgRow.total_attempted, 10);
    const successRate = totalAttempted > 0
      ? Math.round((totalSuccess / totalAttempted) * 10000) / 100
      : 0;

    // Previous period message stats
    const prevMessageStatsResult = await pool.query(
      `SELECT
         COUNT(*) as total_operations,
         COALESCE(SUM(success_count), 0) as total_success,
         COALESCE(SUM(failed_count), 0) as total_failed,
         COALESCE(SUM(total_count), 0) as total_attempted
       FROM group_operations go
       INNER JOIN sessions s ON go.session_id = s.id
       WHERE s.user_id = $1
         AND go.target_group_id = $2
         AND go.operation = 'add_members'
         AND go.created_at >= $3
         AND go.created_at <= $4`,
      [userId, String(channelId), prevStart.toISOString(), prevEnd.toISOString()]
    );

    const prevMsgRow = prevMessageStatsResult.rows[0];
    const prevTotalOperations = parseInt(prevMsgRow.total_operations, 10);
    const prevTotalSuccess = parseInt(prevMsgRow.total_success, 10);
    const prevTotalAttempted = parseInt(prevMsgRow.total_attempted, 10);
    const prevSuccessRate = prevTotalAttempted > 0
      ? Math.round((prevTotalSuccess / prevTotalAttempted) * 10000) / 100
      : 0;

    // Compute trends
    const memberGrowthTrend = previousMembers > 0
      ? Math.round(((currentMembers - previousMembers) / previousMembers) * 10000) / 100
      : (currentMembers > 0 ? 100 : 0);

    const operationTrend = prevTotalOperations > 0
      ? Math.round(((totalOperations - prevTotalOperations) / prevTotalOperations) * 10000) / 100
      : (totalOperations > 0 ? 100 : 0);

    return {
      reportType: 'channel',
      channelId: String(channelId),
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      memberGrowth: {
        newMembers: currentMembers,
        totalScrapedAllTime: parseInt(totalScrapedRow.total, 10),
        uniqueScrapedAllTime: parseInt(totalScrapedRow.unique_total, 10),
        dailyBreakdown: dailyGrowth,
      },
      messageStats: {
        totalOperations,
        totalSuccess,
        totalFailed,
        totalAttempted,
        successRate,
      },
      engagementMetrics: {
        avgSuccessPerOperation: totalOperations > 0
          ? Math.round((totalSuccess / totalOperations) * 100) / 100
          : 0,
        avgFailurePerOperation: totalOperations > 0
          ? Math.round((totalFailed / totalOperations) * 100) / 100
          : 0,
      },
      trends: {
        memberGrowthTrend,
        previousMemberGrowth: previousMembers,
        operationTrend,
        previousOperations: prevTotalOperations,
        successRateTrend: successRate - prevSuccessRate,
        previousSuccessRate: prevSuccessRate,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  // =========================================================================
  // Group Report
  // =========================================================================

  /**
   * Generate a report for a Telegram group.
   *
   * Includes member count changes, active member stats, messages sent
   * via group operations, and add/remove statistics.
   *
   * @param {number|string} groupId - The group identifier
   * @param {string} period - Time period: '24h', '7d', '30d', '90d', 'custom'
   * @param {number|string} userId - The requesting user ID
   * @param {object} customDates - Required when period === 'custom': { periodStart, periodEnd }
   * @returns {Promise<{
   *   reportType: string,
   *   groupId: string,
   *   period: { start: string, end: string },
   *   memberStats: object,
   *   messageStats: object,
   *   addRemoveStats: object,
   *   trends: object
   * }>}
   */
  async generateGroupReport(groupId, period, userId, customDates = {}) {
    logger.info(`Generating group report for ${groupId}`, { userId, period });

    const { startDate, endDate } = period === 'custom'
      ? resolveCustomPeriod(customDates.periodStart, customDates.periodEnd)
      : resolvePeriod(period);

    const { startDate: prevStart, endDate: prevEnd } = getPreviousPeriod(startDate, endDate);

    // Add member operations for this group
    const addOpsResult = await pool.query(
      `SELECT
         COUNT(*) as total_ops,
         COALESCE(SUM(success_count), 0) as total_added,
         COALESCE(SUM(failed_count), 0) as total_failed,
         COALESCE(SUM(total_count), 0) as total_attempted
       FROM group_operations go
       INNER JOIN sessions s ON go.session_id = s.id
       WHERE s.user_id = $1
         AND go.target_group_id = $2
         AND go.operation = 'add_members'
         AND go.created_at >= $3
         AND go.created_at <= $4`,
      [userId, String(groupId), startDate.toISOString(), endDate.toISOString()]
    );

    const addRow = addOpsResult.rows[0];
    const totalAddOps = parseInt(addRow.total_ops, 10);
    const totalAdded = parseInt(addRow.total_added, 10);
    const totalAddFailed = parseInt(addRow.total_failed, 10);
    const totalAddAttempted = parseInt(addRow.total_attempted, 10);

    // Remove member operations
    const removeOpsResult = await pool.query(
      `SELECT
         COUNT(*) as total_ops,
         COALESCE(SUM(success_count), 0) as total_removed
       FROM group_operations go
       INNER JOIN sessions s ON go.session_id = s.id
       WHERE s.user_id = $1
         AND go.target_group_id = $2
         AND go.operation = 'remove_member'
         AND go.created_at >= $3
         AND go.created_at <= $4`,
      [userId, String(groupId), startDate.toISOString(), endDate.toISOString()]
    );

    const removeRow = removeOpsResult.rows[0];
    const totalRemoveOps = parseInt(removeRow.total_ops, 10);
    const totalRemoved = parseInt(removeRow.total_removed, 10);

    // Previous period for trends
    const prevAddOpsResult = await pool.query(
      `SELECT
         COUNT(*) as total_ops,
         COALESCE(SUM(success_count), 0) as total_added,
         COALESCE(SUM(failed_count), 0) as total_failed,
         COALESCE(SUM(total_count), 0) as total_attempted
       FROM group_operations go
       INNER JOIN sessions s ON go.session_id = s.id
       WHERE s.user_id = $1
         AND go.target_group_id = $2
         AND go.operation = 'add_members'
         AND go.created_at >= $3
         AND go.created_at <= $4`,
      [userId, String(groupId), prevStart.toISOString(), prevEnd.toISOString()]
    );

    const prevAddRow = prevAddOpsResult.rows[0];
    const prevTotalAdded = parseInt(prevAddRow.total_added, 10);
    const prevTotalAddAttempted = parseInt(prevAddRow.total_attempted, 10);

    const addSuccessRate = totalAddAttempted > 0
      ? Math.round((totalAdded / totalAddAttempted) * 10000) / 100
      : 0;

    const prevAddSuccessRate = prevTotalAddAttempted > 0
      ? Math.round((prevTotalAdded / prevTotalAddAttempted) * 10000) / 100
      : 0;

    // Daily breakdown of add operations
    const dailyAddsResult = await pool.query(
      `SELECT DATE(go.created_at) as date,
              COALESCE(SUM(go.success_count), 0) as added,
              COALESCE(SUM(go.failed_count), 0) as failed
       FROM group_operations go
       INNER JOIN sessions s ON go.session_id = s.id
       WHERE s.user_id = $1
         AND go.target_group_id = $2
         AND go.operation = 'add_members'
         AND go.created_at >= $3
         AND go.created_at <= $4
       GROUP BY DATE(go.created_at)
       ORDER BY date ASC`,
      [userId, String(groupId), startDate.toISOString(), endDate.toISOString()]
    );

    const dailyBreakdown = dailyAddsResult.rows.map((row) => ({
      date: row.date,
      added: parseInt(row.added, 10),
      failed: parseInt(row.failed, 10),
    }));

    // Net member change
    const netChange = totalAdded - totalRemoved;
    const prevNetChange = prevTotalAdded - parseInt(prevAddRow.total_failed, 10);

    // Compute trends
    const addedTrend = prevTotalAdded > 0
      ? Math.round(((totalAdded - prevTotalAdded) / prevTotalAdded) * 10000) / 100
      : (totalAdded > 0 ? 100 : 0);

    return {
      reportType: 'group',
      groupId: String(groupId),
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      memberStats: {
        netChange,
        totalAdded,
        totalRemoved,
        addSuccessRate,
      },
      messageStats: {
        totalAddOperations: totalAddOps,
        totalRemoveOperations: totalRemoveOps,
        totalOperations: totalAddOps + totalRemoveOps,
      },
      addRemoveStats: {
        addOps: {
          total: totalAddOps,
          success: totalAdded,
          failed: totalAddFailed,
          attempted: totalAddAttempted,
          successRate: addSuccessRate,
        },
        removeOps: {
          total: totalRemoveOps,
          success: totalRemoved,
        },
        dailyBreakdown,
      },
      trends: {
        addedTrend,
        previousAdded: prevTotalAdded,
        netChangeTrend: netChange - prevNetChange,
        successRateTrend: addSuccessRate - prevAddSuccessRate,
        previousSuccessRate: prevAddSuccessRate,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  // =========================================================================
  // User Report
  // =========================================================================

  /**
   * Generate a report for a specific Telegram user.
   *
   * Includes activity history, groups the user was found in (via scraping),
   * and messaging statistics related to this user.
   *
   * @param {number|string} userId_target - The target user's Telegram ID
   * @param {number|string} userId - The requesting (panel) user ID
   * @returns {Promise<{
   *   reportType: string,
   *   targetUserId: string,
   *   activityHistory: object[],
   *   groupsFoundIn: object[],
   *   messagingStats: object,
   *   firstSeen: string|null,
   *   lastSeen: string|null
   * }>}
   */
  async generateUserReport(userId_target, userId) {
    logger.info(`Generating user report for target ${userId_target}`, { userId });

    const targetId = String(userId_target);

    // Find all scrape jobs where this user appeared, across sessions owned by the panel user
    const scrapeResult = await pool.query(
      `SELECT DISTINCT sj.id as job_id, sj.target_type, sj.target_id, sj.target_title,
              sj.created_at, su.username, su.first_name, su.last_name, su.phone
       FROM scraped_users su
       INNER JOIN scraping_jobs sj ON su.job_id = sj.id
       INNER JOIN sessions s ON sj.session_id = s.id
       WHERE s.user_id = $1
         AND (su.telegram_id::text = $2 OR su.username = $2)
       ORDER BY sj.created_at DESC`,
      [userId, targetId]
    );

    const groupsFoundIn = scrapeResult.rows.map((row) => ({
      jobId: row.job_id,
      targetType: row.target_type,
      targetId: row.target_id,
      targetTitle: row.target_title,
      scrapedAt: row.created_at,
      username: row.username,
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone,
    }));

    // Find messaging logs targeting this user
    const messagingResult = await pool.query(
      `SELECT ml.id, ml.job_id, ml.status, ml.error_message, ml.sent_at,
              mj.message_type, s.phone as session_phone
       FROM message_logs ml
       INNER JOIN sessions s ON ml.session_id = s.id
       LEFT JOIN messaging_jobs mj ON ml.job_id = mj.id
       WHERE s.user_id = $1
         AND ml.target_id::text = $2
       ORDER BY ml.sent_at DESC`,
      [userId, targetId]
    );

    const messagingHistory = messagingResult.rows.map((row) => ({
      logId: row.id,
      jobId: row.job_id,
      status: row.status,
      errorMessage: row.error_message,
      messageType: row.message_type,
      sessionPhone: row.session_phone,
      sentAt: row.sent_at,
    }));

    // Find activity logs referencing this entity
    const activityResult = await pool.query(
      `SELECT id, action, entity_type, entity_id, details, created_at
       FROM activity_logs
       WHERE user_id = $1
         AND (details->>'telegram_id')::text = $2
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId, targetId]
    );

    const activityHistory = activityResult.rows.map((row) => ({
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: row.details,
      createdAt: row.created_at,
    }));

    // Aggregate messaging stats
    const totalMessagesSent = messagingHistory.filter((m) => m.status === 'sent').length;
    const totalMessagesFailed = messagingHistory.filter((m) => m.status === 'failed').length;
    const totalMessages = messagingHistory.length;
    const messagingSuccessRate = totalMessages > 0
      ? Math.round((totalMessagesSent / totalMessages) * 10000) / 100
      : 0;

    // First and last seen dates
    const allDates = [
      ...scrapeResult.rows.map((r) => r.created_at),
      ...messagingResult.rows.map((r) => r.sent_at),
    ].filter(Boolean);

    allDates.sort();
    const firstSeen = allDates.length > 0 ? allDates[0] : null;
    const lastSeen = allDates.length > 0 ? allDates[allDates.length - 1] : null;

    return {
      reportType: 'user',
      targetUserId: targetId,
      activityHistory,
      groupsFoundIn,
      messagingStats: {
        totalMessages,
        totalSent: totalMessagesSent,
        totalFailed: totalMessagesFailed,
        successRate: messagingSuccessRate,
        history: messagingHistory.slice(0, 20),
      },
      firstSeen,
      lastSeen,
      generatedAt: new Date().toISOString(),
    };
  }

  // =========================================================================
  // Session Report
  // =========================================================================

  /**
   * Generate a comprehensive report for a Telegram session.
   *
   * JOINs messaging_jobs + message_logs for message stats,
   * scraping_jobs + scraped_users for scrape stats,
   * and group_operations for group operation stats.
   *
   * @param {number|string} sessionId - Session database ID
   * @param {string} period - Time period: '24h', '7d', '30d', '90d', 'custom'
   * @param {number|string} userId - The requesting user ID
   * @param {object} customDates - Required when period === 'custom': { periodStart, periodEnd }
   * @returns {Promise<{
   *   reportType: string,
   *   sessionId: number,
   *   period: { start: string, end: string },
   *   messageStats: object,
   *   scrapeStats: object,
   *   groupOperationStats: object,
   *   trends: object,
   *   sessionInfo: object
   * }>}
   */
  async generateSessionReport(sessionId, period, userId, customDates = {}) {
    logger.info(`Generating session report for ${sessionId}`, { userId, period });

    // Validate session ownership
    const session = await validateSessionOwnership(sessionId, userId);

    const { startDate, endDate } = period === 'custom'
      ? resolveCustomPeriod(customDates.periodStart, customDates.periodEnd)
      : resolvePeriod(period);

    const { startDate: prevStart, endDate: prevEnd } = getPreviousPeriod(startDate, endDate);

    // --- Message Statistics ---
    // JOIN messaging_jobs + message_logs for message stats
    const messageStatsResult = await pool.query(
      `SELECT
         COUNT(DISTINCT mj.id) as total_jobs,
         COALESCE(SUM(mj.sent_count), 0) as total_sent,
         COALESCE(SUM(mj.failed_count), 0) as total_failed,
         COALESCE(SUM(mj.skipped_count), 0) as total_skipped,
         COALESCE(SUM(mj.total_count), 0) as total_attempted,
         COUNT(*) FILTER (WHERE mj.status = 'completed') as completed_jobs,
         COUNT(*) FILTER (WHERE mj.status = 'failed') as failed_jobs,
         COUNT(*) FILTER (WHERE mj.status = 'cancelled') as cancelled_jobs
       FROM messaging_jobs mj
       WHERE mj.session_id = $1
         AND mj.created_at >= $2
         AND mj.created_at <= $3`,
      [sessionId, startDate.toISOString(), endDate.toISOString()]
    );

    const msgRow = messageStatsResult.rows[0];
    const totalMsgJobs = parseInt(msgRow.total_jobs, 10);
    const totalSent = parseInt(msgRow.total_sent, 10);
    const totalFailed = parseInt(msgRow.total_failed, 10);
    const totalSkipped = parseInt(msgRow.total_skipped, 10);
    const totalAttempted = parseInt(msgRow.total_attempted, 10);
    const completedMsgJobs = parseInt(msgRow.completed_jobs, 10);
    const failedMsgJobs = parseInt(msgRow.failed_jobs, 10);
    const cancelledMsgJobs = parseInt(msgRow.cancelled_jobs, 10);
    const msgSuccessRate = totalAttempted > 0
      ? Math.round((totalSent / totalAttempted) * 10000) / 100
      : 0;

    // Message logs detail
    const messageLogsResult = await pool.query(
      `SELECT ml.status, COUNT(*) as count
       FROM message_logs ml
       WHERE ml.session_id = $1
         AND ml.sent_at >= $2
         AND ml.sent_at <= $3
       GROUP BY ml.status`,
      [sessionId, startDate.toISOString(), endDate.toISOString()]
    );

    const messageLogBreakdown = {};
    for (const row of messageLogsResult.rows) {
      messageLogBreakdown[row.status] = parseInt(row.count, 10);
    }

    // Previous period message stats
    const prevMsgStatsResult = await pool.query(
      `SELECT
         COUNT(DISTINCT mj.id) as total_jobs,
         COALESCE(SUM(mj.sent_count), 0) as total_sent,
         COALESCE(SUM(mj.failed_count), 0) as total_failed,
         COALESCE(SUM(mj.total_count), 0) as total_attempted
       FROM messaging_jobs mj
       WHERE mj.session_id = $1
         AND mj.created_at >= $2
         AND mj.created_at <= $3`,
      [sessionId, prevStart.toISOString(), prevEnd.toISOString()]
    );

    const prevMsgRow = prevMsgStatsResult.rows[0];
    const prevTotalSent = parseInt(prevMsgRow.total_sent, 10);
    const prevTotalAttempted = parseInt(prevMsgRow.total_attempted, 10);
    const prevMsgSuccessRate = prevTotalAttempted > 0
      ? Math.round((prevTotalSent / prevTotalAttempted) * 10000) / 100
      : 0;

    // --- Scrape Statistics ---
    // JOIN scraping_jobs + scraped_users
    const scrapeStatsResult = await pool.query(
      `SELECT
         COUNT(DISTINCT sj.id) as total_jobs,
         COALESCE(SUM(sj.total_found), 0) as total_users_found,
         COUNT(*) FILTER (WHERE sj.status = 'completed') as completed_jobs,
         COUNT(*) FILTER (WHERE sj.status = 'failed') as failed_jobs,
         COUNT(*) FILTER (WHERE sj.status = 'cancelled') as cancelled_jobs,
         COUNT(*) FILTER (WHERE sj.target_type = 'group') as group_jobs,
         COUNT(*) FILTER (WHERE sj.target_type = 'channel') as channel_jobs
       FROM scraping_jobs sj
       WHERE sj.session_id = $1
         AND sj.created_at >= $2
         AND sj.created_at <= $3`,
      [sessionId, startDate.toISOString(), endDate.toISOString()]
    );

    const scrapeRow = scrapeStatsResult.rows[0];
    const totalScrapeJobs = parseInt(scrapeRow.total_jobs, 10);
    const totalUsersFound = parseInt(scrapeRow.total_users_found, 10);
    const completedScrapeJobs = parseInt(scrapeRow.completed_jobs, 10);
    const failedScrapeJobs = parseInt(scrapeRow.failed_jobs, 10);
    const cancelledScrapeJobs = parseInt(scrapeRow.cancelled_jobs, 10);
    const groupScrapeJobs = parseInt(scrapeRow.group_jobs, 10);
    const channelScrapeJobs = parseInt(scrapeRow.channel_jobs, 10);

    // Scrape success rate
    const scrapeTotalFinished = completedScrapeJobs + failedScrapeJobs;
    const scrapeSuccessRate = scrapeTotalFinished > 0
      ? Math.round((completedScrapeJobs / scrapeTotalFinished) * 10000) / 100
      : 0;

    // Previous period scrape stats
    const prevScrapeStatsResult = await pool.query(
      `SELECT
         COUNT(DISTINCT sj.id) as total_jobs,
         COALESCE(SUM(sj.total_found), 0) as total_users_found,
         COUNT(*) FILTER (WHERE sj.status = 'completed') as completed_jobs,
         COUNT(*) FILTER (WHERE sj.status = 'failed') as failed_jobs
       FROM scraping_jobs sj
       WHERE sj.session_id = $1
         AND sj.created_at >= $2
         AND sj.created_at <= $3`,
      [sessionId, prevStart.toISOString(), prevEnd.toISOString()]
    );

    const prevScrapeRow = prevScrapeStatsResult.rows[0];
    const prevTotalUsersFound = parseInt(prevScrapeRow.total_users_found, 10);
    const prevCompletedScrapeJobs = parseInt(prevScrapeRow.completed_jobs, 10);
    const prevFailedScrapeJobs = parseInt(prevScrapeRow.failed_jobs, 10);
    const prevScrapeTotalFinished = prevCompletedScrapeJobs + prevFailedScrapeJobs;
    const prevScrapeSuccessRate = prevScrapeTotalFinished > 0
      ? Math.round((prevCompletedScrapeJobs / prevScrapeTotalFinished) * 10000) / 100
      : 0;

    // --- Group Operation Statistics ---
    // JOIN group_operations for group stats
    const groupOpStatsResult = await pool.query(
      `SELECT
         COUNT(*) as total_ops,
         COALESCE(SUM(success_count), 0) as total_success,
         COALESCE(SUM(failed_count), 0) as total_failed,
         COUNT(*) FILTER (WHERE operation = 'add_members') as add_ops,
         COUNT(*) FILTER (WHERE operation = 'remove_member') as remove_ops,
         COUNT(*) FILTER (WHERE operation = 'create_group') as create_ops,
         COUNT(*) FILTER (WHERE operation = 'auto_manage') as manage_ops
       FROM group_operations go
       WHERE go.session_id = $1
         AND go.created_at >= $2
         AND go.created_at <= $3`,
      [sessionId, startDate.toISOString(), endDate.toISOString()]
    );

    const groupOpRow = groupOpStatsResult.rows[0];
    const totalGroupOps = parseInt(groupOpRow.total_ops, 10);
    const totalGroupSuccess = parseInt(groupOpRow.total_success, 10);
    const totalGroupFailed = parseInt(groupOpRow.total_failed, 10);
    const addOps = parseInt(groupOpRow.add_ops, 10);
    const removeOps = parseInt(groupOpRow.remove_ops, 10);
    const createOps = parseInt(groupOpRow.create_ops, 10);
    const manageOps = parseInt(groupOpRow.manage_ops, 10);

    // Group operation success rate
    const totalGroupAttempted = totalGroupSuccess + totalGroupFailed;
    const groupOpSuccessRate = totalGroupAttempted > 0
      ? Math.round((totalGroupSuccess / totalGroupAttempted) * 10000) / 100
      : 0;

    // Previous period group ops
    const prevGroupOpResult = await pool.query(
      `SELECT COUNT(*) as total_ops
       FROM group_operations go
       WHERE go.session_id = $1
         AND go.created_at >= $2
         AND go.created_at <= $3`,
      [sessionId, prevStart.toISOString(), prevEnd.toISOString()]
    );

    const prevTotalGroupOps = parseInt(prevGroupOpResult.rows[0].total_ops, 10);

    // --- Compute Trends ---
    const messageTrend = prevTotalSent > 0
      ? Math.round(((totalSent - prevTotalSent) / prevTotalSent) * 10000) / 100
      : (totalSent > 0 ? 100 : 0);

    const scrapeTrend = prevTotalUsersFound > 0
      ? Math.round(((totalUsersFound - prevTotalUsersFound) / prevTotalUsersFound) * 10000) / 100
      : (totalUsersFound > 0 ? 100 : 0);

    const groupOpTrend = prevTotalGroupOps > 0
      ? Math.round(((totalGroupOps - prevTotalGroupOps) / prevTotalGroupOps) * 10000) / 100
      : (totalGroupOps > 0 ? 100 : 0);

    return {
      reportType: 'session',
      sessionId: Number(sessionId),
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      messageStats: {
        totalJobs: totalMsgJobs,
        totalSent,
        totalFailed,
        totalSkipped,
        totalAttempted,
        successRate: msgSuccessRate,
        completedJobs: completedMsgJobs,
        failedJobs: failedMsgJobs,
        cancelledJobs: cancelledMsgJobs,
        logBreakdown: messageLogBreakdown,
      },
      scrapeStats: {
        totalJobs: totalScrapeJobs,
        totalUsersFound,
        completedJobs: completedScrapeJobs,
        failedJobs: failedScrapeJobs,
        cancelledJobs: cancelledScrapeJobs,
        successRate: scrapeSuccessRate,
        byType: {
          group: groupScrapeJobs,
          channel: channelScrapeJobs,
        },
      },
      groupOperationStats: {
        totalOperations: totalGroupOps,
        totalSuccess: totalGroupSuccess,
        totalFailed: totalGroupFailed,
        successRate: groupOpSuccessRate,
        byOperation: {
          addMembers: addOps,
          removeMember: removeOps,
          createGroup: createOps,
          autoManage: manageOps,
        },
      },
      trends: {
        messageTrend,
        previousMessagesSent: prevTotalSent,
        messageSuccessRateTrend: msgSuccessRate - prevMsgSuccessRate,
        previousMessageSuccessRate: prevMsgSuccessRate,
        scrapeTrend,
        previousUsersScraped: prevTotalUsersFound,
        scrapeSuccessRateTrend: scrapeSuccessRate - prevScrapeSuccessRate,
        previousScrapeSuccessRate: prevScrapeSuccessRate,
        groupOperationTrend: groupOpTrend,
        previousGroupOperations: prevTotalGroupOps,
      },
      sessionInfo: {
        phone: session.phone,
        status: session.status,
        isLoggedIn: session.is_logged_in,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  // =========================================================================
  // Dashboard Statistics
  // =========================================================================

  /**
   * Generate comprehensive dashboard statistics for a user.
   *
   * Includes: session counts by status, scraped user totals,
   * message stats (today/week/month), success rates, and top performing sessions.
   *
   * @param {number|string} userId - The requesting user ID
   * @returns {Promise<{
   *   sessions: object,
   *   scraping: object,
   *   messaging: object,
   *   groupOperations: object,
   *   lists: object,
   *   successRates: object,
   *   topSessions: object[],
   *   recentActivity: object[]
   * }>}
   */
  async getDashboardStats(userId) {
    logger.info(`Generating dashboard stats for user ${userId}`);

    const now = moment();
    const todayStart = now.clone().startOf('day').toISOString();
    const weekStart = now.clone().subtract(7, 'days').startOf('day').toISOString();
    const monthStart = now.clone().subtract(30, 'days').startOf('day').toISOString();

    // --- Session counts by status ---
    const sessionStatsResult = await pool.query(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE status = 'active') as active,
         COUNT(*) FILTER (WHERE status = 'inactive') as inactive,
         COUNT(*) FILTER (WHERE status = 'uploaded') as uploaded,
         COUNT(*) FILTER (WHERE status = 'error') as error,
         COUNT(*) FILTER (WHERE status = 'revoked') as revoked,
         COUNT(*) FILTER (WHERE status = 'expired') as expired,
         COUNT(*) FILTER (WHERE is_logged_in = true) as logged_in,
         COUNT(*) FILTER (WHERE is_logged_in = false) as logged_out
       FROM sessions
       WHERE user_id = $1`,
      [userId]
    );

    const sessRow = sessionStatsResult.rows[0];

    // --- Scraped user totals ---
    const scrapedTotalsResult = await pool.query(
      `SELECT
         COUNT(*) as total_entries,
         COUNT(DISTINCT telegram_id) as unique_users
       FROM scraped_users su
       INNER JOIN scraping_jobs sj ON su.job_id = sj.id
       INNER JOIN sessions s ON sj.session_id = s.id
       WHERE s.user_id = $1`,
      [userId]
    );

    const scrapedRow = scrapedTotalsResult.rows[0];
    const totalScrapedEntries = parseInt(scrapedRow.total_entries, 10);
    const uniqueScrapedUsers = parseInt(scrapedRow.unique_users, 10);

    // Scraped today / this week / this month
    const scrapedTimeResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE su.scraped_at >= $2) as scraped_today,
         COUNT(*) FILTER (WHERE su.scraped_at >= $3) as scraped_week,
         COUNT(*) FILTER (WHERE su.scraped_at >= $4) as scraped_month
       FROM scraped_users su
       INNER JOIN scraping_jobs sj ON su.job_id = sj.id
       INNER JOIN sessions s ON sj.session_id = s.id
       WHERE s.user_id = $1`,
      [userId, todayStart, weekStart, monthStart]
    );

    const scrapedTimeRow = scrapedTimeResult.rows[0];

    // --- Message stats ---
    // From messaging_jobs aggregate counts
    const msgJobStatsResult = await pool.query(
      `SELECT
         COUNT(*) as total_jobs,
         COALESCE(SUM(sent_count), 0) as total_sent,
         COALESCE(SUM(failed_count), 0) as total_failed,
         COALESCE(SUM(skipped_count), 0) as total_skipped,
         COALESCE(SUM(total_count), 0) as total_attempted,
         COUNT(*) FILTER (WHERE mj.status = 'completed') as completed_jobs,
         COUNT(*) FILTER (WHERE mj.status = 'failed') as failed_jobs
       FROM messaging_jobs mj
       INNER JOIN sessions s ON mj.session_id = s.id
       WHERE s.user_id = $1`,
      [userId]
    );

    const msgJobRow = msgJobStatsResult.rows[0];
    const totalMsgJobs = parseInt(msgJobRow.total_jobs, 10);
    const totalMsgSent = parseInt(msgJobRow.total_sent, 10);
    const totalMsgFailed = parseInt(msgJobRow.total_failed, 10);
    const totalMsgSkipped = parseInt(msgJobRow.total_skipped, 10);
    const totalMsgAttempted = parseInt(msgJobRow.total_attempted, 10);
    const completedMsgJobs = parseInt(msgJobRow.completed_jobs, 10);
    const failedMsgJobs = parseInt(msgJobRow.failed_jobs, 10);
    const overallMsgSuccessRate = totalMsgAttempted > 0
      ? Math.round((totalMsgSent / totalMsgAttempted) * 10000) / 100
      : 0;

    // Messages today / week / month
    const msgTimeResult = await pool.query(
      `SELECT
         COALESCE(SUM(mj.sent_count) FILTER (WHERE mj.created_at >= $2), 0) as sent_today,
         COALESCE(SUM(mj.sent_count) FILTER (WHERE mj.created_at >= $3), 0) as sent_week,
         COALESCE(SUM(mj.sent_count) FILTER (WHERE mj.created_at >= $4), 0) as sent_month,
         COUNT(*) FILTER (WHERE mj.created_at >= $2) as jobs_today,
         COUNT(*) FILTER (WHERE mj.created_at >= $3) as jobs_week,
         COUNT(*) FILTER (WHERE mj.created_at >= $4) as jobs_month
       FROM messaging_jobs mj
       INNER JOIN sessions s ON mj.session_id = s.id
       WHERE s.user_id = $1`,
      [userId, todayStart, weekStart, monthStart]
    );

    const msgTimeRow = msgTimeResult.rows[0];

    // Also count single messages (not tied to jobs) from message_logs
    const singleMsgsResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE ml.sent_at >= $2 AND ml.job_id IS NULL) as single_today,
         COUNT(*) FILTER (WHERE ml.sent_at >= $3 AND ml.job_id IS NULL) as single_week,
         COUNT(*) FILTER (WHERE ml.sent_at >= $4 AND ml.job_id IS NULL) as single_month,
         COUNT(*) FILTER (WHERE ml.sent_at >= $2 AND ml.job_id IS NULL AND ml.status = 'sent') as single_sent_today,
         COUNT(*) FILTER (WHERE ml.sent_at >= $3 AND ml.job_id IS NULL AND ml.status = 'sent') as single_sent_week,
         COUNT(*) FILTER (WHERE ml.sent_at >= $4 AND ml.job_id IS NULL AND ml.status = 'sent') as single_sent_month
       FROM message_logs ml
       INNER JOIN sessions s ON ml.session_id = s.id
       WHERE s.user_id = $1`,
      [userId, todayStart, weekStart, monthStart]
    );

    const singleMsgsRow = singleMsgsResult.rows[0];

    // --- Scraping stats ---
    const scrapeJobStatsResult = await pool.query(
      `SELECT
         COUNT(*) as total_jobs,
         COALESCE(SUM(total_found), 0) as total_found,
         COUNT(*) FILTER (WHERE sj.status = 'completed') as completed_jobs,
         COUNT(*) FILTER (WHERE sj.status = 'failed') as failed_jobs,
         COUNT(*) FILTER (WHERE sj.status = 'cancelled') as cancelled_jobs
       FROM scraping_jobs sj
       INNER JOIN sessions s ON sj.session_id = s.id
       WHERE s.user_id = $1`,
      [userId]
    );

    const scrapeJobRow = scrapeJobStatsResult.rows[0];
    const totalScrapeJobs = parseInt(scrapeJobRow.total_jobs, 10);
    const totalScrapeFound = parseInt(scrapeJobRow.total_found, 10);
    const completedScrapeJobs = parseInt(scrapeJobRow.completed_jobs, 10);
    const failedScrapeJobs = parseInt(scrapeJobRow.failed_jobs, 10);
    const cancelledScrapeJobs = parseInt(scrapeJobRow.cancelled_jobs, 10);
    const scrapeSuccessRate = (completedScrapeJobs + failedScrapeJobs) > 0
      ? Math.round((completedScrapeJobs / (completedScrapeJobs + failedScrapeJobs)) * 10000) / 100
      : 0;

    // Scraping jobs today/week/month
    const scrapeTimeResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE sj.created_at >= $2) as jobs_today,
         COUNT(*) FILTER (WHERE sj.created_at >= $3) as jobs_week,
         COUNT(*) FILTER (WHERE sj.created_at >= $4) as jobs_month,
         COALESCE(SUM(sj.total_found) FILTER (WHERE sj.created_at >= $2), 0) as found_today,
         COALESCE(SUM(sj.total_found) FILTER (WHERE sj.created_at >= $3), 0) as found_week,
         COALESCE(SUM(sj.total_found) FILTER (WHERE sj.created_at >= $4), 0) as found_month
       FROM scraping_jobs sj
       INNER JOIN sessions s ON sj.session_id = s.id
       WHERE s.user_id = $1`,
      [userId, todayStart, weekStart, monthStart]
    );

    const scrapeTimeRow = scrapeTimeResult.rows[0];

    // --- Group operation stats ---
    const groupOpStatsResult = await pool.query(
      `SELECT
         COUNT(*) as total_ops,
         COALESCE(SUM(success_count), 0) as total_success,
         COALESCE(SUM(failed_count), 0) as total_failed,
         COALESCE(SUM(total_count), 0) as total_attempted
       FROM group_operations go
       INNER JOIN sessions s ON go.session_id = s.id
       WHERE s.user_id = $1`,
      [userId]
    );

    const groupOpRow = groupOpStatsResult.rows[0];
    const totalGroupOps = parseInt(groupOpRow.total_ops, 10);
    const totalGroupSuccess = parseInt(groupOpRow.total_success, 10);
    const totalGroupFailed = parseInt(groupOpRow.total_failed, 10);
    const totalGroupAttempted = parseInt(groupOpRow.total_attempted, 10);
    const groupOpSuccessRate = totalGroupAttempted > 0
      ? Math.round((totalGroupSuccess / totalGroupAttempted) * 10000) / 100
      : 0;

    // --- List stats ---
    const listStatsResult = await pool.query(
      `SELECT
         COUNT(*) as total_lists,
         COALESCE(SUM(items_count), 0) as total_items
       FROM lists
       WHERE user_id = $1`,
      [userId]
    );

    const listRow = listStatsResult.rows[0];

    // --- Top performing sessions ---
    // Sessions ranked by total messages sent
    const topSessionsResult = await pool.query(
      `SELECT s.id, s.phone, s.status,
              COALESCE(SUM(mj.sent_count), 0) as total_sent,
              COALESCE(SUM(mj.failed_count), 0) as total_failed,
              COUNT(DISTINCT mj.id) as total_jobs,
              COALESCE(SUM(sj.total_found), 0) as total_scraped
       FROM sessions s
       LEFT JOIN messaging_jobs mj ON s.id = mj.session_id
       LEFT JOIN scraping_jobs sj ON s.id = sj.session_id
       WHERE s.user_id = $1
       GROUP BY s.id, s.phone, s.status
       ORDER BY total_sent DESC
       LIMIT 5`,
      [userId]
    );

    const topSessions = topSessionsResult.rows.map((row) => ({
      sessionId: row.id,
      phone: row.phone,
      status: row.status,
      totalSent: parseInt(row.total_sent, 10),
      totalFailed: parseInt(row.total_failed, 10),
      totalJobs: parseInt(row.total_jobs, 10),
      totalScraped: parseInt(row.total_scraped, 10),
    }));

    // --- Recent activity ---
    const recentActivityResult = await pool.query(
      `SELECT id, action, entity_type, entity_id, details, created_at
       FROM activity_logs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId]
    );

    const recentActivity = recentActivityResult.rows.map((row) => ({
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: row.details,
      createdAt: row.created_at,
    }));

    return {
      sessions: {
        total: parseInt(sessRow.total, 10),
        active: parseInt(sessRow.active, 10),
        inactive: parseInt(sessRow.inactive, 10),
        uploaded: parseInt(sessRow.uploaded, 10),
        error: parseInt(sessRow.error, 10),
        revoked: parseInt(sessRow.revoked, 10),
        expired: parseInt(sessRow.expired, 10),
        loggedIn: parseInt(sessRow.logged_in, 10),
        loggedOut: parseInt(sessRow.logged_out, 10),
      },
      scraping: {
        totalJobs: totalScrapeJobs,
        totalUsersFound: totalScrapeFound,
        uniqueScrapedUsers,
        completedJobs: completedScrapeJobs,
        failedJobs: failedScrapeJobs,
        cancelledJobs: cancelledScrapeJobs,
        successRate: scrapeSuccessRate,
        today: {
          jobs: parseInt(scrapeTimeRow.jobs_today, 10),
          found: parseInt(scrapeTimeRow.found_today, 10),
        },
        thisWeek: {
          jobs: parseInt(scrapeTimeRow.jobs_week, 10),
          found: parseInt(scrapeTimeRow.found_week, 10),
        },
        thisMonth: {
          jobs: parseInt(scrapeTimeRow.jobs_month, 10),
          found: parseInt(scrapeTimeRow.found_month, 10),
        },
        scrapedToday: parseInt(scrapedTimeRow.scraped_today, 10),
        scrapedThisWeek: parseInt(scrapedTimeRow.scraped_week, 10),
        scrapedThisMonth: parseInt(scrapedTimeRow.scraped_month, 10),
      },
      messaging: {
        totalJobs: totalMsgJobs,
        totalSent: totalMsgSent,
        totalFailed: totalMsgFailed,
        totalSkipped: totalMsgSkipped,
        totalAttempted: totalMsgAttempted,
        completedJobs: completedMsgJobs,
        failedJobs: failedMsgJobs,
        successRate: overallMsgSuccessRate,
        today: {
          jobs: parseInt(msgTimeRow.jobs_today, 10),
          sent: parseInt(msgTimeRow.sent_today, 10) + parseInt(singleMsgsRow.single_sent_today, 10),
          singleMessages: parseInt(singleMsgsRow.single_today, 10),
        },
        thisWeek: {
          jobs: parseInt(msgTimeRow.jobs_week, 10),
          sent: parseInt(msgTimeRow.sent_week, 10) + parseInt(singleMsgsRow.single_sent_week, 10),
          singleMessages: parseInt(singleMsgsRow.single_week, 10),
        },
        thisMonth: {
          jobs: parseInt(msgTimeRow.jobs_month, 10),
          sent: parseInt(msgTimeRow.sent_month, 10) + parseInt(singleMsgsRow.single_sent_month, 10),
          singleMessages: parseInt(singleMsgsRow.single_month, 10),
        },
      },
      groupOperations: {
        totalOperations: totalGroupOps,
        totalSuccess: totalGroupSuccess,
        totalFailed: totalGroupFailed,
        totalAttempted: totalGroupAttempted,
        successRate: groupOpSuccessRate,
      },
      lists: {
        totalLists: parseInt(listRow.total_lists, 10),
        totalItems: parseInt(listRow.total_items, 10),
      },
      successRates: {
        messaging: overallMsgSuccessRate,
        scraping: scrapeSuccessRate,
        groupOperations: groupOpSuccessRate,
      },
      topSessions,
      recentActivity,
      generatedAt: new Date().toISOString(),
    };
  }

  // =========================================================================
  // Report Persistence
  // =========================================================================

  /**
   * Save a generated report to the database.
   *
   * @param {number|string} userId - The user who owns this report
   * @param {string} reportType - Type: 'session', 'scrape', 'messaging', 'group', 'channel', 'user', 'dashboard'
   * @param {number|string} targetId - The target entity ID (session, group, list, etc.)
   * @param {string} targetTitle - Human-readable title for the target
   * @param {string|Date} periodStart - Start of the reporting period
   * @param {string|Date} periodEnd - End of the reporting period
   * @param {object} data - The report data object (stored as JSONB)
   * @returns {Promise<{ reportId: number, generatedAt: string }>}
   */
  async saveReport(userId, reportType, targetId, targetTitle, periodStart, periodEnd, data) {
    if (!VALID_REPORT_TYPES.includes(reportType)) {
      throw new AppError(
        `Invalid report type: ${reportType}. Supported: ${VALID_REPORT_TYPES.join(', ')}`,
        400,
        'INVALID_REPORT_TYPE'
      );
    }

    logger.info(`Saving ${reportType} report for user ${userId}`, {
      userId,
      reportType,
      targetId,
    });

    const result = await pool.query(
      `INSERT INTO reports (user_id, report_type, target_id, target_title, period_start, period_end, data, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING id, generated_at`,
      [
        userId,
        reportType,
        targetId ? String(targetId) : null,
        targetTitle || null,
        periodStart ? new Date(periodStart) : null,
        periodEnd ? new Date(periodEnd) : null,
        JSON.stringify(data),
      ]
    );

    return {
      reportId: result.rows[0].id,
      generatedAt: result.rows[0].generated_at,
    };
  }

  /**
   * Get paginated list of saved reports for a user.
   *
   * @param {number|string} userId - The requesting user ID
   * @param {object} params - Query parameters
   * @param {number} params.page - Page number (default: 1)
   * @param {number} params.limit - Items per page (default: 20)
   * @param {string} params.reportType - Filter by report type (optional)
   * @returns {Promise<{ reports: object[], pagination: object }>}
   */
  async getSavedReports(userId, { page = 1, limit = 20, reportType } = {}) {
    logger.info(`Fetching saved reports for user ${userId}`, { page, limit, reportType });

    const { offset, limit: pageSize } = applyPagination(null, page, limit);

    const conditions = ['user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (reportType && VALID_REPORT_TYPES.includes(reportType)) {
      conditions.push(`report_type = $${paramIndex}`);
      values.push(reportType);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM reports WHERE ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated results
    const reportsResult = await pool.query(
      `SELECT id, user_id, report_type, target_id, target_title,
              period_start, period_end, generated_at
       FROM reports
       WHERE ${whereClause}
       ORDER BY generated_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, pageSize, offset]
    );

    const reports = reportsResult.rows.map((row) => ({
      id: row.id,
      type: row.report_type,
      target: row.target_title || row.target_id || 'Unknown',
      targetId: row.target_id,
      targetTitle: row.target_title,
      period: {
        from: row.period_start,
        to: row.period_end,
      },
      periodStart: row.period_start,
      periodEnd: row.period_end,
      generatedAt: row.generated_at,
    }));

    const pagination = buildPagination(page, limit, total);

    return { reports, pagination };
  }

  /**
   * Get a specific saved report by its ID.
   *
   * @param {number|string} reportId - Report database ID
   * @param {number|string} userId - Owner user ID
   * @returns {Promise<{
   *   id: number,
   *   reportType: string,
   *   targetId: string|null,
   *   targetTitle: string|null,
   *   periodStart: string|null,
   *   periodEnd: string|null,
   *   data: object,
   *   generatedAt: string
   * }>}
   */
  async getReportById(reportId, userId) {
    logger.info(`Fetching report ${reportId} for user ${userId}`, { reportId, userId });

    const result = await pool.query(
      `SELECT id, user_id, report_type, target_id, target_title,
              period_start, period_end, data, generated_at
       FROM reports
       WHERE id = $1 AND user_id = $2`,
      [reportId, userId]
    );

    if (result.rows.length === 0) {
      throw new AppError(
        `Report not found or access denied: ${reportId}`,
        404,
        'REPORT_NOT_FOUND'
      );
    }

    const row = result.rows[0];

    let parsedData;
    try {
      parsedData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch {
      parsedData = { raw: row.data };
    }

    return {
      id: row.id,
      type: row.report_type,
      target: row.target_title || row.target_id || 'Unknown',
      targetId: row.target_id,
      targetTitle: row.target_title,
      period: {
        from: row.period_start,
        to: row.period_end,
      },
      periodStart: row.period_start,
      periodEnd: row.period_end,
      data: parsedData,
      generatedAt: row.generated_at,
    };
  }

  /**
   * Delete a saved report from the database.
   *
   * @param {number|string} reportId - Report database ID
   * @param {number|string} userId - Owner user ID
   * @returns {Promise<{ success: boolean, reportId: number }>}
   */
  async deleteReport(reportId, userId) {
    logger.info(`Deleting report ${reportId} for user ${userId}`, { reportId, userId });

    // Verify ownership
    const result = await pool.query(
      'SELECT id, report_type FROM reports WHERE id = $1 AND user_id = $2',
      [reportId, userId]
    );

    if (result.rows.length === 0) {
      throw new AppError(
        `Report not found or access denied: ${reportId}`,
        404,
        'REPORT_NOT_FOUND'
      );
    }

    await pool.query('DELETE FROM reports WHERE id = $1', [reportId]);

    logger.info(`Report ${reportId} deleted`, { reportId });

    return {
      success: true,
      reportId: Number(reportId),
    };
  }

  // =========================================================================
  // Report Export
  // =========================================================================

  /**
   * Export a saved report in the specified format.
   *
   * @param {number|string} reportId - Report database ID
   * @param {string} format - Export format: 'csv' or 'json'
   * @param {number|string} userId - Owner user ID
   * @returns {Promise<{
   *   content: string,
   *   filename: string,
   *   mimeType: string,
   *   reportType: string
   * }>}
   */
  async exportReport(reportId, format, userId) {
    const exportFormat = (format || 'json').toLowerCase();

    if (!VALID_EXPORT_FORMATS.includes(exportFormat)) {
      throw new AppError(
        `Invalid export format: ${format}. Supported: ${VALID_EXPORT_FORMATS.join(', ')}`,
        400,
        'INVALID_EXPORT_FORMAT'
      );
    }

    logger.info(`Exporting report ${reportId} as ${exportFormat}`, { reportId, userId });

    // Fetch the report
    const report = await this.getReportById(reportId, userId);

    const reportData = report.data;
    const reportTitle = report.targetTitle || report.reportType;
    const timestamp = moment(report.generatedAt).format('YYYY-MM-DD_HH-mm-ss');

    if (exportFormat === 'json') {
      return {
        content: JSON.stringify(reportData, null, 2),
        filename: `report_${report.reportType}_${reportTitle}_${timestamp}.json`,
        mimeType: 'application/json',
        reportType: report.reportType,
      };
    }

    // CSV export: flatten the report data into tabular format
    if (exportFormat === 'csv') {
      const csvRows = [];

      // Add metadata header rows
      csvRows.push(`Report Type,${report.reportType}`);
      csvRows.push(`Target,${report.targetTitle || 'N/A'}`);
      csvRows.push(`Period,${report.periodStart || 'N/A'} to ${report.periodEnd || 'N/A'}`);
      csvRows.push(`Generated,${report.generatedAt}`);
      csvRows.push(''); // Blank separator

      // Flatten data object into CSV
      const flattenAndCsv = (obj, prefix = '') => {
        const rows = [];
        for (const [key, value] of Object.entries(obj)) {
          const fullKey = prefix ? `${prefix}.${key}` : key;
          if (value === null || value === undefined) {
            rows.push(`"${fullKey}",""`);
          } else if (Array.isArray(value)) {
            rows.push(`"${fullKey}","[Array of ${value.length} items]"`);
          } else if (typeof value === 'object') {
            rows.push(...flattenAndCsv(value, fullKey));
          } else {
            rows.push(`"${fullKey}","${String(value).replace(/"/g, '""')}"`);
          }
        }
        return rows;
      };

      csvRows.push('"Field","Value"');
      csvRows.push(...flattenAndCsv(reportData));

      return {
        content: csvRows.join('\r\n'),
        filename: `report_${report.reportType}_${reportTitle}_${timestamp}.csv`,
        mimeType: 'text/csv',
        reportType: report.reportType,
      };
    }
  }

  // =========================================================================
  // Activity Log
  // =========================================================================

  /**
   * Log an activity event for a user.
   *
   * @param {number|string} userId - The user performing the action
   * @param {string} action - Action type (see VALID_ACTIONS)
   * @param {string} entityType - Entity type: 'session', 'scrape_job', 'messaging_job', 'group', 'list', 'report'
   * @param {number|string} entityId - Entity database ID
   * @param {object} details - Additional details (stored as JSONB)
   * @returns {Promise<{ logId: number, createdAt: string }>}
   */
  async logActivity(userId, action, entityType, entityId, details = {}) {
    if (!VALID_ACTIONS.includes(action)) {
      logger.warn(`Unknown activity action logged: ${action}`, { userId });
    }

    const result = await pool.query(
      `INSERT INTO activity_logs (user_id, action, entity_type, entity_id, details, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, created_at`,
      [userId, action, entityType, entityId ? parseInt(entityId, 10) : null, JSON.stringify(details)]
    );

    return {
      logId: result.rows[0].id,
      createdAt: result.rows[0].created_at,
    };
  }

  /**
   * Get paginated activity log for a user with optional filters.
   *
   * @param {number|string} userId - The requesting user ID
   * @param {object} params - Query parameters
   * @param {number} params.page - Page number (default: 1)
   * @param {number} params.limit - Items per page (default: 20)
   * @param {string} params.action - Filter by action type (optional)
   * @param {string} params.entityType - Filter by entity type (optional)
   * @returns {Promise<{ activities: object[], pagination: object }>}
   */
  async getActivityLog(userId, { page = 1, limit = 20, action, entityType } = {}) {
    logger.info(`Fetching activity log for user ${userId}`, { page, limit, action, entityType });

    const { offset, limit: pageSize } = applyPagination(null, page, limit);

    const conditions = ['user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (action) {
      conditions.push(`action = $${paramIndex}`);
      values.push(action);
      paramIndex++;
    }

    if (entityType) {
      conditions.push(`entity_type = $${paramIndex}`);
      values.push(entityType);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM activity_logs WHERE ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated results
    const activitiesResult = await pool.query(
      `SELECT id, user_id, action, entity_type, entity_id, details, created_at
       FROM activity_logs
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, pageSize, offset]
    );

    const activities = activitiesResult.rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: row.details,
      createdAt: row.created_at,
    }));

    const pagination = buildPagination(page, limit, total);

    return { activities, pagination };
  }
}

module.exports = new ReportService();
