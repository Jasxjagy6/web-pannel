const { pool } = require('../config/database');
const telegramService = require('./telegramService');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const { redisClient } = require('../config/redis');

/**
 * Default delay in milliseconds between batch operations.
 */
const DEFAULT_DELAY_MS = 3000;

/**
 * Default batch size for adding members.
 */
const DEFAULT_BATCH_SIZE = 10;

/**
 * Maximum number of flood retries before giving up on a single user.
 */
const MAX_FLOOD_RETRIES = 5;

/**
 * TTL in seconds for Redis progress keys (1 hour).
 */
const PROGRESS_TTL = 3600;

/**
 * TTL in seconds for Redis cancel tokens (1 hour).
 */
const CANCEL_TTL = 3600;

/**
 * Utility to extract flood wait seconds from a Telegram error message.
 */
function extractFloodSeconds(errorMessage) {
  if (!errorMessage) return 30;
  const match = errorMessage.match(/FLOOD_WAIT_(\d+)/i) || errorMessage.match(/wait of (\d+) seconds/i);
  if (match) return parseInt(match[1], 10);
  const simpleMatch = errorMessage.match(/(\d+) seconds/i);
  if (simpleMatch) return parseInt(simpleMatch[1], 10);
  return 30;
}

/**
 * Utility to sleep for a given number of milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check whether an operation has been cancelled via Redis.
 */
async function isCancelled(opId) {
  try {
    if (!redisClient.isReady) return false;
    const val = await redisClient.get(`group:cancel:${opId}`);
    return val === '1';
  } catch {
    return false;
  }
}

/**
 * Update the progress record in Redis for an operation.
 */
async function updateProgress(opId, progressData) {
  try {
    if (!redisClient.isReady) return;
    const key = `group:add_progress:${opId}`;
    await redisClient.set(key, JSON.stringify(progressData), { EX: PROGRESS_TTL });
  } catch (err) {
    logger.error(`Failed to update Redis progress for op ${opId}`, { error: err.message });
  }
}

/**
 * Validate that the given sessions belong to the specified user.
 * Returns array of verified session objects.
 */
async function validateSessionsOwnership(sessionIds, userId) {
  if (!sessionIds || sessionIds.length === 0) {
    throw new AppError('At least one session ID is required', 400, 'NO_SESSIONS');
  }

  const placeholders = sessionIds.map((_, i) => `$${i + 2}`).join(',');
  const result = await pool.query(
    `SELECT id, user_id, status, is_logged_in, phone
     FROM sessions WHERE id IN (${placeholders}) AND user_id = $1`,
    [userId, ...sessionIds]
  );

  if (result.rows.length === 0) {
    throw new AppError('No valid sessions found for this user', 404, 'SESSION_NOT_FOUND');
  }

  const notFound = sessionIds.filter(sid => !result.rows.find(r => r.id === sid));
  if (notFound.length > 0) {
    logger.warn(`Some sessions not found for user ${userId}`, { notFound });
  }

  return result.rows;
}

class GroupService {
  // =========================================================================
  // Add Members to Groups/Channels (Multi-Session, Multi-Target)
  // =========================================================================

  /**
   * Add scraped members to target groups/channels using multiple sessions.
   *
   * Features:
   * - Multi-session round-robin distribution
   * - Multi-group/channel targeting
   * - Session membership verification
   * - Privacy settings handling (skip users who can't be added)
   * - Flood wait handling with retries
   * - Cancellation support
   *
   * @param {object} params
   * @param {number[]} params.sessionIds - Array of session IDs to use
   * @param {string[]} params.targetIds - Array of target group/channel IDs
   * @param {string} params.targetType - 'group' or 'channel'
   * @param {Array} params.userList - Users to add (with telegram_id, username, etc.)
   * @param {number} params.delayMin - Min delay between batches (seconds)
   * @param {number} params.delayMax - Max delay between batches (seconds)
   * @param {number} params.batchSize - Users per session per batch
   * @param {number} userId - User who owns the sessions
   * @returns {Promise<{opId, total, added, failed, skipped, results}>}
   */
  async addMembersToGroups(params, userId) {
    const {
      sessionIds,
      targetIds,
      targetType = 'group',
      userList,
      delayMin = 30,
      delayMax = 60,
      batchSize = 5,
    } = params;

    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!userList || userList.length === 0) {
      throw new AppError('No users provided for adding', 400, 'EMPTY_USER_LIST');
    }

