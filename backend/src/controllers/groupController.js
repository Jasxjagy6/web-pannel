const groupService = require('../services/groupService');
const telegramService = require('../services/telegramService');
const reportService = require('../services/reportService');
const groupQueue = require('../queues/groupQueue');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const { resolveSessionIdsFromRequest } = require('../utils/resolveSessions');
const logger = require('../utils/logger');

const groupController = {
  /**
   * Add members to groups/channels (supports multi-session, multi-target).
   *
   * Expects req.body: {
   *   sessionIds: [number],       // NEW: multiple sessions
   *   sessionId: number,          // OLD: single session (backward compat)
   *   targetIds: [string],        // NEW: multiple targets
   *   targetGroupId: string,      // OLD: single target (backward compat)
   *   targetType: 'group'|'channel',
   *   userList: [...],
   *   delayMin: number,
   *   delayMax: number,
   *   batchSize: number,
   *   async: boolean
   * }
   */
  addMembers: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const {
      sessionIds,
      sessionId,
      targetIds,
      targetGroupId,
      targetType = 'group',
      userList,
      delayMin,
      delayMax,
      batchSize,
      delay,
      async,
    } = req.body;

    // Support both old and new API. If the caller passed `sessionListId`,
    // expand it; else honour the explicit IDs.
    const explicitSessionIds = sessionIds || (sessionId ? [sessionId] : []);
    const finalSessionIds = await resolveSessionIdsFromRequest(req, explicitSessionIds);
    const finalTargetIds = targetIds || (targetGroupId ? [targetGroupId] : []);

    if (!finalSessionIds || finalSessionIds.length === 0) {
      throw new AppError(
        'sessionIds array, sessionId, or a non-empty sessionListId is required',
        400,
        'MISSING_SESSION_ID'
      );
    }

    if (!finalTargetIds || finalTargetIds.length === 0) {
      throw new AppError('targetIds array or targetGroupId is required', 400, 'MISSING_TARGET_ID');
    }

    if (!userList || !Array.isArray(userList) || userList.length === 0) {
      throw new AppError('userList is required and must not be empty', 400, 'EMPTY_USER_LIST');
    }

    const options = {
      sessionIds: finalSessionIds,
      targetIds: finalTargetIds,
      targetType,
      userList,
      delayMin: delayMin !== undefined ? parseInt(delayMin, 10) : (delay !== undefined ? parseInt(delay, 10) : undefined),
      delayMax: delayMax !== undefined ? parseInt(delayMax, 10) : undefined,
      batchSize: batchSize ? parseInt(batchSize, 10) : undefined,
    };

    // Async mode: add to BullMQ queue
    if (async === 'true' || async === true) {
      const queueJob = await groupQueue.addJob({
        type: 'add-members',
        ...options,
        userId,
      });

      await reportService.logActivity(
        userId,
        'group_add_members_start',
        'group_operation',
        null,
        {
          type: 'add_members',
          targetIds: finalTargetIds,
          sessionIds: finalSessionIds,
          queueJobId: queueJob.id,
          totalUsers: userList.length,
        }
      );

      logger.info(`Add members job queued by user ${userId}`, {
        queueJobId: queueJob.id,
        targetCount: finalTargetIds.length,
        sessionCount: finalSessionIds.length,
        totalUsers: userList.length,
      });

      return res.status(202).json({
        success: true,
        data: {
          queueJobId: queueJob.id,
          status: 'queued',
          totalUsers: userList.length,
        },
      });
    }

    // Sync mode: run inline
    const result = await groupService.addMembersToGroups(options, userId);

    await reportService.logActivity(
      userId,
      result.failed === 0 ? 'group_add_complete' : 'group_add_partial',
      'group_operation',
      result.opId,
      {
        type: 'add_members',
        targetIds: finalTargetIds,
        sessionIds: finalSessionIds,
        totalUsers: result.total,
        addedCount: result.added,
        failedCount: result.failed,
        skippedCount: result.skipped,
      }
    );

    logger.info(`Add members operation completed by user ${userId}`, {
      opId: result.opId,
      added: result.added,
      failed: result.failed,
      skipped: result.skipped,
    });

    return res.status(200).json({
      success: true,
      data: {
        opId: result.opId,
        total: result.total,
        added: result.added,
        failed: result.failed,
        skipped: result.skipped,
        results: result.results,
      },
    });
  }),

  /**
   * Configure group settings (slow mode, permissions, about text).
   */
  configureGroup: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionId, groupId, settings, async } = req.body;

    if (!sessionId) {
      throw new AppError('sessionId is required', 400, 'MISSING_SESSION_ID');
    }

    if (!groupId) {
      throw new AppError('groupId is required', 400, 'MISSING_GROUP_ID');
    }

    if (!settings || Object.keys(settings).length === 0) {
      throw new AppError('settings object is required and must not be empty', 400, 'EMPTY_SETTINGS');
    }

    if (async === 'true' || async === true) {
      const queueJob = await groupQueue.addJob({
        type: 'configure-spam',
        sessionId,
        groupId: String(groupId),
        settings,
        userId,
      });

      await reportService.logActivity(
        userId,
        'group_configure',
        'group_operation',
        null,
        { type: 'configure', groupId: String(groupId), sessionId, queueJobId: queueJob.id }
      );

      logger.info(`Group configuration job queued by user ${userId}`, { queueJobId: queueJob.id, groupId });

      return res.status(202).json({
        success: true,
        data: { queueJobId: queueJob.id, status: 'queued', groupId: String(groupId) },
      });
    }

    const result = await groupService.configureGroupSpam(sessionId, groupId, settings, userId);

    await reportService.logActivity(
      userId,
      'group_configure_complete',
      'group_operation',
      null,
      { type: 'configure', groupId: String(groupId), sessionId, appliedUpdates: result.appliedUpdates }
    );

    logger.info(`Group ${groupId} configured by user ${userId}`, { groupId, appliedUpdates: result.appliedUpdates });

    return res.status(200).json({ success: true, data: result });
  }),

  /**
   * Create a new group with optional initial members.
   */
  createGroup: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionId, title, members, async } = req.body;

    if (!sessionId) {
      throw new AppError('sessionId is required', 400, 'MISSING_SESSION_ID');
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      throw new AppError('title is required', 400, 'MISSING_TITLE');
    }

    const initialMembers = members || [];

    if (async === 'true' || async === true) {
      const queueJob = await groupQueue.addJob({
        type: 'create-group',
        sessionId,
        title: title.trim(),
        members: initialMembers,
        userId,
      });

      await reportService.logActivity(
        userId,
        'group_create',
        'group_operation',
        null,
        { type: 'create_group', title: title.trim(), sessionId, queueJobId: queueJob.id, initialMemberCount: initialMembers.length }
      );

      logger.info(`Create group job queued by user ${userId}`, { queueJobId: queueJob.id, title: title.trim() });

      return res.status(202).json({
        success: true,
        data: { queueJobId: queueJob.id, status: 'queued', title: title.trim() },
      });
    }

    const result = await groupService.createGroup(sessionId, title.trim(), initialMembers, userId);

    await reportService.logActivity(
      userId,
      'group_create_complete',
      'group_operation',
      null,
      { type: 'create_group', groupId: result.groupId, title: result.title, sessionId, membersAdded: result.membersAdded }
    );

    logger.info(`Group created by user ${userId}`, { groupId: result.groupId, title: result.title, membersAdded: result.membersAdded });

    return res.status(201).json({ success: true, data: result });
  }),

  /**
   * List groups/channels the session is a member of, OR list managed groups from DB.
   */
  listGroups: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionId, async } = req.query;

    if (!sessionId) {
      const pool = require('../config/database').pool;
      const result = await pool.query(
        `SELECT DISTINCT
           target_group_id,
           MAX(created_at) as last_operation_at,
           COUNT(*) as total_operations,
           COUNT(*) FILTER (WHERE status = 'completed') as completed_operations,
           COUNT(*) FILTER (WHERE status = 'failed') as failed_operations
         FROM group_operations
         WHERE user_id = $1 AND target_group_id IS NOT NULL
         GROUP BY target_group_id
         ORDER BY last_operation_at DESC`,
        [userId]
      );

      const groups = result.rows.map((row) => ({
        id: row.target_group_id,
        name: row.target_group_id || 'Unknown Group',
        username: null,
        last_operation_at: row.last_operation_at,
        total_operations: parseInt(row.total_operations, 10),
        completed_operations: parseInt(row.completed_operations, 10),
        failed_operations: parseInt(row.failed_operations, 10),
      }));

      return res.status(200).json({ success: true, data: groups });
    }

    if (async === 'true' || async === true) {
      const queueJob = await groupQueue.addJob({ type: 'list-groups', sessionId, userId });
      return res.status(202).json({ success: true, data: { queueJobId: queueJob.id, status: 'queued' } });
    }

    const result = await groupService.listGroups(sessionId, userId);

    await reportService.logActivity(
      userId,
      'group_list',
      'group_operation',
      null,
      { type: 'list_groups', sessionId, totalGroups: result.total }
    );

    logger.info(`Listed groups for session ${sessionId} by user ${userId}`, { total: result.total });

    return res.status(200).json({ success: true, data: result });
  }),

  /**
   * List group operations with pagination and optional filter.
   */
  listOperations: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const sort = req.query.sort || 'created_at';
    const order = req.query.order || 'DESC';
    const filter = req.query.filter || undefined;

    const { operations, pagination } = await groupService.listOperations(userId, {
      page, limit, sort, order, filter,
    });

    return res.status(200).json({
      success: true,
      data: { operations, pagination },
    });
  }),

  /**
   * Get details of a specific group operation.
   */
  getOperation: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const opId = req.params.id;

    if (!opId) {
      throw new AppError('Operation ID is required', 400, 'MISSING_OPERATION_ID');
    }

    const result = await groupService.getOperationDetails(opId, userId);

    return res.status(200).json({ success: true, data: { operation: result } });
  }),

  /**
   * Cancel a running group operation.
   */
  cancelOperation: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const opId = req.params.id;

    if (!opId) {
      throw new AppError('Operation ID is required', 400, 'MISSING_OPERATION_ID');
    }

    const result = await groupService.cancelOperation(opId, userId);

    try {
      await groupQueue.cancelJob(opId);
    } catch (queueError) {
      logger.debug(`Operation ${opId} not found in BullMQ queue`, { error: queueError.message });
    }

    await reportService.logActivity(userId, 'group_cancel', 'group_operation', opId, { type: 'cancel' });
    logger.info(`Group operation ${opId} cancelled by user ${userId}`);

    return res.status(200).json({ success: true, data: result });
  }),

  /**
   * Get detailed information about a specific group or channel.
   */
  getGroupInfo: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const groupId = req.params.id;
    const { sessionId, async } = req.query;

    if (!sessionId) {
      throw new AppError('sessionId query parameter is required', 400, 'MISSING_SESSION_ID');
    }

    if (!groupId) {
      throw new AppError('Group ID is required', 400, 'MISSING_GROUP_ID');
    }

    if (async === 'true' || async === true) {
      const queueJob = await groupQueue.addJob({ type: 'get-info', sessionId, groupId: String(groupId), userId });
      return res.status(202).json({
        success: true,
        data: { queueJobId: queueJob.id, status: 'queued', groupId: String(groupId) },
      });
    }

    const result = await groupService.getGroupInfo(sessionId, groupId, userId);

    await reportService.logActivity(
      userId,
      'group_info',
      'group_operation',
      null,
      { type: 'get_info', groupId: String(groupId), sessionId }
    );

    logger.info(`Retrieved group info for ${groupId} by user ${userId}`, { groupId });

    return res.status(200).json({ success: true, data: result });
  }),

  /**
   * Join multiple sessions to multiple groups/channels.
   */
  joinChannels: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionIds: rawSessionIds, targetIds, targetType = 'group' } = req.body;

    const sessionIds = await resolveSessionIdsFromRequest(req, rawSessionIds || []);
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError(
        'sessionIds array (or a non-empty sessionListId) is required',
        400,
        'MISSING_SESSIONS'
      );
    }

    if (!targetIds || !Array.isArray(targetIds) || targetIds.length === 0) {
      throw new AppError('targetIds array is required', 400, 'MISSING_TARGETS');
    }

    // Verify session ownership
    const { pool } = require('../config/database');
    const placeholders = sessionIds.map((_, i) => `$${i + 2}`).join(',');
    const sessionResult = await pool.query(
      `SELECT id, user_id, status, is_logged_in, phone FROM sessions WHERE id IN (${placeholders}) AND user_id = $1`,
      [userId, ...sessionIds]
    );

    if (sessionResult.rows.length === 0) {
      throw new AppError('No valid sessions found for this user', 404, 'SESSION_NOT_FOUND');
    }

    const verifiedSessions = sessionResult.rows;
    const tgService = telegramService;

    const results = [];
    let joinedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    // Process each session for each target
    for (const session of verifiedSessions) {
      for (const targetId of targetIds) {
        const result = {
          sessionId: session.id,
          targetId,
          success: false,
        };

        try {
          const joinResult = await tgService.joinChannel(session.id, targetId);
          result.success = joinResult.success;
          result.targetName = joinResult.targetName;
          if (joinResult.skipped) {
            result.skipped = true;
            result.reason = joinResult.reason;
            skippedCount++;
          } else {
            joinedCount++;
          }
        } catch (err) {
          result.error = err.message;
          failedCount++;
        }

        results.push(result);

        // Small delay between joins to avoid flood
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Log operation
    await reportService.logActivity(
      userId,
      'group_join',
      'group_operation',
      null,
      {
        type: 'join',
        targetIds,
        sessionIds: verifiedSessions.map(s => s.id),
        joinedCount,
        failedCount,
        skippedCount,
      }
    );

    logger.info(`Join operation complete for user ${userId}`, {
      joined: joinedCount,
      failed: failedCount,
      skipped: skippedCount,
    });

    return res.status(200).json({
      success: true,
      data: {
        total: results.length,
        joined: joinedCount,
        failed: failedCount,
        skipped: skippedCount,
        results,
      },
    });
  }),

  /**
   * Remove multiple sessions from multiple groups/channels.
   */
  leaveChannels: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { sessionIds: rawSessionIds, targetIds, targetType = 'group' } = req.body;

    const sessionIds = await resolveSessionIdsFromRequest(req, rawSessionIds || []);
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError(
        'sessionIds array (or a non-empty sessionListId) is required',
        400,
        'MISSING_SESSIONS'
      );
    }

    if (!targetIds || !Array.isArray(targetIds) || targetIds.length === 0) {
      throw new AppError('targetIds array is required', 400, 'MISSING_TARGETS');
    }

    // Verify session ownership
    const { pool } = require('../config/database');
    const placeholders = sessionIds.map((_, i) => `$${i + 2}`).join(',');
    const sessionResult = await pool.query(
      `SELECT id, user_id, status, is_logged_in, phone FROM sessions WHERE id IN (${placeholders}) AND user_id = $1`,
      [userId, ...sessionIds]
    );

    if (sessionResult.rows.length === 0) {
      throw new AppError('No valid sessions found for this user', 404, 'SESSION_NOT_FOUND');
    }

    const verifiedSessions = sessionResult.rows;
    const tgService = telegramService;

    const results = [];
    let leftCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    // Process each session for each target
    for (const session of verifiedSessions) {
      for (const targetId of targetIds) {
        const result = {
          sessionId: session.id,
          targetId,
          success: false,
        };

        try {
          const leaveResult = await tgService.leaveChannel(session.id, targetId);
          result.success = leaveResult.success;
          if (leaveResult.skipped) {
            result.skipped = true;
            result.reason = leaveResult.reason;
            skippedCount++;
          } else {
            leftCount++;
          }
        } catch (err) {
          result.error = err.message;
          failedCount++;
        }

        results.push(result);

        // Small delay between leaves to avoid flood
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Log operation
    await reportService.logActivity(
      userId,
      'group_leave',
      'group_operation',
      null,
      {
        type: 'leave',
        targetIds,
        sessionIds: verifiedSessions.map(s => s.id),
        leftCount,
        failedCount,
        skippedCount,
      }
    );

    logger.info(`Leave operation complete for user ${userId}`, {
      left: leftCount,
      failed: failedCount,
      skipped: skippedCount,
    });

    return res.status(200).json({
      success: true,
      data: {
        total: results.length,
        left: leftCount,
        failed: failedCount,
        skipped: skippedCount,
        results,
      },
    });
  }),

  /**
   * Remove a member from a group.
   */
  removeMember: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const groupId = req.params.id;
    const { sessionId, userId: targetUserId, async } = req.body;

    if (!sessionId) {
      throw new AppError('sessionId is required', 400, 'MISSING_SESSION_ID');
    }

    if (!groupId) {
      throw new AppError('Group ID is required', 400, 'MISSING_GROUP_ID');
    }

    if (!targetUserId) {
      throw new AppError('userId is required in request body', 400, 'MISSING_TARGET_USER_ID');
    }

    if (async === 'true' || async === true) {
      const queueJob = await groupQueue.addJob({
        type: 'remove-member',
        sessionId,
        groupId: String(groupId),
        userIdTarget: String(targetUserId),
        userId,
      });

      return res.status(202).json({
        success: true,
        data: { queueJobId: queueJob.id, status: 'queued', groupId: String(groupId), targetUserId: String(targetUserId) },
      });
    }

    const result = await groupService.removeMember(sessionId, groupId, targetUserId, userId);

    await reportService.logActivity(
      userId,
      'group_remove_member',
      'group_operation',
      null,
      { type: 'remove_member', groupId: String(groupId), targetUserId: String(targetUserId), sessionId }
    );

    logger.info(`Member ${targetUserId} removed from group ${groupId} by user ${userId}`, { groupId, targetUserId });

    return res.status(200).json({ success: true, data: result });
  }),
};

module.exports = groupController;
