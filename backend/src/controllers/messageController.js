const messageService = require('../services/messageService');
const reportService = require('../services/reportService');
const messageQueue = require('../queues/messageQueue');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const messageController = {
  /**
   * Send a single message to a target.
   *
   * Expects req.body: { sessionId, targetId, message, options? }
   */
  sendMessage: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionId, targetId, message, options } = req.body;

    if (!sessionId) {
      throw new AppError('sessionId is required', 400, 'MISSING_SESSION_ID');
    }

    if (!targetId) {
      throw new AppError('targetId is required', 400, 'MISSING_TARGET_ID');
    }

    if (!message || message.trim().length === 0) {
      throw new AppError('message content is required', 400, 'EMPTY_MESSAGE');
    }

    const parsedOptions = typeof options === 'string' ? JSON.parse(options) : (options || {});

    const result = await messageService.sendMessage(sessionId, targetId, message, parsedOptions, userId);

    await reportService.logActivity(
      userId,
      'message_send',
      'message',
      null,
      {
        sessionId,
        targetId: String(targetId),
        success: result.success,
      }
    );

    logger.info(`Single message sent by user ${userId}`, {
      sessionId,
      targetId,
      success: result.success,
    });

    if (!result.success) {
      return res.status(200).json({
        success: true,
        data: {
          success: false,
          targetId: result.targetId,
          error: result.error,
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        success: true,
        messageId: result.messageId,
        targetId: result.targetId,
        date: result.date,
      },
    });
  }),

  /**
   * Create a bulk messaging job.
   *
   * Expects req.body: { sessionIds: [number], targetList: [...], message, messageType?, delayMin?, delayMax?, messagesPerSession?, messageOptions? }
   * If async=true, the job is added to BullMQ queue.
   */
  sendBulk: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const {
      sessionIds,
      targetList,
      message,
      messageType,
      delayMin,
      delayMax,
      messagesPerSession,
      messageOptions,
      async,
      sourceType,
      sourceId,
    } = req.body;

    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('sessionIds array is required and must not be empty', 400, 'NO_SESSIONS');
    }

    if (!targetList || !Array.isArray(targetList) || targetList.length === 0) {
      throw new AppError('targetList is required and must not be empty', 400, 'EMPTY_TARGET_LIST');
    }

    if (!message || message.trim().length === 0) {
      throw new AppError('message content is required', 400, 'EMPTY_MESSAGE');
    }

    const params = {
      sessionIds,
      targetList,
      message: message.trim(),
      messageType: messageType || 'text',
      delayMin: delayMin ? parseInt(delayMin, 10) : undefined,
      delayMax: delayMax ? parseInt(delayMax, 10) : undefined,
      messagesPerSession: messagesPerSession ? parseInt(messagesPerSession, 10) : undefined,
      messageOptions: typeof messageOptions === 'string' ? JSON.parse(messageOptions) : (messageOptions || {}),
      sourceType: sourceType || 'manual',
      sourceId: sourceId ? parseInt(sourceId, 10) : undefined,
    };

    // Async mode: add to BullMQ queue
    if (async === 'true' || async === true) {
      const queueJob = await messageQueue.addJob({
        type: 'bulk',
        params,
        userId,
      });

      await reportService.logActivity(
        userId,
        'message_bulk_start',
        'messaging_job',
        null,
        {
          queueJobId: queueJob.id,
          sessionCount: sessionIds.length,
          targetCount: targetList.length,
          messageType: params.messageType,
        }
      );

      logger.info(`Bulk message job queued by user ${userId}`, {
        queueJobId: queueJob.id,
        sessionCount: sessionIds.length,
        targetCount: targetList.length,
      });

      return res.status(202).json({
        success: true,
        data: {
          queueJobId: queueJob.id,
          status: 'queued',
          totalTargets: targetList.length,
          sessionCount: sessionIds.length,
        },
      });
    }

    // Sync mode: run inline
    const result = await messageService.sendBulkMessage(params, userId);

    await reportService.logActivity(
      userId,
      result.status === 'completed' ? 'message_bulk_complete' : 'message_bulk_fail',
      'messaging_job',
      result.jobId,
      {
        jobId: result.jobId,
        totalTargets: result.totalTargets,
        sessionCount: result.sessionCount,
        results: result.results,
      }
    );

    logger.info(`Bulk message job completed by user ${userId}`, {
      jobId: result.jobId,
      status: result.status,
      totalTargets: result.totalTargets,
    });

    return res.status(200).json({
      success: true,
      data: {
        jobId: result.jobId,
        status: result.status,
        totalTargets: result.totalTargets,
        sessionCount: result.sessionCount,
        results: result.results,
      },
    });
  }),

  /**
   * Send a message to a Telegram group or channel.
   *
   * Expects req.body: { sessionId, groupId, message }
   */
  sendMessageToGroup: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionId, groupId, message } = req.body;

    if (!sessionId) {
      throw new AppError('sessionId is required', 400, 'MISSING_SESSION_ID');
    }

    if (!groupId) {
      throw new AppError('groupId is required', 400, 'MISSING_GROUP_ID');
    }

    if (!message || message.trim().length === 0) {
      throw new AppError('message content is required', 400, 'EMPTY_MESSAGE');
    }

    const result = await messageService.sendMessageToGroup(sessionId, groupId, message, userId);

    await reportService.logActivity(
      userId,
      'message_send',
      'message',
      null,
      {
        sessionId,
        groupId: String(groupId),
        success: result.success,
        type: 'group_message',
      }
    );

    logger.info(`Group message sent by user ${userId}`, {
      sessionId,
      groupId,
      success: result.success,
    });

    if (!result.success) {
      return res.status(200).json({
        success: true,
        data: {
          success: false,
          groupId: result.groupId,
          error: result.error,
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        success: true,
        messageId: result.messageId,
        groupId: result.groupId,
        date: result.date,
      },
    });
  }),

  /**
   * Forward a message from one chat to another.
   *
   * Expects req.body: { sessionId, targetId, messageId, sourceId }
   */
  forwardMessage: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionId, targetId, messageId, sourceId } = req.body;

    if (!sessionId) {
      throw new AppError('sessionId is required', 400, 'MISSING_SESSION_ID');
    }

    if (!targetId) {
      throw new AppError('targetId is required', 400, 'MISSING_TARGET_ID');
    }

    if (!messageId) {
      throw new AppError('messageId is required', 400, 'MISSING_MESSAGE_ID');
    }

    if (!sourceId) {
      throw new AppError('sourceId is required', 400, 'MISSING_SOURCE_ID');
    }

    const result = await messageService.forwardMessage(sessionId, targetId, messageId, sourceId, userId);

    await reportService.logActivity(
      userId,
      'message_send',
      'message',
      null,
      {
        sessionId,
        targetId: String(targetId),
        sourceId: String(sourceId),
        messageId,
        success: result.success,
        type: 'forward',
      }
    );

    logger.info(`Message forwarded by user ${userId}`, {
      sessionId,
      targetId,
      sourceId,
      messageId,
      success: result.success,
    });

    if (!result.success) {
      return res.status(200).json({
        success: true,
        data: {
          success: false,
          sourceId: result.sourceId,
          targetId: result.targetId,
          error: result.error,
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        success: true,
        messageId: result.messageId,
        sourceId: result.sourceId,
        targetId: result.targetId,
        date: result.date,
      },
    });
  }),

  /**
   * List messaging jobs with pagination and optional filters.
   *
   * Query params: page, limit, sort, order, status
   */
  getJobs: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const sort = req.query.sort || 'created_at';
    const order = req.query.order || 'DESC';
    const status = req.query.status || undefined;

    const { jobs, pagination } = await messageService.listJobs(userId, {
      page,
      limit,
      sort,
      order,
      status,
    });

    return res.status(200).json({
      success: true,
      data: {
        jobs,
        pagination,
      },
    });
  }),

  /**
   * Get messaging job details with progress and logs.
   *
   * Job ID comes from req.params.id.
   */
  getJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = req.params.id;

    if (!jobId) {
      throw new AppError('Job ID is required', 400, 'MISSING_JOB_ID');
    }

    const result = await messageService.getJobDetails(jobId, userId);

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Cancel a running messaging job.
   *
   * Job ID comes from req.params.id.
   */
  cancelJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = req.params.id;

    if (!jobId) {
      throw new AppError('Job ID is required', 400, 'MISSING_JOB_ID');
    }

    const result = await messageService.cancelJob(jobId, userId);

    // Also try to cancel in BullMQ queue
    try {
      await messageQueue.cancelJob(jobId);
    } catch (queueError) {
      logger.debug(`Job ${jobId} not found in BullMQ queue or already processed`, {
        error: queueError.message,
      });
    }

    await reportService.logActivity(
      userId,
      'message_bulk_cancel',
      'messaging_job',
      jobId,
      { previousStatus: result.previousStatus }
    );

    logger.info(`Messaging job ${jobId} cancelled by user ${userId}`, {
      jobId,
      previousStatus: result.previousStatus,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Get message history with filtering and pagination.
   *
   * Query params: page, limit, status, sessionId, dateFrom, dateTo
   */
  getMessageHistory: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const status = req.query.status || undefined;
    const sessionId = req.query.sessionId ? parseInt(req.query.sessionId, 10) : undefined;
    const dateFrom = req.query.dateFrom || undefined;
    const dateTo = req.query.dateTo || undefined;

    const result = await messageService.getMessageHistory(userId, {
      page,
      limit,
      status,
      sessionId,
      dateFrom,
      dateTo,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Get messaging statistics for the authenticated user.
   */
  getMessagingStats: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const stats = await messageService.getMessagingStats(userId);

    return res.status(200).json({
      success: true,
      data: stats,
    });
  }),

  /**
   * Send a test/preview message to verify formatting and delivery.
   *
   * Expects req.body: { sessionId, targetId, message }
   */
  previewMessage: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionId, targetId, message } = req.body;

    if (!sessionId) {
      throw new AppError('sessionId is required', 400, 'MISSING_SESSION_ID');
    }

    if (!targetId) {
      throw new AppError('targetId is required', 400, 'MISSING_TARGET_ID');
    }

    if (!message || message.trim().length === 0) {
      throw new AppError('message content is required for preview', 400, 'EMPTY_MESSAGE');
    }

    const result = await messageService.previewMessage(sessionId, targetId, message, userId);

    await reportService.logActivity(
      userId,
      'message_send',
      'message',
      null,
      {
        sessionId,
        targetId: String(targetId),
        preview: true,
        success: result.success,
      }
    );

    logger.info(`Preview message by user ${userId}`, {
      sessionId,
      targetId,
      success: result.success,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Send bulk messages to groups with queue-based rate limiting.
   *
   * Expects req.body: { sessionIds: [number], groupIds: [string], message, messageType?, delayBetweenRounds? }
   */
  sendBulkToGroups: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const {
      sessionIds,
      groupIds,
      message,
      messageType = 'text',
      delayBetweenRounds = 20,
    } = req.body;

    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('sessionIds array is required', 400, 'NO_SESSIONS');
    }

    if (!groupIds || !Array.isArray(groupIds) || groupIds.length === 0) {
      throw new AppError('groupIds array is required', 400, 'NO_GROUPS');
    }

    if (!message || message.trim().length === 0) {
      throw new AppError('message content is required', 400, 'EMPTY_MESSAGE');
    }

    const result = await messageService.sendBulkToGroups({
      sessionIds,
      groupIds,
      message: message.trim(),
      messageType,
      delayBetweenRounds: parseInt(delayBetweenRounds, 10),
    }, userId);

    await reportService.logActivity(
      userId,
      'message_bulk_groups_start',
      'messaging_job',
      null,
      {
        jobId: result.jobId,
        sessionCount: sessionIds.length,
        groupCount: groupIds.length,
      }
    );

    logger.info(`Bulk group messaging job queued by user ${userId}`, {
      jobId: result.jobId,
      sessionCount: sessionIds.length,
      groupCount: groupIds.length,
    });

    return res.status(202).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Send bulk messages to users (from scraped lists) with queue-based rate limiting.
   *
   * Expects req.body: { sessionIds: [number], users: [...], message, messageType?, usersPerRound?, delayBetweenRounds? }
   */
  sendBulkToUsers: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const {
      sessionIds,
      users,
      message,
      messageType = 'text',
      usersPerRound = 5,
      delayBetweenRounds = 60,
    } = req.body;

    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('sessionIds array is required', 400, 'NO_SESSIONS');
    }

    if (!users || !Array.isArray(users) || users.length === 0) {
      throw new AppError('users array is required', 400, 'NO_USERS');
    }

    if (!message || message.trim().length === 0) {
      throw new AppError('message content is required', 400, 'EMPTY_MESSAGE');
    }

    const result = await messageService.sendBulkToUsers({
      sessionIds,
      users,
      message: message.trim(),
      messageType,
      usersPerRound: parseInt(usersPerRound, 10),
      delayBetweenRounds: parseInt(delayBetweenRounds, 10),
    }, userId);

    await reportService.logActivity(
      userId,
      'message_bulk_users_start',
      'messaging_job',
      null,
      {
        jobId: result.jobId,
        sessionCount: sessionIds.length,
        userCount: users.length,
      }
    );

    logger.info(`Bulk user messaging job queued by user ${userId}`, {
      jobId: result.jobId,
      sessionCount: sessionIds.length,
      userCount: users.length,
    });

    return res.status(202).json({
      success: true,
      data: result,
    });
  }),
};

module.exports = messageController;