    if (!targetIds || targetIds.length === 0) {
      throw new AppError('At least one target group/channel is required', 400, 'NO_TARGETS');
    }

    // Verify session ownership
    const verifiedSessions = await validateSessionsOwnership(sessionIds, userId);
    if (verifiedSessions.length === 0) {
      throw new AppError('No valid sessions found', 404, 'NO_VALID_SESSIONS');
    }

    logger.info(`Starting add members operation: ${userList.length} users to ${targetIds.length} target(s) using ${verifiedSessions.length} session(s)`, {
      userId, sessionCount: verifiedSessions.length, targetCount: targetIds.length, userType: userList.length,
    });

    // Create the operation record
    const opResult = await pool.query(
      `INSERT INTO group_operations (
        user_id, session_id, target_group_id, operation, operation_type,
        total_count, total_users, status, user_list, options, created_at
      ) VALUES ($1, $2, $3, 'add_members', 'add_members', $4, $5, 'running', $6, $7, NOW())
      RETURNING id`,
      [
        userId,
        verifiedSessions[0].id, // primary session
        targetIds[0], // primary target
        userList.length,
        userList.length,
        JSON.stringify(userList.slice(0, 100)), // store first 100 for reference
        JSON.stringify({
          sessionIds: verifiedSessions.map(s => s.id),
          targetIds,
          targetType,
          delayMin,
          delayMax,
          batchSize,
        }),
      ]
    );

    const opId = opResult.rows[0].id;

    // Initialise Redis progress
    await updateProgress(opId, {
      operation_id: opId,
      progress: 0,
      added: 0,
      failed: 0,
      skipped: 0,
      total: userList.length,
      status: 'running',
    });

    const results = [];
    let addedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    const tgService = telegramService;

    try {
      // Step 1: Verify session membership in targets
      // For each target, check if at least one session is a member
      const sessionMemberships = {}; // sessionId -> {targetId: isMember}
      
      for (const targetId of targetIds) {
        for (const session of verifiedSessions) {
          const key = `${session.id}:${targetId}`;
          try {
            const entity = await tgService._resolveEntity(session.id, targetId);
            sessionMemberships[key] = !!entity;
            logger.info(`Session ${session.id} ${entity ? 'IS' : 'is NOT'} member of ${targetId}`, { sessionId: session.id, targetId });
          } catch (err) {
            sessionMemberships[key] = false;
            logger.warn(`Session ${session.id} cannot access ${targetId}: ${err.message}`);
          }
        }

        // Check if at least one session is a member of this target
        const anyMember = verifiedSessions.some(s => sessionMemberships[`${s.id}:${targetId}`]);
        if (!anyMember) {
          logger.warn(`No session is a member of ${targetId}. Attempting to add sessions first.`);
          // Note: We can't programmatically add sessions to groups without admin rights
          // The user must ensure at least one session is in the target
        }
      }

      // Step 2: Build round-robin distribution plan
      // Distribute users across sessions: session1 gets users[0,3,6...], session2 gets [1,4,7...], etc.
      const sessionChunks = {}; // sessionId -> [user1, user2, ...]
      for (let i = 0; i < verifiedSessions.length; i++) {
        sessionChunks[verifiedSessions[i].id] = [];
      }
      
      for (let i = 0; i < userList.length; i++) {
        const sessionIdx = i % verifiedSessions.length;
        sessionChunks[verifiedSessions[sessionIdx].id].push(userList[i]);
      }

      // Step 3: Process each target
      for (let tIdx = 0; tIdx < targetIds.length; tIdx++) {
        const targetId = targetIds[tIdx];
        
        // Find sessions that are members of this target
        const availableSessions = verifiedSessions.filter(s => sessionMemberships[`${s.id}:${targetId}`]);
        
        if (availableSessions.length === 0) {
          logger.error(`No available sessions for target ${targetId}, skipping`);
          // Mark all users as failed for this target
          for (const user of userList) {
            results.push({
              userId: String(user.telegram_id || user.id || 'unknown'),
              targetId,
              success: false,
              error: 'No session is a member of this target',
              skipped: true,
            });
            skippedCount++;
          }
          continue;
        }

        // Re-distribute users among available sessions for this target
        const targetSessionChunks = {};
        for (const s of availableSessions) {
          targetSessionChunks[s.id] = [];
        }
        for (let i = 0; i < userList.length; i++) {
          const sIdx = i % availableSessions.length;
          targetSessionChunks[availableSessions[sIdx].id].push(userList[i]);
        }

        // Step 4: Process each session's chunk for this target
        for (const session of availableSessions) {
          const usersChunk = targetSessionChunks[session.id];
          if (!usersChunk || usersChunk.length === 0) continue;

          // Process in batches
          for (let b = 0; b < usersChunk.length; b += batchSize) {
            // Check cancellation
            if (await isCancelled(opId)) {
              logger.info(`Operation ${opId} cancelled at target ${targetId}, session ${session.id}, batch ${b}`);
              await updateProgress(opId, { status: 'cancelled' });
              await this._finalizeOperation(opId, 'cancelled', addedCount, failedCount, skippedCount, results);
              return { opId, total: userList.length, added: addedCount, failed: failedCount, skipped: skippedCount, results };
            }

            const batch = usersChunk.slice(b, b + batchSize);
            
            for (const userEntry of batch) {
              const userTelegramId = userEntry.telegram_id || userEntry.id;
              const userResult = {
                userId: String(userTelegramId || 'unknown'),
                targetId,
                sessionId: session.id,
                success: false,
              };

              try {
                // Try to add the user
                await tgService.addMemberToGroup(session.id, targetId, userTelegramId);
                userResult.success = true;
                addedCount++;
              } catch (addErr) {
                const errMsg = addErr.message || String(addErr);

                // Handle FLOOD_WAIT
                if (errMsg.includes('FLOOD_WAIT') || errMsg.includes('PEER_FLOOD')) {
                  const floodSeconds = extractFloodSeconds(errMsg);
                  logger.warn(`FLOOD_WAIT: waiting ${floodSeconds}s`, { opId, sessionId: session.id });
                  await sleep(floodSeconds * 1000);

                  // Retry once after flood wait
                  let retrySuccess = false;
                  let retryAttempts = 0;
                  while (!retrySuccess && retryAttempts < MAX_FLOOD_RETRIES) {
                    try {
                      await tgService.addMemberToGroup(session.id, targetId, userTelegramId);
                      retrySuccess = true;
                      userResult.success = true;
                      addedCount++;
                    } catch (retryErr) {
                      retryAttempts++;
                      const retryMsg = retryErr.message || String(retryErr);
                      if (retryMsg.includes('FLOOD_WAIT')) {
                        await sleep(extractFloodSeconds(retryMsg) * 1000);
                      } else {
                        userResult.error = retryMsg;
                        break;
                      }
                    }
                  }
                  if (!retrySuccess && !userResult.success) {
                    userResult.error = userResult.error || 'Failed after flood wait retries';
                  }
                }
                // Handle privacy restrictions - SKIP these users
                else if (
                  errMsg.includes('USER_PRIVACY_RESTRICT') ||
                  errMsg.includes('PRIVACY_RESTRICTED') ||
                  errMsg.includes('USER_NOT_MUTUAL_CONTACT') ||
                  errMsg.includes('USER_CHANNELS_TOO_MUCH')
                ) {
                  userResult.error = 'Privacy settings prevent adding';
                  userResult.skipped = true;
                  skippedCount++;
                }
                // Handle user already in group
                else if (
                  errMsg.includes('USER_ALREADY_PARTICIPANT') ||
                  errMsg.includes('USERS_TOO_MUCH')
                ) {
                  userResult.error = 'User already in target';
                  userResult.skipped = true;
                  skippedCount++;
                }
                // Handle admin required
                // Handle admin required or write forbidden
                else if (
                  errMsg.includes('CHAT_ADMIN_REQUIRED') ||
                  errMsg.includes('CHAT_WRITE_FORBIDDEN') ||
                  errMsg.includes('CHAT_ADMIN_REQUIRED')
                ) {
                  userResult.error = 'Session needs admin rights with "Add Members" permission in this target';
                  failedCount++;
                }
                // Handle user banned or restricted
                else if (errMsg.includes('USER_BANNED_IN_CHANNEL') || errMsg.includes('USER_RESTRICTED')) {
                  userResult.error = 'User is banned or restricted';
                  failedCount++;
                }
                // Generic failure
                else {
                  userResult.error = errMsg;
                  failedCount++;
                }
              }

              results.push(userResult);
            }

            // Update progress
            const processed = addedCount + failedCount + skippedCount;
            await updateProgress(opId, {
              progress: processed,
              added: addedCount,
              failed: failedCount,
              skipped: skippedCount,
              total: userList.length * targetIds.length,
              status: 'running',
              currentTarget: targetId,
              currentSession: session.id,
            });

            // Delay between batches (random between delayMin and delayMax)
            if (b + batchSize < usersChunk.length) {
              const delaySec = delayMin + Math.random() * (delayMax - delayMin);
              logger.info(`Waiting ${delaySec.toFixed(0)}s before next batch`);
              await sleep(delaySec * 1000);
            }
          }
        }
      }

      // Finalise
      const finalStatus = await isCancelled(opId) ? 'cancelled' : 'completed';
      await this._finalizeOperation(opId, finalStatus, addedCount, failedCount, skippedCount, results);

      logger.info(`Add members operation ${opId} finished: ${addedCount} added, ${failedCount} failed, ${skippedCount} skipped`, { opId });

      return {
        opId,
        total: userList.length,
        added: addedCount,
        failed: failedCount,
        skipped: skippedCount,
        results,
      };
    } catch (outerErr) {
      logger.error(`Fatal error in add members operation ${opId}`, { error: outerErr.message });
      await this._finalizeOperation(opId, 'failed', addedCount, failedCount, skippedCount, results);
      throw new AppError(`Operation failed: ${outerErr.message}`, 500, 'OPERATION_FAILED');
    }
  }

  // =========================================================================
  // Configure Group Spam / Settings
  // =========================================================================

  async configureGroupSpam(sessionId, groupId, settings, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!settings || Object.keys(settings).length === 0) {
      throw new AppError('No settings provided for configuration', 400, 'EMPTY_SETTINGS');
    }

    const sessions = await validateSessionsOwnership([sessionId], userId);

    const tgService = telegramService;

    try {
      const entity = await tgService._resolveEntity(sessionId, groupId);
      if (!entity) {
        throw new AppError(`Could not resolve group: ${groupId}`, 400, 'GROUP_NOT_FOUND');
      }

      const updates = [];

      if (
        settings.slowmode_seconds !== undefined ||
        settings.signatures !== undefined ||
        settings.scam !== undefined ||
        settings.fake !== undefined ||
        settings.forum !== undefined
      ) {
        const inputPeer = this._getInputPeer(entity);

        await tgService._withFloodRetry(sessionId, async () => {
          const { Api } = require('telegram/tl');
          return await tgService.clients.get(sessionId).client.invoke(
            new Api.channels.EditCreator({
              channel: inputPeer,
              slowmode: settings.slowmode_seconds !== undefined ? settings.slowmode_seconds : 0,
            })
          );
        });

        updates.push('slowmode');
      }

      if (settings.permissions) {
        const perm = settings.permissions;
        const rights = {};

        if (perm.sendMessages === false) rights.sendMessages = true;
        if (perm.sendMedia === false) rights.sendMedia = true;
        if (perm.sendStickers === false) rights.sendStickers = true;
        if (perm.sendGifs === false) rights.sendGifs = true;
        if (perm.sendGames === false) rights.sendGames = true;
        if (perm.sendInline === false) rights.sendInline = true;
        if (perm.embedLinks === false) rights.embedLinks = true;
        if (perm.sendPolls === false) rights.sendPolls = true;
        if (perm.changeInfo === false) rights.changeInfo = true;
        if (perm.inviteUsers === false) rights.inviteUsers = true;
        if (perm.pinMessages === false) rights.pinMessages = true;

        const { Api } = require('telegram/tl');

        const bannedRights = new Api.ChatBannedRights({
          untilDate: 0,
          viewMessages: false,
          sendMessages: rights.sendMessages || false,
          sendMedia: rights.sendMedia || false,
          sendStickers: rights.sendStickers || false,
          sendGifs: rights.sendGifs || false,
          sendGames: rights.sendGames || false,
          sendInline: rights.sendInline || false,
          embedLinks: rights.embedLinks || false,
          sendPolls: rights.sendPolls || false,
          changeInfo: rights.changeInfo || false,
          inviteUsers: rights.inviteUsers || false,
          pinMessages: rights.pinMessages || false,
        });

        const inputPeer = this._getInputPeer(entity);

        await tgService._withFloodRetry(sessionId, async () => {
          return await tgService.clients.get(sessionId).client.invoke(
            new Api.messages.EditChatDefaultBannedRights({
              peer: inputPeer,
              bannedRights: bannedRights,
            })
          );
        });

        updates.push('permissions');
      }

      if (settings.about !== undefined) {
        const { Api } = require('telegram/tl');
        const inputPeer = this._getInputPeer(entity);

        if (entity.className === 'Channel') {
          await tgService._withFloodRetry(sessionId, async () => {
            return await tgService.clients.get(sessionId).client.invoke(
              new Api.channels.EditAbout({
                channel: inputPeer,
                about: settings.about,
              })
            );
          });
        }

        updates.push('about');
      }

      logger.info(`Group ${groupId} configured by user ${userId}: ${updates.join(', ')}`, { sessionId });

      return { success: true, groupId: String(groupId), settings, appliedUpdates: updates };
    } catch (error) {
      logger.error(`Failed to configure group ${groupId}`, { sessionId, userId, error: error.message });
      if (error instanceof AppError) throw error;
      throw new AppError(`Failed to configure group: ${error.message}`, error.statusCode || 500, 'GROUP_CONFIG_FAILED');
    }
  }

  // =========================================================================
  // Auto-Manage Group
  // =========================================================================

  async autoManageGroup(groupId, rules, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!rules || Object.keys(rules).length === 0) {
      throw new AppError('No rules provided for auto-management', 400, 'EMPTY_RULES');
    }

    const sessionResult = await pool.query(
      'SELECT id FROM sessions WHERE user_id = $1 AND is_logged_in = true LIMIT 1',
      [userId]
    );

    if (sessionResult.rows.length === 0) {
      throw new AppError('No active sessions available for group management', 400, 'NO_ACTIVE_SESSION');
    }

    await pool.query(
      `INSERT INTO group_operations (
        user_id, session_id, target_group_id, operation, operation_type, status, options, created_at
      ) VALUES ($1, $2, $3, 'auto_manage', 'auto_manage', 'running', $4, NOW())
      RETURNING id`,
      [userId, sessionResult.rows[0].id, String(groupId), JSON.stringify(rules)]
    );

    logger.info(`Auto-management rules configured for group ${groupId} by user ${userId}`, { rules: Object.keys(rules) });

    return {
      success: true,
      groupId: String(groupId),
      rules,
      message: 'Auto-management rules have been configured',
    };
  }

  // =========================================================================
  // List Groups
  // =========================================================================

  async listGroups(sessionId, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    await validateSessionsOwnership([sessionId], userId);

    const tgService = telegramService;

    try {
      const result = await tgService.getGroups(sessionId);
      logger.info(`Listed ${result.total} groups for session ${sessionId}`, { userId });
      return result;
    } catch (error) {
      logger.error(`Failed to list groups for session ${sessionId}`, { userId, error: error.message });
      if (error instanceof AppError) throw error;
      throw new AppError(`Failed to list groups: ${error.message}`, error.statusCode || 500, 'LIST_GROUPS_FAILED');
    }
  }

  // =========================================================================
  // Get Group Info
  // =========================================================================

  async getGroupInfo(sessionId, groupId, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    await validateSessionsOwnership([sessionId], userId);

    const tgService = telegramService;

    try {
      const info = await tgService.getGroupInfo(sessionId, groupId);
      logger.info(`Retrieved group info for ${groupId}`, { sessionId, userId });
      return info;
    } catch (error) {
      logger.error(`Failed to get group info for ${groupId}`, { sessionId, userId, error: error.message });
      if (error instanceof AppError) throw error;
      throw new AppError(`Failed to get group info: ${error.message}`, error.statusCode || 500, 'GROUP_INFO_FAILED');
    }
  }

  // =========================================================================
  // Create Group
  // =========================================================================

  async createGroup(sessionId, title, members = [], userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      throw new AppError('Group title is required', 400, 'MISSING_TITLE');
    }

    await validateSessionsOwnership([sessionId], userId);

    const tgService = telegramService;

    try {
      const result = await tgService.createGroup(sessionId, title.trim(), members);

      await pool.query(
        `INSERT INTO group_operations (
          user_id, session_id, target_group_id, operation, operation_type, total_count, total_users,
          options, created_at
        ) VALUES ($1, $2, $3, 'create_group', 'create_group', $4, $5, $6, NOW())
        RETURNING id`,
        [userId, sessionId, String(result.id || ''), (members || []).length, (members || []).length, JSON.stringify({ title: title.trim() })]
      );

      logger.info(`Created group "${title}" for user ${userId}`, { sessionId, groupId: result.id });

      return {
        id: result.id,
        title: title.trim(),
        groupId: String(result.id || ''),
        membersAdded: result.membersAdded || 0,
        createdAt: result.createdAt || new Date().toISOString(),
        accessHash: result.accessHash || null,
        username: result.username || null,
      };
    } catch (error) {
      logger.error(`Failed to create group "${title}"`, { sessionId, userId, error: error.message });
      if (error instanceof AppError) throw error;
      throw new AppError(`Failed to create group: ${error.message}`, error.statusCode || 500, 'CREATE_GROUP_FAILED');
    }
  }

  // =========================================================================
  // Get Operation Details
  // =========================================================================

  async getOperationDetails(opId, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    const result = await pool.query(
      `SELECT id, user_id, session_id, target_group_id, operation, operation_type, status,
              total_users, total_count, success_count, failed_count, options, user_list,
              created_at, completed_at
       FROM group_operations
       WHERE id = $1 AND user_id = $2`,
      [opId, userId]
    );

    if (result.rows.length === 0) {
      throw new AppError('Operation not found or access denied', 404, 'OPERATION_NOT_FOUND');
    }

    const row = result.rows[0];

    let redisProgress = null;
    try {
      if (redisClient.isReady) {
        const progressKey = `group:add_progress:${opId}`;
        const progressData = await redisClient.get(progressKey);
        if (progressData) {
          redisProgress = JSON.parse(progressData);
        }
      }
    } catch {
      // Skip
    }

    let options = null;
    try {
      options = typeof row.options === 'string' ? JSON.parse(row.options) : row.options;
    } catch {
      options = row.options;
    }

    return {
      id: row.id,
      operationType: row.operation_type || row.operation,
      groupId: row.target_group_id || row.group_id,
      status: row.status,
      totalUsers: row.total_users || row.total_count || 0,
      successCount: row.success_count || 0,
      failedCount: row.failed_count || 0,
      options,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      redisProgress,
    };
  }

  // =========================================================================
  // List Operations
  // =========================================================================

  async listOperations(userId, { page = 1, limit = 20, sort = 'created_at', order = 'DESC', filter } = {}) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    const validSortFields = ['created_at', 'completed_at', 'status', 'operation_type', 'operation', 'id'];
    const sortField = validSortFields.includes(sort) ? sort : 'created_at';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const offset = (page - 1) * limit;

    const queryConditions = ['user_id = $1'];
    const queryParams = [userId];
    let paramIndex = 2;

    if (filter && filter !== 'all') {
      queryConditions.push(`(operation_type = $${paramIndex} OR operation = $${paramIndex})`);
      queryParams.push(filter);
      paramIndex++;
    }

    const whereClause = queryConditions.join(' AND ');

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM group_operations WHERE ${whereClause}`,
      queryParams
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const opsResult = await pool.query(
      `SELECT id, user_id, session_id, target_group_id, operation, operation_type, status,
              total_users, total_count, success_count, failed_count, options,
              created_at, completed_at
       FROM group_operations
       WHERE ${whereClause}
       ORDER BY ${sortField} ${sortOrder}
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...queryParams, limit, offset]
    );

    const operations = opsResult.rows.map((row) => {
      let options = null;
      try {
        options = typeof row.options === 'string' ? JSON.parse(row.options) : row.options;
      } catch {
        options = row.options;
      }

      return {
        id: row.id,
        operationType: row.operation_type || row.operation,
        groupId: row.target_group_id,
        status: row.status,
        totalUsers: row.total_users || row.total_count || 0,
        successCount: row.success_count || 0,
        failedCount: row.failed_count || 0,
        options,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      };
    });

    const pagination = {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    };

    return { operations, pagination };
  }

  // =========================================================================
  // Remove Member
  // =========================================================================

  async removeMember(sessionId, groupId, userIdTarget, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!userIdTarget) {
      throw new AppError('Target user ID is required', 400, 'MISSING_TARGET_USER_ID');
    }

    await validateSessionsOwnership([sessionId], userId);

    const tgService = telegramService;

    try {
      const result = await tgService.removeMember(sessionId, groupId, userIdTarget);

      await pool.query(
        `INSERT INTO group_operations (
          user_id, session_id, target_group_id, operation, operation_type, total_count, total_users,
          success_count, failed_count, options, created_at, completed_at
        ) VALUES ($1, $2, $3, 'remove_member', 'remove_member', 1, 1, 1, 0, $4, NOW(), NOW())
        RETURNING id`,
        [userId, sessionId, String(groupId), JSON.stringify({ targetUserId: String(userIdTarget) })]
      );

      logger.info(`Removed user ${userIdTarget} from group ${groupId}`, { sessionId, userId });
      return result;
    } catch (error) {
      logger.error(`Failed to remove user ${userIdTarget} from group ${groupId}`, { sessionId, userId, error: error.message });

      try {
        await pool.query(
          `INSERT INTO group_operations (
            user_id, session_id, target_group_id, operation, operation_type, total_count, total_users,
            success_count, failed_count, options, created_at, completed_at
          ) VALUES ($1, $2, $3, 'remove_member', 'remove_member', 1, 1, 0, 1, $4, NOW(), NOW())
          RETURNING id`,
          [userId, sessionId, String(groupId), JSON.stringify({ targetUserId: String(userIdTarget), error: error.message })]
        );
      } catch {
        // Ignore DB logging failure
      }

      if (error instanceof AppError) throw error;
      throw new AppError(`Failed to remove member: ${error.message}`, error.statusCode || 500, 'REMOVE_MEMBER_FAILED');
    }
  }

  // =========================================================================
  // Cancel Operation
  // =========================================================================

  async cancelOperation(opId, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    const opResult = await pool.query(
      'SELECT id FROM group_operations WHERE id = $1 AND user_id = $2',
      [opId, userId]
    );

    if (opResult.rows.length === 0) {
      throw new AppError('Operation not found or access denied', 404, 'OPERATION_NOT_FOUND');
    }

    try {
      if (redisClient.isReady) {
        await redisClient.set(`group:cancel:${opId}`, '1', { EX: CANCEL_TTL });
      }
    } catch (err) {
      logger.error(`Failed to set cancel token for op ${opId}`, { error: err.message });
    }

    logger.info(`Cancel requested for operation ${opId} by user ${userId}`);

    return { success: true, opId: String(opId) };
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  async _finalizeOperation(opId, status, successCount, failedCount, skippedCount, results) {
    try {
      // Store detailed results in Redis
      try {
        if (redisClient.isReady) {
          const resultsKey = `group:results:${opId}`;
          const truncatedResults = results.length > 500 ? results.slice(-500) : results;
          await redisClient.set(resultsKey, JSON.stringify(truncatedResults), { EX: PROGRESS_TTL });
        }
      } catch {
        // Skip
      }

      await pool.query(
        `UPDATE group_operations SET
          status = $1,
          success_count = $2,
          failed_count = $3,
          completed_at = NOW()
         WHERE id = $4`,
        [status, successCount, failedCount, opId]
      );
    } catch (err) {
      logger.error(`Failed to finalise operation ${opId}`, { error: err.message });
    }
  }

  _getInputPeer(entity) {
    const { Api } = require('telegram/tl');

    if (entity.className === 'User') {
      return new Api.InputPeerUser({ userId: entity.id, accessHash: entity.accessHash });
    }
    if (entity.className === 'Chat') {
      return new Api.InputPeerChat({ chatId: entity.id });
    }
    if (entity.className === 'Channel') {
      return new Api.InputPeerChannel({ channelId: entity.id, accessHash: entity.accessHash });
    }
    return entity;
  }
}

module.exports = new GroupService();
