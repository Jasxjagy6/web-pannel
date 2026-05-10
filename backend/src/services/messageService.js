/**
 * MessageService - Handles single messages, bulk messaging, and smart
 * distribution of messages across multiple Telegram sessions.
 *
 * Includes a DistributionEngine for round-robin target splitting,
 * real-time progress tracking via Redis, retry logic, rate limiting,
 * and comprehensive message logging.
 */

const { pool } = require('../config/database');
const telegramService = require('./telegramService');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const { buildPagination, applyPagination, applySorting } = require('../utils/pagination');
const { redisClient } = require('../config/redis');
const distributionPlanner = require('./distributionPlanner');

// =========================================================================
// Constants
// =========================================================================

/**
 * Maximum batch size for database transaction inserts.
 */
const LOG_BATCH_SIZE = 200;

/**
 * Maximum number of retries when a message fails with a non-fatal error.
 */
const MAX_RETRIES = 2;

/**
 * Redis TTL for progress keys (24 hours in seconds).
 */
const PROGRESS_TTL = 86400;

/**
 * Default minimum delay between messages (ms).
 */
const DEFAULT_DELAY_MIN = 1000;

/**
 * Default maximum delay between messages (ms).
 */
const DEFAULT_DELAY_MAX = 3000;

/**
 * Default maximum targets per session when not specified.
 */
const DEFAULT_MESSAGES_PER_SESSION = 500;

/**
 * Valid job status values.
 */
const VALID_JOB_STATUSES = ['pending', 'running', 'completed', 'cancelled', 'failed'];

/**
 * Valid message log status values.
 */
const VALID_LOG_STATUSES = ['sent', 'failed', 'skipped'];

// =========================================================================
// Utility Helpers
// =========================================================================

/**
 * Sleep for the specified number of milliseconds.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a random integer between min and max (inclusive).
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number}
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Parse a JSON field, returning null on failure.
 * @param {*} value - The value to parse
 * @returns {object|null}
 */
function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * UUID-style placeholder used by the scraper for hidden / unresolved
 * users. These are never valid Telegram identifiers and must not be
 * forwarded to the MTProto layer.
 * @private
 */
const _UUID_LIKE_TARGET_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract an addressable identifier from a target object that may be a
 * plain value or an object with various id / handle field names.
 *
 * Numeric ids win, but we fall back to `@username` / phone so list
 * entries that only have a handle (e.g. hidden-user rows from scrape
 * exports) still reach `_resolveEntity` instead of being silently
 * dropped. UUID placeholders are explicitly skipped — the underlying
 * Telegram client treats `2617dd5b-...` as garbage and the row would
 * just fail later anyway.
 *
 * @param {string|number|object} target - The target identifier
 * @returns {string|null} Normalized target identifier or null
 */
function normalizeTargetId(target) {
  if (target === null || target === undefined) return null;

  if (typeof target === 'object') {
    const rawId =
      target.telegram_id ??
      target.telegramId ??
      target.id ??
      target.userId ??
      target.user_id ??
      target.target_id ??
      null;
    const idStr = rawId === null || rawId === undefined ? '' : String(rawId).trim();
    if (idStr && /^-?\d+$/.test(idStr)) {
      return idStr;
    }

    const rawUsername = target.username ?? target.user_name ?? target.handle ?? null;
    if (rawUsername) {
      const u = String(rawUsername).replace(/^@+/, '').trim();
      if (u && !_UUID_LIKE_TARGET_RE.test(u) && !/^\d+$/.test(u)) {
        return `@${u}`;
      }
    }

    const rawPhone = target.phone ?? target.phone_number ?? null;
    if (rawPhone) {
      const p = String(rawPhone).trim();
      if (/^\+?\d{5,15}$/.test(p)) {
        return p.startsWith('+') ? p : `+${p}`;
      }
    }

    return null;
  }

  const str = String(target).trim();
  if (!str) return null;
  if (_UUID_LIKE_TARGET_RE.test(str)) return null;
  return str;
}

/**
 * Check if a Telegram error is retryable.
 * @param {string} errorMessage - The error message
 * @returns {boolean}
 */
function isRetryableError(errorMessage) {
  if (!errorMessage) return false;
  const nonRetryablePatterns = [
    'SESSION_EXPIRED',
    'SESSION_REVOKED',
    'AUTH_KEY_UNREGISTERED',
    'USER_BANNED_IN_CHANNEL',
    'CHAT_WRITE_FORBIDDEN',
    'CHAT_ID_INVALID',
    'USER_ID_INVALID',
    'INPUT_USER_DEACTIVATED',
    'PEER_FLOOD',
  ];
  for (const pattern of nonRetryablePatterns) {
    if (errorMessage.includes(pattern)) return false;
  }
  return true;
}

/**
 * Check if an error indicates a fatal session problem that should
 * halt the entire job.
 * @param {string} errorMessage - The error message
 * @returns {boolean}
 */
function isFatalSessionError(errorMessage) {
  if (!errorMessage) return false;
  const fatalPatterns = [
    'SESSION_EXPIRED',
    'SESSION_REVOKED',
    'AUTH_KEY_UNREGISTERED',
  ];
  return fatalPatterns.some((p) => errorMessage.includes(p));
}

// =========================================================================
// Distribution Engine
// =========================================================================

class DistributionEngine {
  constructor() {
    /**
     * Per-session message counts for rate limiting tracking.
     * @type {Map<string, number>}
     */
    this._sessionCounts = new Map();
  }

  /**
   * Distribute a list of targets across available sessions using
   * round-robin assignment, optionally capped by messagesPerSession.
   *
   * @param {Array<string|number|object>} targetList - Array of targets to distribute
   * @param {Array<string|number>} availableSessions - Array of session IDs
   * @param {object} options - Distribution options
   * @param {number} options.messagesPerSession - Max targets per session (default: 500)
   * @returns {Map<string, Array<string>>} Map of sessionId -> array of target IDs
   */
  async distributeTargets(targetList, availableSessions, options = {}) {
    const { messagesPerSession = DEFAULT_MESSAGES_PER_SESSION } = options;

    if (!targetList || targetList.length === 0) {
      return new Map();
    }

    if (!availableSessions || availableSessions.length === 0) {
      throw new AppError('No available sessions for message distribution', 400, 'NO_SESSIONS');
    }

    const distribution = new Map();

    // Initialize empty arrays for each session
    for (const sessionId of availableSessions) {
      distribution.set(String(sessionId), []);
    }

    const sessionIds = availableSessions.map((s) => String(s));
    let sessionIndex = 0;
    let distributedCount = 0;

    // Round-robin distribution with per-session cap
    for (const target of targetList) {
      const targetId = normalizeTargetId(target);
      if (!targetId) continue;

      // Find the next session that hasn't hit its cap
      let assigned = false;
      let attempts = 0;

      while (attempts < sessionIds.length) {
        const currentSession = sessionIds[sessionIndex % sessionIds.length];
        const currentChunk = distribution.get(currentSession);

        if (currentChunk.length < messagesPerSession) {
          currentChunk.push(targetId);
          assigned = true;
          sessionIndex = (sessionIndex + 1) % sessionIds.length;
          distributedCount++;
          break;
        }

        sessionIndex = (sessionIndex + 1) % sessionIds.length;
        attempts++;
      }

      if (!assigned) {
        // All sessions are at capacity; assign to the least-loaded session
        let minSession = sessionIds[0];
        let minCount = Infinity;
        for (const sid of sessionIds) {
          const chunk = distribution.get(sid);
          if (chunk.length < minCount) {
            minCount = chunk.length;
            minSession = sid;
          }
        }
        distribution.get(minSession).push(targetId);
        distributedCount++;
      }
    }

    // Remove sessions that received no targets
    for (const [sessionId, chunk] of distribution) {
      if (chunk.length === 0) {
        distribution.delete(sessionId);
      }
    }

    logger.info(`Distributed ${distributedCount} targets across ${distribution.size} sessions`, {
      sessionCounts: Object.fromEntries(
        [...distribution].map(([sid, chunk]) => [sid, chunk.length])
      ),
    });

    return distribution;
  }

  /**
   * Execute a distributed messaging job, processing each session's chunk
   * sequentially with progress tracking, retries, and cancellation support.
   *
   * @param {object} job - The messaging job record from the database
   * @param {Map<string, string[]>} sessionMap - Map of sessionId -> target IDs
   * @param {object} options - Execution options
   * @param {number} options.delayMin - Min delay between messages (ms)
   * @param {number} options.delayMax - Max delay between messages (ms)
   * @param {string} options.messageType - Type of message (text, media, etc.)
   * @param {string} options.mediaPath - Path to media file (if applicable)
   * @param {object} options.messageOptions - Additional send options
   * @returns {Promise<{ sent: number, failed: number, skipped: number }>}
   */
  async executeDistributedJob(job, sessionMap, options = {}) {
    const {
      delayMin = DEFAULT_DELAY_MIN,
      delayMax = DEFAULT_DELAY_MAX,
      messageType = 'text',
      mediaPath = null,
      messageOptions = {},
      // Rotation/cooldown distribution plan. When omitted the job
      // processes each session's chunk sequentially (legacy
      // behaviour). When provided, the runner switches to a rotation
      // loop: each round every session sends `perSessionBurst`
      // messages, then everyone cools down for cooldownSec.
      plan = null,
    } = options;

    const jobId = job.id;
    const messageContent = job.message_content;
    const totalTargets = job.total_count;

    let totalSent = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    // Buffer for batch logging
    let logBuffer = [];

    /**
     * Flush the log buffer to the database in a transaction.
     */
    const flushLogBuffer = async () => {
      if (logBuffer.length === 0) return;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        for (const log of logBuffer) {
          await client.query(
            `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [jobId, log.sessionId, log.targetId, log.status, log.errorMessage || null]
          );
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error(`Failed to flush message log buffer for job ${jobId}`, {
          error: error.message,
          bufferSize: logBuffer.length,
        });
      } finally {
        client.release();
      }

      logBuffer = [];
    };

    /**
     * Add a log entry to the buffer, flushing if full.
     */
    const addLog = async (sessionId, targetId, status, errorMessage = null) => {
      logBuffer.push({ sessionId, targetId, status, errorMessage });

      if (logBuffer.length >= LOG_BATCH_SIZE) {
        await flushLogBuffer();
      }
    };

    /**
     * Update the progress in Redis for real-time UI updates.
     */
    const updateProgress = async (status) => {
      const progressData = {
        progress: totalTargets > 0 ? Math.round(((totalSent + totalFailed + totalSkipped) / totalTargets) * 100) : 0,
        sent: totalSent,
        failed: totalFailed,
        skipped: totalSkipped,
        status,
        total: totalTargets,
        updatedAt: new Date().toISOString(),
      };

      try {
        if (redisClient && redisClient.isReady) {
          await redisClient.set(
            `message:progress:${jobId}`,
            JSON.stringify(progressData),
            { EX: PROGRESS_TTL }
          );
        }
      } catch (redisError) {
        logger.warn(`Failed to update Redis progress for job ${jobId}`, {
          error: redisError.message,
        });
      }
    };

    /**
     * Check if the job has been cancelled.
     * @returns {Promise<boolean>}
     */
    const isCancelled = async () => {
      try {
        if (redisClient && redisClient.isReady) {
          const cancelKey = `message:cancel:${jobId}`;
          const val = await redisClient.get(cancelKey);
          if (val === '1') return true;
        }

        // Also check the database as a fallback
        const result = await pool.query(
          'SELECT status FROM messaging_jobs WHERE id = $1',
          [jobId]
        );
        if (result.rows.length > 0 && result.rows[0].status === 'cancelled') {
          return true;
        }
      } catch {
        // If we can't check, assume not cancelled
      }
      return false;
    };

    // Track which sessions have hit a hard rate-limit / fatal error so
    // we can skip them in subsequent rounds (rotation mode).
    const deadSessions = new Set();

    /**
     * Send a single target with retry/fallback. Updates counters,
     * adds log entries, and respects cancellation. Returns true on
     * success.
     */
    const processOneTarget = async (sessionId, targetId) => {
      let success = false;
      let lastError = null;
      let usedSessionId = sessionId;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          // On retry, try a different (live) session if available.
          if (attempt > 0) {
            const otherSessions = [...sessionMap.keys()].filter(
              (s) => s !== usedSessionId && !deadSessions.has(s)
            );
            if (otherSessions.length > 0) {
              usedSessionId = otherSessions[
                Math.floor(Math.random() * otherSessions.length)
              ];
              logger.info(
                `Retry ${attempt}: switching to session ${usedSessionId} for target ${targetId}`
              );
            }
          }

          if (messageType === 'text' || messageType === 'markdown') {
            await telegramService.sendMessage(
              usedSessionId,
              targetId,
              messageContent,
              messageOptions
            );
          } else if (messageType === 'forward') {
            const forwardOpts = parseJson(messageContent);
            const sourceId = forwardOpts?.sourceId || forwardOpts?.source_id || '';
            const msgId = forwardOpts?.messageId || forwardOpts?.message_id || 0;
            await telegramService.forwardMessage(
              usedSessionId,
              targetId,
              parseInt(msgId, 10),
              sourceId
            );
          } else {
            await telegramService.sendMessage(
              usedSessionId,
              targetId,
              messageContent,
              messageOptions
            );
          }

          success = true;
          break;
        } catch (sendError) {
          lastError = sendError.message || String(sendError);

          if (isFatalSessionError(lastError)) {
            logger.error(`Fatal error on session ${usedSessionId}: ${lastError}`);
            deadSessions.add(usedSessionId);
            break;
          }

          // PEER_FLOOD on a session in rotation mode: retire that
          // session for the rest of the run (subsequent rounds will
          // skip it). Other retries can still pick a different one.
          if (lastError.includes('PEER_FLOOD')) {
            deadSessions.add(usedSessionId);
          }

          if (!isRetryableError(lastError)) {
            break;
          }

          if (attempt < MAX_RETRIES) {
            const backoffMs = Math.min(
              delayMin * Math.pow(2, attempt) + randomInt(0, 500),
              30000
            );
            logger.warn(
              `Retry ${attempt + 1}/${MAX_RETRIES} for target ${targetId} after ${backoffMs}ms: ${lastError}`
            );
            await sleep(backoffMs);
          }
        }
      }

      if (success) {
        totalSent++;
        await addLog(usedSessionId, targetId, 'sent');
      } else {
        totalFailed++;
        await addLog(sessionId, targetId, 'failed', lastError);
      }

      if ((totalSent + totalFailed + totalSkipped) % 50 === 0) {
        await updateProgress('running');
      }

      return success;
    };

    if (plan && plan.perSessionBurst > 0) {
      // ROTATION MODE
      //
      // Build per-session queues from sessionMap, then loop:
      //   for round in 0..rounds:
      //     for each session: send up to `perSessionBurst` messages
      //       (per-item delay sampled from itemDelayMs range)
      //     sleep cooldownSec
      //
      // This is the institutional pattern: spread load across
      // sessions evenly, then pause every rotation so no single
      // account exceeds Telegram's per-action limits.
      const sessionIds = [...sessionMap.keys()];
      const queues = sessionIds.map((sid) => sessionMap.get(sid).slice());
      const burst = plan.perSessionBurst;
      const maxQueueLen = queues.reduce((m, q) => Math.max(m, q.length), 0);
      const totalRounds = Math.max(1, Math.ceil(maxQueueLen / burst));

      // Honour caller-supplied delay/cooldown over the plan's defaults
      // when the caller passed explicit values via options. The
      // controller already merges them into the plan, but this keeps
      // the runner robust to stale callers.
      const itemMin = plan.itemDelayMsMin ?? delayMin;
      const itemMax = plan.itemDelayMsMax ?? delayMax;
      const cdMin = plan.cooldownSecMin ?? 0;
      const cdMax = plan.cooldownSecMax ?? 0;

      for (let round = 0; round < totalRounds; round++) {
        if (await isCancelled()) {
          await updateProgress('cancelled');
          break;
        }

        for (let sIdx = 0; sIdx < sessionIds.length; sIdx++) {
          const sid = sessionIds[sIdx];
          if (deadSessions.has(sid)) continue;

          const queue = queues[sIdx];
          const burstSlice = queue.splice(0, burst);
          if (burstSlice.length === 0) continue;

          for (let i = 0; i < burstSlice.length; i++) {
            if (await isCancelled()) {
              for (let j = i; j < burstSlice.length; j++) {
                await addLog(sid, burstSlice[j], 'skipped', 'Job was cancelled');
                totalSkipped++;
              }
              for (let r = sIdx + 1; r < sessionIds.length; r++) {
                for (const t of queues[r]) {
                  await addLog(sessionIds[r], t, 'skipped', 'Job was cancelled');
                  totalSkipped++;
                }
                queues[r] = [];
              }
              await updateProgress('cancelled');
              return { sent: totalSent, failed: totalFailed, skipped: totalSkipped };
            }

            const success = await processOneTarget(sid, burstSlice[i]);

            // Per-item delay between sends within the same burst.
            if (i < burstSlice.length - 1 && itemMax > 0) {
              const d = itemMin + Math.random() * (itemMax - itemMin);
              await sleep(d);
            }
            if (deadSessions.has(sid)) {
              // Push back any remaining items so the rotation can
              // re-route them via retries on the next round.
              for (let j = i + 1; j < burstSlice.length; j++) {
                queue.unshift(burstSlice[j]);
              }
              break;
            }
            // Mark unused successful target counter for diagnostics.
            void success;
          }

          await updateProgress('running');
        }

        const liveQueueRemaining = queues.some((q) => q.length > 0);
        const liveSessions = sessionIds.filter((s) => !deadSessions.has(s)).length;
        if (round < totalRounds - 1 && liveQueueRemaining && liveSessions > 0 && cdMax > 0) {
          const cooldownSec = cdMin + Math.random() * (cdMax - cdMin);
          logger.info(
            `Cooldown between rotations: ${cooldownSec.toFixed(0)}s (round ${round + 1}/${totalRounds})`,
            { jobId }
          );
          await updateProgress('cooldown');
          await sleep(cooldownSec * 1000);
        }
      }
    } else {
      // LEGACY MODE — process each session's chunk sequentially.
      const sessions = [...sessionMap.entries()];

      for (const [sessionId, targets] of sessions) {
        if (await isCancelled()) {
          totalSkipped += targets.length;
          for (const targetId of targets) {
            await addLog(sessionId, targetId, 'skipped', 'Job was cancelled');
          }
          await updateProgress('cancelled');
          break;
        }

        let sessionSent = 0;
        let sessionFailed = 0;
        const sessionSkipped = 0;

        for (const targetId of targets) {
          if (await isCancelled()) {
            totalSkipped += 1 + targets.slice(targets.indexOf(targetId) + 1).length;
            await addLog(sessionId, targetId, 'skipped', 'Job was cancelled');
            for (const remainingTarget of targets.slice(targets.indexOf(targetId) + 1)) {
              await addLog(sessionId, remainingTarget, 'skipped', 'Job was cancelled');
            }
            await updateProgress('cancelled');
            break;
          }

          const before = totalSent;
          const success = await processOneTarget(sessionId, targetId);
          if (success) {
            sessionSent++;
          } else {
            sessionFailed++;
          }
          // (kept here so the existing log message reads well)
          void before;

          if (success) {
            const delay = randomInt(delayMin, delayMax);
            await sleep(delay);
          }
        }

        logger.info(
          `Session ${sessionId} chunk complete: ${sessionSent} sent, ${sessionFailed} failed, ${sessionSkipped} skipped`
        );
      }
    }

    // Flush any remaining logs
    await flushLogBuffer();

    // Final progress update
    await updateProgress('completed');

    // Update the job record in the database
    await pool.query(
      `UPDATE messaging_jobs SET
         status = $1,
         sent_count = $2,
         failed_count = $3,
         skipped_count = $4,
         completed_at = NOW()
       WHERE id = $5`,
      ['completed', totalSent, totalFailed, totalSkipped, jobId]
    );

    logger.info(`Distributed job ${jobId} completed: ${totalSent} sent, ${totalFailed} failed, ${totalSkipped} skipped`);

    return { sent: totalSent, failed: totalFailed, skipped: totalSkipped };
  }

  /**
   * Rate limiter: enforce a random delay between delayMin and delayMax
   * to prevent account bans. Also tracks per-session message counts.
   *
   * @param {string} sessionId - The session identifier
   * @param {number} delayMin - Minimum delay in milliseconds (default: 1000)
   * @param {number} delayMax - Maximum delay in milliseconds (default: 3000)
   * @returns {Promise<{ delay: number, sessionCount: number }>}
   */
  async rateLimiter(sessionId, delayMin = DEFAULT_DELAY_MIN, delayMax = DEFAULT_DELAY_MAX) {
    const currentCount = this._sessionCounts.get(sessionId) || 0;
    const newCount = currentCount + 1;
    this._sessionCounts.set(sessionId, newCount);

    // Calculate delay with adaptive scaling:
    // As session message count increases, increase the delay range slightly
    // to provide natural-looking behavior
    const scaleFactor = Math.min(1 + Math.floor(newCount / 50) * 0.2, 3);
    const adjustedMin = Math.round(delayMin * scaleFactor);
    const adjustedMax = Math.round(delayMax * scaleFactor);

    const delay = randomInt(adjustedMin, adjustedMax);
    await sleep(delay);

    return { delay, sessionCount: newCount };
  }

  /**
   * Reset the session count tracker for a given session.
   * @param {string} sessionId
   */
  resetSessionCount(sessionId) {
    this._sessionCounts.delete(sessionId);
  }

  /**
   * Get the current message count for a session.
   * @param {string} sessionId
   * @returns {number}
   */
  getSessionCount(sessionId) {
    return this._sessionCounts.get(sessionId) || 0;
  }
}

// =========================================================================
// Message Service
// =========================================================================

class MessageService {
  constructor() {
    /**
     * The distribution engine for splitting and executing bulk jobs.
     * @type {DistributionEngine}
     */
    this.distributionEngine = new DistributionEngine();
  }

  // =========================================================================
  // Single Message Operations
  // =========================================================================

  /**
   * Send a single message to a target and log the result.
   *
   * @param {string|number} sessionId - Session database ID
   * @param {string|number} targetId - Target user/group/channel ID
   * @param {string} message - Message content
   * @param {object} options - Send options (silent, noWebpage, replyTo, etc.)
   * @param {number|string} userId - User ID for authorization
   * @returns {Promise<{ success: boolean, messageId: number|null, targetId: string, date: string }>}
   */
  async sendMessage(sessionId, targetId, message, options = {}, userId) {
    logger.info(`Sending single message`, { sessionId, targetId, userId });

    // Verify the session belongs to the user
    const session = await this._verifySessionOwnership(sessionId, userId);

    // Anti-revoke Phase 3 (B17): refuse to send from a high-risk
    // session. RISK_TOO_HIGH bubbles up as a 403 to the API client.
    try {
      const cfg = require('../config/telegram');
      if (cfg.ANTI_REVOKE_PHASE_3_ENABLED) {
        const tgRisk = require('../providers/telegram/riskScore');
        await tgRisk.gateOnRisk(sessionId);
      }
    } catch (gateErr) {
      if (gateErr && gateErr.code === 'RISK_TOO_HIGH') throw gateErr;
      // Fall through on unexpected errors so messaging stays available.
    }

    try {
      const result = await telegramService.sendMessage(
        String(sessionId),
        String(targetId),
        message,
        options
      );

      // Log the successful send
      await pool.query(
        `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
         VALUES (NULL, $1, $2, $3, NULL, NOW())`,
        [sessionId, String(targetId), 'sent']
      );

      return {
        success: true,
        messageId: result.messageId,
        targetId: String(targetId),
        date: result.date,
      };
    } catch (error) {
      const errorMessage = error.message || String(error);

      // Log the failure
      await pool.query(
        `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
         VALUES (NULL, $1, $2, $3, $4, NOW())`,
        [sessionId, String(targetId), 'failed', errorMessage]
      );

      logger.error(`Failed to send message to ${targetId}`, {
        sessionId,
        error: errorMessage,
      });

      return {
        success: false,
        messageId: null,
        targetId: String(targetId),
        error: errorMessage,
      };
    }
  }

  // =========================================================================
  // Bulk Message Operations
  // =========================================================================

  /**
   * Send bulk messages using the distribution engine to split targets
   * across multiple sessions.
   *
   * @param {object} params - Bulk messaging parameters
   * @param {Array<number|string>} params.sessionIds - Session IDs to use
   * @param {Array<string|number|object>} params.targetList - Targets to message
   * @param {string} params.message - Message content
   * @param {string} params.messageType - Type: text, markdown, forward
   * @param {string} params.mediaPath - Path to media file (optional)
   * @param {number} params.delayMin - Minimum delay between messages (ms)
   * @param {number} params.delayMax - Maximum delay between messages (ms)
   * @param {number} params.messagesPerSession - Max targets per session
   * @param {object} params.messageOptions - Additional send options
   * @param {number|string} userId - User ID for authorization
   * @returns {Promise<{
   *   jobId: number,
   *   status: string,
   *   totalTargets: number,
   *   sessionCount: number,
   *   distribution: object
   * }>}
   */
  async sendBulkMessage(params, userId) {
    const {
      sessionIds,
      message,
      messageType = 'text',
      mediaPath = null,
      delayMin = DEFAULT_DELAY_MIN,
      delayMax = DEFAULT_DELAY_MAX,
      messagesPerSession = DEFAULT_MESSAGES_PER_SESSION,
      messageOptions = {},
      sourceType = 'manual',
      sourceId = null,
      // Distribution-engine knobs. When `mode='auto'` the
      // distributionPlanner picks safe defaults for the
      // items / sessions ratio. When `mode='manual'` the operator's
      // values are used (clamped to safe bounds).
      mode = 'auto',
      perSessionBurst,
      cooldownSecMin,
      cooldownSecMax,
      itemDelayMsMin,
      itemDelayMsMax,
    } = params;
    // `targetList` is reassigned by the audience filter below, so it
    // can't be a const-binding from the destructure.
    let targetList = params.targetList;

    logger.info(`Starting bulk message job for user ${userId}`, {
      sessionCount: sessionIds ? sessionIds.length : 0,
      targetCount: targetList ? targetList.length : 0,
      messageType,
    });

    // Validate inputs
    if (!sessionIds || sessionIds.length === 0) {
      throw new AppError('At least one session ID is required', 400, 'NO_SESSIONS');
    }

    if (!targetList || targetList.length === 0) {
      throw new AppError('Target list cannot be empty', 400, 'EMPTY_TARGET_LIST');
    }

    if (!message || message.trim().length === 0) {
      throw new AppError('Message content is required', 400, 'EMPTY_MESSAGE');
    }

    // No pre-job audience filtering: every target the operator
    // supplied is attempted directly. Per the operator's "the
    // pannel should try to send messages, add members or whatever
    // task is given without skipping or filtering anything" rule,
    // the panel never drops rows up-front for "looks dead /
    // privacy-restricted" reasons. Real Telegram errors during
    // send still surface per-target as failures.

    // Verify all sessions belong to the user
    const verifiedSessions = await this._verifyMultipleSessionsOwnership(sessionIds, userId);
    let verifiedSessionIds = verifiedSessions.map((s) => s.id);

    // Anti-revoke Phase 3 (B17): drop high-risk sessions from the bulk
    // pool. We log which were dropped + why so the user can act.
    try {
      const cfg = require('../config/telegram');
      if (cfg.ANTI_REVOKE_PHASE_3_ENABLED) {
        const tgRisk = require('../providers/telegram/riskScore');
        const safe = [];
        const skipped = [];
        for (const sid of verifiedSessionIds) {
          try {
            await tgRisk.gateOnRisk(sid);
            safe.push(sid);
          } catch (gateErr) {
            if (gateErr && gateErr.code === 'RISK_TOO_HIGH') {
              skipped.push({ sid, score: gateErr.riskScore, threshold: gateErr.threshold });
            } else {
              safe.push(sid);
            }
          }
        }
        if (skipped.length) {
          logger.warn(
            `sendBulkMessage: dropped ${skipped.length} high-risk session(s)`,
            { skipped }
          );
        }
        if (safe.length === 0) {
          throw new AppError(
            `All selected sessions exceed the anti-revoke risk threshold; refusing to send bulk.`,
            403,
            'RISK_TOO_HIGH'
          );
        }
        verifiedSessionIds = safe;
      }
    } catch (gateChainErr) {
      if (gateChainErr && gateChainErr.statusCode === 403) throw gateChainErr;
      // unrelated error → keep the original list
    }

    if (verifiedSessionIds.length === 0) {
      throw new AppError('No valid sessions found for this user', 404, 'NO_VALID_SESSIONS');
    }

    // Normalize target list to simple IDs
    const normalizedTargets = targetList.map((t) => normalizeTargetId(t)).filter(Boolean);

    if (normalizedTargets.length === 0) {
      throw new AppError('No valid targets in the target list', 400, 'NO_VALID_TARGETS');
    }

    // Build the rotation plan up-front so we can persist it on the
    // job record and feed it to the runner. The planner clamps every
    // user-supplied value to safe bounds; auto mode picks them based
    // on `targets / sessions`.
    const bulkPlan = distributionPlanner.plan({
      totalItems: normalizedTargets.length,
      sessionIds: verifiedSessionIds,
      workType: 'bulk_message',
      mode,
      perSessionBurst,
      cooldownSecMin,
      cooldownSecMax,
      itemDelayMsMin: itemDelayMsMin != null ? itemDelayMsMin : delayMin,
      itemDelayMsMax: itemDelayMsMax != null ? itemDelayMsMax : delayMax,
    });

    // Create the messaging job record
    const jobResult = await pool.query(
      `INSERT INTO messaging_jobs (
         session_id,
         job_type,
         target_list,
         message_content,
         message_type,
         media_path,
         status,
         total_count,
         sent_count,
         failed_count,
         skipped_count,
         options,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       RETURNING id`,
      [
        verifiedSessionIds[0], // primary session (actual sessions in options)
        'bulk',
        JSON.stringify(normalizedTargets),
        message,
        messageType,
        mediaPath,
        'pending',
        normalizedTargets.length,
        0,
        0,
        0,
        JSON.stringify({
          sessionIds: verifiedSessionIds,
          delayMin,
          delayMax,
          messagesPerSession,
          messageOptions,
          sourceType,
          sourceId,
          plan: bulkPlan,
        }),
      ]
    );

    const jobId = jobResult.rows[0].id;

    // Distribute targets across sessions
    const sessionMap = await this.distributionEngine.distributeTargets(
      normalizedTargets,
      verifiedSessionIds,
      { messagesPerSession }
    );

    const distributionObj = {};
    for (const [sid, chunk] of sessionMap) {
      distributionObj[sid] = chunk;
    }

    // Update job with running status
    await pool.query(
      "UPDATE messaging_jobs SET status = 'running' WHERE id = $1",
      [jobId]
    );

    // Initialize Redis progress
    try {
      if (redisClient && redisClient.isReady) {
        await redisClient.set(
          `message:progress:${jobId}`,
          JSON.stringify({
            progress: 0,
            sent: 0,
            failed: 0,
            skipped: 0,
            status: 'running',
            total: normalizedTargets.length,
            updatedAt: new Date().toISOString(),
          }),
          { EX: PROGRESS_TTL }
        );
      }
    } catch (redisError) {
      logger.warn(`Failed to initialize Redis progress for job ${jobId}`, {
        error: redisError.message,
      });
    }

    // Execute the distributed job (non-blocking for large jobs)
    // We run it in the foreground so the caller gets the final result,
    // but for very large jobs the caller should use the job API to check status.
    try {
      const result = await this.distributionEngine.executeDistributedJob(
        {
          id: jobId,
          message_content: message,
          total_count: normalizedTargets.length,
        },
        sessionMap,
        {
          delayMin,
          delayMax,
          messageType,
          mediaPath,
          messageOptions,
          plan: bulkPlan,
        }
      );

      logger.info(`Bulk message job ${jobId} completed`, {
        sent: result.sent,
        failed: result.failed,
        skipped: result.skipped,
      });

      return {
        jobId,
        status: 'completed',
        totalTargets: normalizedTargets.length,
        sessionCount: sessionMap.size,
        distribution: distributionObj,
        plan: bulkPlan,
        results: result,
      };
    } catch (executionError) {
      // Mark job as failed
      await pool.query(
        `UPDATE messaging_jobs SET status = 'failed', completed_at = NOW() WHERE id = $1`,
        [jobId]
      );

      logger.error(`Bulk message job ${jobId} failed`, {
        error: executionError.message,
      });

      throw new AppError(
        `Bulk messaging job failed: ${executionError.message}`,
        500,
        'BULK_JOB_FAILED'
      );
    }
  }

  // =========================================================================
  // Group Messaging
  // =========================================================================

  /**
   * Send a message to a group or channel.
   *
   * @param {string|number} sessionId - Session database ID
   * @param {string|number} groupId - Group/channel identifier
   * @param {string} message - Message content
   * @param {number|string} userId - User ID for authorization
   * @returns {Promise<{ success: boolean, messageId: number|null, groupId: string }>}
   */
  async sendMessageToGroup(sessionId, groupId, message, userId) {
    logger.info(`Sending message to group`, { sessionId, groupId, userId });

    await this._verifySessionOwnership(sessionId, userId);

    try {
      const result = await telegramService.sendMessageToGroup(
        String(sessionId),
        String(groupId),
        message
      );

      // Log the successful send
      await pool.query(
        `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
         VALUES (NULL, $1, $2, $3, NULL, NOW())`,
        [sessionId, String(groupId), 'sent']
      );

      return {
        success: true,
        messageId: result.messageId,
        groupId: String(groupId),
        date: result.date,
      };
    } catch (error) {
      const errorMessage = error.message || String(error);

      await pool.query(
        `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
         VALUES (NULL, $1, $2, $3, $4, NOW())`,
        [sessionId, String(groupId), 'failed', errorMessage]
      );

      logger.error(`Failed to send message to group ${groupId}`, {
        sessionId,
        error: errorMessage,
      });

      return {
        success: false,
        messageId: null,
        groupId: String(groupId),
        error: errorMessage,
      };
    }
  }

  // =========================================================================
  // Forwarding
  // =========================================================================

  /**
   * Forward a message from one chat to another.
   *
   * @param {string|number} sessionId - Session database ID
   * @param {string|number} targetId - Destination chat ID
   * @param {number} messageId - Message ID to forward
   * @param {string|number} sourceId - Source chat ID
   * @param {number|string} userId - User ID for authorization
   * @returns {Promise<{ success: boolean, messageId: number|null, sourceId: string, targetId: string }>}
   */
  async forwardMessage(sessionId, targetId, messageId, sourceId, userId) {
    logger.info(`Forwarding message`, { sessionId, targetId, messageId, sourceId, userId });

    await this._verifySessionOwnership(sessionId, userId);

    try {
      const result = await telegramService.forwardMessage(
        String(sessionId),
        String(targetId),
        parseInt(messageId, 10),
        String(sourceId)
      );

      // Log the successful forward
      await pool.query(
        `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
         VALUES (NULL, $1, $2, $3, NULL, NOW())`,
        [sessionId, String(targetId), 'sent']
      );

      return {
        success: true,
        messageId: result.messageId,
        sourceId: String(sourceId),
        targetId: String(targetId),
        date: result.date,
      };
    } catch (error) {
      const errorMessage = error.message || String(error);

      await pool.query(
        `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
         VALUES (NULL, $1, $2, $3, $4, NOW())`,
        [sessionId, String(targetId), 'failed', errorMessage]
      );

      logger.error(`Failed to forward message ${messageId}`, {
        sessionId,
        error: errorMessage,
      });

      return {
        success: false,
        messageId: null,
        sourceId: String(sourceId),
        targetId: String(targetId),
        error: errorMessage,
      };
    }
  }

  // =========================================================================
  // Job Management
  // =========================================================================

  /**
   * Get detailed information about a messaging job including its logs.
   *
   * @param {number|string} jobId - Job database ID
   * @param {number|string} userId - User ID for authorization
   * @returns {Promise<{
   *   job: object,
   *   logs: Array<object>,
   *   logCount: number,
   *   progress: object|null
   * }>}
   */
  async getJobDetails(jobId, userId) {
    logger.info(`Fetching job details`, { jobId, userId });

    // Fetch the job and verify ownership
    const jobResult = await pool.query(
      `SELECT mj.*, s.user_id
       FROM messaging_jobs mj
       JOIN sessions s ON mj.session_id = s.id
       WHERE mj.id = $1 AND s.user_id = $2`,
      [jobId, userId]
    );

    if (jobResult.rows.length === 0) {
      throw new AppError('Messaging job not found or access denied', 404, 'JOB_NOT_FOUND');
    }

    const job = jobResult.rows[0];

    // Fetch message logs for this job
    const logsResult = await pool.query(
      `SELECT id, job_id, session_id, target_id, status, error_message, sent_at
       FROM message_logs
       WHERE job_id = $1
       ORDER BY sent_at DESC
       LIMIT 1000`,
      [jobId]
    );

    const logs = logsResult.rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      sessionId: row.session_id,
      targetId: String(row.target_id),
      status: row.status,
      errorMessage: row.error_message,
      sentAt: row.sent_at,
    }));

    // Get progress from Redis if available
    let progress = null;
    try {
      if (redisClient && redisClient.isReady) {
        const progressData = await redisClient.get(`message:progress:${jobId}`);
        if (progressData) {
          progress = JSON.parse(progressData);
        }
      }
    } catch {
      // Redis unavailable, progress will be null
    }

    // Compute summary stats from logs
    const logStats = {
      total: logs.length,
      sent: logs.filter((l) => l.status === 'sent').length,
      failed: logs.filter((l) => l.status === 'failed').length,
      skipped: logs.filter((l) => l.status === 'skipped').length,
    };

    return {
      job: {
        id: job.id,
        sessionId: job.session_id,
        jobType: job.job_type,
        targetList: parseJson(job.target_list),
        messageContent: job.message_content,
        messageType: job.message_type,
        mediaPath: job.media_path,
        status: job.status,
        totalCount: job.total_count,
        sentCount: job.sent_count,
        failedCount: job.failed_count,
        skippedCount: job.skipped_count,
        options: parseJson(job.options),
        createdAt: job.created_at,
        completedAt: job.completed_at,
      },
      logs,
      logStats,
      progress,
    };
  }

  /**
   * List messaging jobs for a user with pagination, sorting, and filtering.
   *
   * @param {number|string} userId - User ID
   * @param {object} params - Query parameters
   * @param {number} params.page - Page number (default: 1)
   * @param {number} params.limit - Items per page (default: 20)
   * @param {string} params.sort - Sort field (default: 'created_at')
   * @param {string} params.order - Sort order: ASC or DESC (default: 'DESC')
   * @param {string} params.status - Filter by job status
   * @returns {Promise<{ jobs: Array<object>, pagination: object }>}
   */
  async listJobs(userId, { page = 1, limit = 20, sort = 'created_at', order = 'DESC', status, jobType } = {}) {
    logger.info(`Listing messaging jobs for user ${userId}`, { page, limit, sort, order, status, jobType });

    const { offset, limit: pageSize } = applyPagination(null, page, limit);
    const validSortFields = ['created_at', 'completed_at', 'total_count', 'sent_count', 'failed_count', 'id'];
    const { field: sortField, order: sortOrder } = applySorting(sort, order, validSortFields);

    const queryConditions = ['s.user_id = $1'];
    const queryParams = [userId];
    let paramIndex = 2;

    if (status && VALID_JOB_STATUSES.includes(status)) {
      queryConditions.push(`mj.status = $${paramIndex}`);
      queryParams.push(status);
      paramIndex++;
    }

    // Optional job-type filter so callers (e.g. the Single-User
    // Mass DM History tab) can scope listings to one job_type
    // instead of paging through every messaging job. Accepts a
    // string ("single_user_mass_dm") or array of strings.
    if (jobType !== undefined && jobType !== null && jobType !== '') {
      const types = Array.isArray(jobType)
        ? jobType.filter((t) => typeof t === 'string' && t.length > 0)
        : (typeof jobType === 'string' && jobType.length > 0 ? [jobType] : []);
      if (types.length === 1) {
        queryConditions.push(`mj.job_type = $${paramIndex}`);
        queryParams.push(types[0]);
        paramIndex++;
      } else if (types.length > 1) {
        queryConditions.push(`mj.job_type = ANY($${paramIndex}::text[])`);
        queryParams.push(types);
        paramIndex++;
      }
    }

    const whereClause = queryConditions.join(' AND ');

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total
       FROM messaging_jobs mj
       JOIN sessions s ON mj.session_id = s.id
       WHERE ${whereClause}`,
      queryParams
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated results.
    //
    // We include `target_list` here (operators wanted to see *which*
    // usernames/IDs a single-user mass DM job ran against, straight
    // from the History tab — without having to open the per-job
    // detail view). For very large bulk jobs the column can be huge,
    // so the row mapper below truncates the parsed array to a small
    // preview and exposes a separate `targetCount` count, keeping
    // wire-size predictable.
    const jobsResult = await pool.query(
      `SELECT mj.id, mj.session_id, mj.job_type, mj.message_type,
              mj.message_content, mj.media_path, mj.status,
              mj.total_count, mj.sent_count, mj.failed_count, mj.skipped_count,
              mj.target_list, mj.options, mj.created_at, mj.completed_at,
              s.phone as session_phone
       FROM messaging_jobs mj
       JOIN sessions s ON mj.session_id = s.id
       WHERE ${whereClause}
       ORDER BY mj.${sortField} ${sortOrder}
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...queryParams, pageSize, offset]
    );

    // Truncate each job's target_list to a small preview so the
    // payload stays bounded for big bulk jobs while single-user
    // mass DM jobs (typically 1..3 targets) still render in full.
    const TARGETS_PREVIEW_LIMIT = 25;
    const jobs = jobsResult.rows.map((row) => {
      const parsedTargets = parseJson(row.target_list);
      let targetsPreview = null;
      let targetCount = null;
      if (Array.isArray(parsedTargets)) {
        targetCount = parsedTargets.length;
        targetsPreview =
          parsedTargets.length > TARGETS_PREVIEW_LIMIT
            ? parsedTargets.slice(0, TARGETS_PREVIEW_LIMIT)
            : parsedTargets;
      } else if (parsedTargets && typeof parsedTargets === 'object') {
        // Some legacy jobs store target_list as a wrapper object —
        // pass it through verbatim and let the UI decide.
        targetsPreview = parsedTargets;
      }
      return {
        id: row.id,
        sessionId: row.session_id,
        sessionPhone: row.session_phone,
        jobType: row.job_type,
        messageType: row.message_type,
        messageContent: row.message_content
          ? (row.message_content.length > 100
              ? row.message_content.substring(0, 100) + '...'
              : row.message_content)
          : null,
        mediaPath: row.media_path,
        status: row.status,
        totalCount: row.total_count,
        sentCount: row.sent_count,
        failedCount: row.failed_count,
        skippedCount: row.skipped_count,
        targets: targetsPreview,
        targetCount,
        targetsTruncated:
          Array.isArray(parsedTargets) && parsedTargets.length > TARGETS_PREVIEW_LIMIT,
        options: parseJson(row.options),
        createdAt: row.created_at,
        completedAt: row.completed_at,
      };
    });

    const pagination = buildPagination(page, limit, total);

    return { jobs, pagination };
  }

  /**
   * Cancel a running messaging job.
   *
   * Sets the cancellation token in Redis and updates the job status.
   *
   * @param {number|string} jobId - Job database ID
   * @param {number|string} userId - User ID for authorization
   * @returns {Promise<{ success: boolean, jobId: number, previousStatus: string }>}
   */
  async cancelJob(jobId, userId) {
    logger.info(`Cancelling messaging job`, { jobId, userId });

    // Verify job ownership
    const jobResult = await pool.query(
      `SELECT mj.id, mj.status, s.user_id
       FROM messaging_jobs mj
       JOIN sessions s ON mj.session_id = s.id
       WHERE mj.id = $1 AND s.user_id = $2`,
      [jobId, userId]
    );

    if (jobResult.rows.length === 0) {
      throw new AppError('Messaging job not found or access denied', 404, 'JOB_NOT_FOUND');
    }

    const job = jobResult.rows[0];
    const previousStatus = job.status;

    // Cannot cancel already finished jobs
    if (['completed', 'cancelled', 'failed'].includes(job.status)) {
      throw new AppError(
        `Cannot cancel job in '${job.status}' status`,
        400,
        'JOB_NOT_CANCELABLE'
      );
    }

    // Set cancellation token in Redis for fast detection by the execution engine
    try {
      if (redisClient && redisClient.isReady) {
        await redisClient.set(`message:cancel:${jobId}`, '1', { EX: PROGRESS_TTL });
      }
    } catch (redisError) {
      logger.warn(`Failed to set Redis cancellation token for job ${jobId}`, {
        error: redisError.message,
      });
    }

    // Update job status in the database
    await pool.query(
      `UPDATE messaging_jobs SET status = 'cancelled', completed_at = NOW() WHERE id = $1`,
      [jobId]
    );

    // Update progress in Redis
    try {
      if (redisClient && redisClient.isReady) {
        const progressData = await redisClient.get(`message:progress:${jobId}`);
        if (progressData) {
          const progress = JSON.parse(progressData);
          progress.status = 'cancelled';
          progress.updatedAt = new Date().toISOString();
          await redisClient.set(
            `message:progress:${jobId}`,
            JSON.stringify(progress),
            { EX: PROGRESS_TTL }
          );
        }
      }
    } catch {
      // Non-critical
    }

    logger.info(`Job ${jobId} cancelled (was: ${previousStatus})`);

    return {
      success: true,
      jobId: Number(jobId),
      previousStatus,
    };
  }

  // =========================================================================
  // Message History
  // =========================================================================

  /**
   * Get message history with filtering and pagination.
   *
   * @param {number|string} userId - User ID
   * @param {object} params - Query parameters
   * @param {number} params.page - Page number (default: 1)
   * @param {number} params.limit - Items per page (default: 20)
   * @param {string} params.status - Filter by log status (sent/failed/skipped)
   * @param {number} params.sessionId - Filter by session ID
   * @param {string} params.dateFrom - Start date filter (ISO string)
   * @param {string} params.dateTo - End date filter (ISO string)
   * @returns {Promise<{ logs: Array<object>, pagination: object, exportUrl: string }>}
   */
  async getMessageHistory(userId, { page = 1, limit = 20, status, sessionId, dateFrom, dateTo } = {}) {
    logger.info(`Fetching message history for user ${userId}`, { page, limit, status, sessionId });

    const { offset, limit: pageSize } = applyPagination(null, page, limit);

    const queryConditions = ['s.user_id = $1'];
    const queryParams = [userId];
    let paramIndex = 2;

    if (status && VALID_LOG_STATUSES.includes(status)) {
      queryConditions.push(`ml.status = $${paramIndex}`);
      queryParams.push(status);
      paramIndex++;
    }

    if (sessionId) {
      queryConditions.push(`ml.session_id = $${paramIndex}`);
      queryParams.push(sessionId);
      paramIndex++;
    }

    if (dateFrom) {
      queryConditions.push(`ml.sent_at >= $${paramIndex}`);
      queryParams.push(dateFrom);
      paramIndex++;
    }

    if (dateTo) {
      queryConditions.push(`ml.sent_at <= $${paramIndex}`);
      queryParams.push(dateTo);
      paramIndex++;
    }

    const whereClause = queryConditions.join(' AND ');

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total
       FROM message_logs ml
       JOIN sessions s ON ml.session_id = s.id
       WHERE ${whereClause}`,
      queryParams
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated results
    const logsResult = await pool.query(
      `SELECT ml.id, ml.job_id, ml.session_id, ml.target_id,
              ml.status, ml.error_message, ml.sent_at,
              mj.job_type, mj.message_type,
              s.phone as session_phone
       FROM message_logs ml
       JOIN sessions s ON ml.session_id = s.id
       LEFT JOIN messaging_jobs mj ON ml.job_id = mj.id
       WHERE ${whereClause}
       ORDER BY ml.sent_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...queryParams, pageSize, offset]
    );

    const logs = logsResult.rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      sessionId: row.session_id,
      sessionPhone: row.session_phone,
      targetId: String(row.target_id),
      status: row.status,
      errorMessage: row.error_message,
      jobType: row.job_type,
      messageType: row.message_type,
      sentAt: row.sent_at,
    }));

    const pagination = buildPagination(page, limit, total);

    return {
      logs,
      pagination,
      exportUrl: `/api/messages/history/export?page=${page}&limit=${limit}&status=${status || ''}&sessionId=${sessionId || ''}&dateFrom=${dateFrom || ''}&dateTo=${dateTo || ''}`,
    };
  }

  /**
   * Export message history as JSON.
   *
   * @param {number|string} userId - User ID
   * @param {object} params - Same filters as getMessageHistory
   * @returns {Promise<{ export: Array<object>, total: number, exportedAt: string }>}
   */
  async exportMessageHistory(userId, { status, sessionId, dateFrom, dateTo } = {}) {
    logger.info(`Exporting message history for user ${userId}`);

    const queryConditions = ['s.user_id = $1'];
    const queryParams = [userId];
    let paramIndex = 2;

    if (status && VALID_LOG_STATUSES.includes(status)) {
      queryConditions.push(`ml.status = $${paramIndex}`);
      queryParams.push(status);
      paramIndex++;
    }

    if (sessionId) {
      queryConditions.push(`ml.session_id = $${paramIndex}`);
      queryParams.push(sessionId);
      paramIndex++;
    }

    if (dateFrom) {
      queryConditions.push(`ml.sent_at >= $${paramIndex}`);
      queryParams.push(dateFrom);
      paramIndex++;
    }

    if (dateTo) {
      queryConditions.push(`ml.sent_at <= $${paramIndex}`);
      queryParams.push(dateTo);
      paramIndex++;
    }

    const whereClause = queryConditions.join(' AND ');

    const exportResult = await pool.query(
      `SELECT ml.id, ml.job_id, ml.session_id, ml.target_id,
              ml.status, ml.error_message, ml.sent_at,
              mj.job_type, mj.message_type, mj.message_content,
              s.phone as session_phone
       FROM message_logs ml
       JOIN sessions s ON ml.session_id = s.id
       LEFT JOIN messaging_jobs mj ON ml.job_id = mj.id
       WHERE ${whereClause}
       ORDER BY ml.sent_at DESC`,
      queryParams
    );

    const exportData = exportResult.rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      sessionId: row.session_id,
      sessionPhone: row.session_phone,
      targetId: String(row.target_id),
      status: row.status,
      errorMessage: row.error_message,
      jobType: row.job_type,
      messageType: row.message_type,
      messageContent: row.message_content,
      sentAt: row.sent_at,
    }));

    return {
      export: exportData,
      total: exportData.length,
      exportedAt: new Date().toISOString(),
      format: 'json',
    };
  }

  // =========================================================================
  // Messaging Statistics
  // =========================================================================

  /**
   * Get comprehensive messaging statistics for a user.
   *
   * @param {number|string} userId - User ID
   * @returns {Promise<{
   *   totalJobs: number,
   *   totalMessages: number,
   *   totalSent: number,
   *   totalFailed: number,
   *   totalSkipped: number,
   *   successRate: number,
   *   jobsByStatus: object,
   *   messagesByStatus: object,
   *   recentActivity: Array<object>,
   *   topSessions: Array<object>,
   *   dailyStats: Array<object>
   * }>}
   */
  async getMessagingStats(userId) {
    logger.info(`Fetching messaging stats for user ${userId}`);

    // Total jobs
    const totalJobsResult = await pool.query(
      `SELECT COUNT(*) as total FROM messaging_jobs mj
       JOIN sessions s ON mj.session_id = s.id
       WHERE s.user_id = $1`,
      [userId]
    );
    const totalJobs = parseInt(totalJobsResult.rows[0].total, 10);

    // Aggregate counts from jobs
    const jobCountsResult = await pool.query(
      `SELECT
         COALESCE(SUM(mj.total_count), 0) as total_messages,
         COALESCE(SUM(mj.sent_count), 0) as total_sent,
         COALESCE(SUM(mj.failed_count), 0) as total_failed,
         COALESCE(SUM(mj.skipped_count), 0) as total_skipped
       FROM messaging_jobs mj
       JOIN sessions s ON mj.session_id = s.id
       WHERE s.user_id = $1`,
      [userId]
    );

    const jobCounts = jobCountsResult.rows[0];
    const totalMessages = parseInt(jobCounts.total_messages, 10);
    const totalSent = parseInt(jobCounts.total_sent, 10);
    const totalFailed = parseInt(jobCounts.total_failed, 10);
    const totalSkipped = parseInt(jobCounts.total_skipped, 10);
    const successRate = totalMessages > 0
      ? Math.round((totalSent / totalMessages) * 10000) / 100
      : 0;

    // Jobs by status
    const jobsByStatusResult = await pool.query(
      `SELECT mj.status, COUNT(*) as count
       FROM messaging_jobs mj
       JOIN sessions s ON mj.session_id = s.id
       WHERE s.user_id = $1
       GROUP BY mj.status`,
      [userId]
    );

    const jobsByStatus = {};
    for (const row of jobsByStatusResult.rows) {
      jobsByStatus[row.status] = parseInt(row.count, 10);
    }

    // Message logs by status (including single messages not tied to jobs)
    const messagesByStatusResult = await pool.query(
      `SELECT ml.status, COUNT(*) as count
       FROM message_logs ml
       JOIN sessions s ON ml.session_id = s.id
       WHERE s.user_id = $1
       GROUP BY ml.status`,
      [userId]
    );

    const messagesByStatus = {};
    for (const row of messagesByStatusResult.rows) {
      messagesByStatus[row.status] = parseInt(row.count, 10);
    }

    // Recent activity (last 10 messages)
    const recentResult = await pool.query(
      `SELECT ml.id, ml.target_id, ml.status, ml.error_message, ml.sent_at,
              mj.job_type, s.phone as session_phone
       FROM message_logs ml
       JOIN sessions s ON ml.session_id = s.id
       LEFT JOIN messaging_jobs mj ON ml.job_id = mj.id
       WHERE s.user_id = $1
       ORDER BY ml.sent_at DESC
       LIMIT 10`,
      [userId]
    );

    const recentActivity = recentResult.rows.map((row) => ({
      id: row.id,
      targetId: String(row.target_id),
      status: row.status,
      errorMessage: row.error_message,
      jobType: row.job_type,
      sessionPhone: row.session_phone,
      sentAt: row.sent_at,
    }));

    // Top sessions by message count
    const topSessionsResult = await pool.query(
      `SELECT s.id, s.phone, COUNT(ml.id) as message_count,
              COUNT(*) FILTER (WHERE ml.status = 'sent') as sent_count,
              COUNT(*) FILTER (WHERE ml.status = 'failed') as failed_count
       FROM message_logs ml
       JOIN sessions s ON ml.session_id = s.id
       WHERE s.user_id = $1
       GROUP BY s.id, s.phone
       ORDER BY message_count DESC
       LIMIT 5`,
      [userId]
    );

    const topSessions = topSessionsResult.rows.map((row) => ({
      sessionId: row.id,
      phone: row.phone,
      messageCount: parseInt(row.message_count, 10),
      sentCount: parseInt(row.sent_count, 10),
      failedCount: parseInt(row.failed_count, 10),
    }));

    // Daily stats for the last 7 days
    const dailyStatsResult = await pool.query(
      `SELECT
         DATE(ml.sent_at) as date,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE ml.status = 'sent') as sent,
         COUNT(*) FILTER (WHERE ml.status = 'failed') as failed,
         COUNT(*) FILTER (WHERE ml.status = 'skipped') as skipped
       FROM message_logs ml
       JOIN sessions s ON ml.session_id = s.id
       WHERE s.user_id = $1
         AND ml.sent_at >= NOW() - INTERVAL '7 days'
       GROUP BY DATE(ml.sent_at)
       ORDER BY date DESC`,
      [userId]
    );

    const dailyStats = dailyStatsResult.rows.map((row) => ({
      date: row.date,
      total: parseInt(row.total, 10),
      sent: parseInt(row.sent, 10),
      failed: parseInt(row.failed, 10),
      skipped: parseInt(row.skipped, 10),
    }));

    return {
      totalJobs,
      totalMessages,
      totalSent,
      totalFailed,
      totalSkipped,
      successRate,
      jobsByStatus,
      messagesByStatus,
      recentActivity,
      topSessions,
      dailyStats,
    };
  }

  // =========================================================================
  // Preview / Test
  // =========================================================================

  /**
   * Send a test/preview message to verify formatting and delivery.
   * This is essentially a single message send with logging.
   *
   * @param {string|number} sessionId - Session database ID
   * @param {string|number} targetId - Target to send the test message to
   * @param {string} message - Message content to preview
   * @param {number|string} userId - User ID for authorization
   * @returns {Promise<{ success: boolean, messageId: number|null, targetId: string, date: string, error?: string }>}
   */
  async previewMessage(sessionId, targetId, message, userId) {
    logger.info(`Previewing message`, { sessionId, targetId, userId });

    await this._verifySessionOwnership(sessionId, userId);

    if (!message || message.trim().length === 0) {
      throw new AppError('Message content is required for preview', 400, 'EMPTY_MESSAGE');
    }

    try {
      const result = await telegramService.sendMessage(
        String(sessionId),
        String(targetId),
        message,
        { silent: true }
      );

      // Log the preview
      await pool.query(
        `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
         VALUES (NULL, $1, $2, $3, NULL, NOW())`,
        [sessionId, String(targetId), 'sent']
      );

      return {
        success: true,
        messageId: result.messageId,
        targetId: String(targetId),
        date: result.date,
        preview: true,
      };
    } catch (error) {
      const errorMessage = error.message || String(error);

      await pool.query(
        `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
         VALUES (NULL, $1, $2, $3, $4, NOW())`,
        [sessionId, String(targetId), 'failed', errorMessage]
      );

      logger.error(`Preview message failed`, {
        sessionId,
        targetId,
        error: errorMessage,
      });

      return {
        success: false,
        messageId: null,
        targetId: String(targetId),
        error: errorMessage,
        preview: true,
      };
    }
  }

  // =========================================================================
  // Real-time Progress Query
  // =========================================================================

  /**
   * Get real-time progress for a job from Redis.
   *
   * @param {number|string} jobId - Job database ID
   * @param {number|string} userId - User ID for authorization
   * @returns {Promise<{ progress: number, sent: number, failed: number, skipped: number, status: string, total: number, updatedAt: string }>}
   */
  async getJobProgress(jobId, userId) {
    // Verify job ownership first
    const jobResult = await pool.query(
      `SELECT mj.id, s.user_id
       FROM messaging_jobs mj
       JOIN sessions s ON mj.session_id = s.id
       WHERE mj.id = $1 AND s.user_id = $2`,
      [jobId, userId]
    );

    if (jobResult.rows.length === 0) {
      throw new AppError('Messaging job not found or access denied', 404, 'JOB_NOT_FOUND');
    }

    // Try Redis first
    try {
      if (redisClient && redisClient.isReady) {
        const progressData = await redisClient.get(`message:progress:${jobId}`);
        if (progressData) {
          return JSON.parse(progressData);
        }
      }
    } catch {
      // Redis unavailable, fall back to database
    }

    // Fallback to database
    const job = jobResult.rows[0];
    const dbResult = await pool.query(
      'SELECT total_count, sent_count, failed_count, skipped_count, status FROM messaging_jobs WHERE id = $1',
      [jobId]
    );

    if (dbResult.rows.length === 0) {
      return { progress: 0, sent: 0, failed: 0, skipped: 0, status: 'unknown', total: 0 };
    }

    const row = dbResult.rows[0];
    const total = parseInt(row.total_count, 10);
    const sent = parseInt(row.sent_count, 10);
    const failed = parseInt(row.failed_count, 10);
    const skipped = parseInt(row.skipped_count, 10);
    const completed = sent + failed + skipped;

    return {
      progress: total > 0 ? Math.round((completed / total) * 100) : 0,
      sent,
      failed,
      skipped,
      status: row.status,
      total,
      updatedAt: new Date().toISOString(),
    };
  }

  // =========================================================================
  // Queue-Based Bulk Messaging to Groups
  // =========================================================================

  /**
   * Send messages to multiple groups with queue-based rate limiting.
   * 
   * Strategy:
   * - Distribute groups across sessions in round-robin fashion
   * - Each session sends to N groups, then waits for delay
   * - Prevents hitting Telegram rate limits
   * - Continues on failure (skips failed groups)
   * 
   * @param {object} params
   * @param {number[]} params.sessionIds - Array of session IDs
   * @param {string[]} params.groupIds - Array of group/channel IDs
   * @param {string} params.message - Message content
   * @param {string} params.messageType - 'text', 'html', or 'markdown'
   * @param {number} params.delayBetweenRounds - Delay in seconds between rounds (default: 20)
   * @param {number} userId - User ID
   * @returns {Promise<{jobId, status, total, sent, failed, skipped}>}
   */
  async sendBulkToGroups(params, userId) {
    const {
      sessionIds,
      groupIds,
      message,
      messageType = 'text',
      delayBetweenRounds = 20,
    } = params;

    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!sessionIds || sessionIds.length === 0) {
      throw new AppError('At least one session is required', 400, 'NO_SESSIONS');
    }

    if (!groupIds || groupIds.length === 0) {
      throw new AppError('At least one group is required', 400, 'NO_GROUPS');
    }

    if (!message || message.trim().length === 0) {
      throw new AppError('Message is required', 400, 'EMPTY_MESSAGE');
    }

    // Verify session ownership
    const verifiedSessions = await this._verifyMultipleSessionsOwnership(sessionIds, userId);
    if (verifiedSessions.length === 0) {
      throw new AppError('No valid sessions found', 404, 'NO_VALID_SESSIONS');
    }

    const numSessions = verifiedSessions.length;
    const numGroups = groupIds.length;

    logger.info(`Starting bulk group messaging: ${numGroups} groups, ${numSessions} sessions`, {
      userId, numSessions, numGroups,
    });

    // Create job record. The schema only has a single `session_id`
    // column, so we record the primary session here and stash the
    // full session list (plus targets and rate-limit knobs) in
    // `options` so `_processBulkGroups` can reconstruct the fan-out.
    const jobResult = await pool.query(
      `INSERT INTO messaging_jobs (
        user_id, session_id, job_type, target_list, message_content, message_type,
        status, total_count, sent_count, failed_count, skipped_count, options, created_at
      ) VALUES ($1, $2, 'bulk_groups', $3, $4, $5, 'pending', $6, 0, 0, 0, $7, NOW())
      RETURNING id`,
      [
        userId,
        verifiedSessions[0].id,
        JSON.stringify(groupIds),
        message,
        messageType,
        groupIds.length * verifiedSessions.length,
        JSON.stringify({
          delayBetweenRounds,
          groupIds,
          sessionIds: verifiedSessions.map((s) => s.id),
        }),
      ]
    );

    const jobId = jobResult.rows[0].id;

    // Start async processing
    this._processBulkGroups(jobId, verifiedSessions, groupIds, message, messageType, delayBetweenRounds, userId)
      .catch(err => {
        logger.error(`Bulk groups job ${jobId} failed with error: ${err.message}`);
      });

    return {
      jobId,
      status: 'pending',
      total: numGroups,
      message: 'Job queued and will process in background',
    };
  }

  /**
   * Internal method to process bulk group messaging with rate limiting.
   */
  async _processBulkGroups(jobId, sessions, groupIds, message, messageType, delayBetweenRounds, userId) {
    const numSessions = sessions.length;
    const sentCount = { value: 0 };
    const failedCount = { value: 0 };
    const skippedCount = { value: 0 };
    const results = [];

    // Update job to running. NOTE: `messaging_jobs` does not have a
    // `started_at` column (only `created_at` and `completed_at`); the
    // earlier code referenced it and bombed out the bulk-groups path
    // with a 500. Keep this UPDATE minimal.
    await pool.query(
      `UPDATE messaging_jobs SET status = 'running' WHERE id = $1`,
      [jobId]
    );

    // Notify progress
    await this._notifyProgress(jobId, {
      job_id: jobId,
      status: 'running',
      total: groupIds.length * sessions.length,
      sent: 0,
      failed: 0,
      skipped: 0,
    });

    try {
      // Strategy: EACH session sends to EACH group
      // Process in rounds to avoid rate limits
      // Round 1: All sessions send to group 1
      // Round 2: All sessions send to group 2
      // etc.
      
      for (let g = 0; g < groupIds.length; g++) {
        const groupId = groupIds[g];
        
        // Check if job was cancelled
        const jobStatus = await pool.query('SELECT status FROM messaging_jobs WHERE id = $1', [jobId]);
        if (jobStatus.rows[0]?.status === 'cancelled') {
          logger.info(`Bulk groups job ${jobId} cancelled at group ${g}`);
          await this._finalizeJob(jobId, 'cancelled', sentCount.value, failedCount.value, skippedCount.value, results);
          return;
        }

        // Wait between groups (except first)
        if (g > 0) {
          const delayMs = delayBetweenRounds * 1000;
          logger.info(`Waiting ${delayBetweenRounds}s before next group`, { jobId, group: g });
          await sleep(delayMs);
        }

        // All sessions send to this group
        for (const session of sessions) {
          const result = { sessionId: session.id, groupId, success: false };

          try {
            // Send message to group
            const sendResult = await telegramService.sendMessageToGroup(
              String(session.id),
              String(groupId),
              message
            );

            result.success = true;
            result.messageId = sendResult.messageId;
            sentCount.value++;

            // Log success - only if target_id is numeric
            const targetIdNumeric = String(groupId).match(/^\d+$/) ? BigInt(String(groupId).replace(/^[^\d]*/, '')) : null;
            if (targetIdNumeric) {
              await pool.query(
                `INSERT INTO message_logs (job_id, session_id, target_id, status, sent_at)
                 VALUES ($1, $2, $3, 'sent', NOW())`,
                [jobId, session.id, targetIdNumeric]
              );
            }

          } catch (err) {
            result.error = err.message;
            failedCount.value++;

            // Log failure
            await pool.query(
              `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
               VALUES ($1, $2, $3, 'failed', $4, NOW())`,
              [jobId, session.id, String(groupId), err.message]
            );

            logger.warn(`Failed to send message to group ${groupId} from session ${session.id}: ${err.message}`);
          }

          results.push(result);

          // Update progress in Redis
          await this._notifyProgress(jobId, {
            job_id: jobId,
            status: 'running',
            total: groupIds.length * sessions.length,
            sent: sentCount.value,
            failed: failedCount.value,
            skipped: skippedCount.value,
            session_id: session.id,
            group_id: groupId,
          });
        }
      }

      // Job completed
      const finalStatus = 'completed';
      await this._finalizeJob(jobId, finalStatus, sentCount.value, failedCount.value, skippedCount.value, results);

      logger.info(`Bulk groups job ${jobId} completed: ${sentCount.value} sent, ${failedCount.value} failed`, {
        jobId,
      });

    } catch (outerErr) {
      logger.error(`Bulk groups job ${jobId} failed: ${outerErr.message}`);
      await this._finalizeJob(jobId, 'failed', sentCount.value, failedCount.value, skippedCount.value, results);
    }
  }

  // =========================================================================
  // Queue-Based Bulk Messaging to Users (from scraped lists)
  // =========================================================================

  /**
   * Send messages to multiple users with queue-based rate limiting.
   * 
   * Strategy:
   * - Users are distributed across sessions
   * - Each session sends to N users, then all sessions wait
   * - Prevents hitting Telegram rate limits
   * - Continues on failure (skips failed users)
   * 
   * @param {object} params
   * @param {number[]} params.sessionIds - Array of session IDs
   * @param {Array} params.users - Array of user objects with telegram_id
   * @param {string} params.message - Message content
   * @param {string} params.messageType - 'text', 'html', or 'markdown'
   * @param {number} params.usersPerRound - Users per session per round (default: 5)
   * @param {number} params.delayBetweenRounds - Delay in seconds between rounds (default: 60)
   * @param {number} userId - User ID
   * @returns {Promise<{jobId, status, total}>}
   */
  async sendBulkToUsers(params, userId) {
    const {
      sessionIds,
      message,
      messageType = 'text',
      usersPerRound = 5,
      delayBetweenRounds = 60,
      // Optional source list id — when set AND the list was uploaded
      // (not scraped by the panel itself), the audience filter
      // persists status back into list_items. Manual entries and
      // scraped lists bypass the filter entirely per the operator's
      // explicit rule:
      //   "filtering should only and only works for the lists that
      //    were uploaded manually (not scrapped by pannel). For
      //    other places where manual ID or usernames are entered the
      //    job must started directly without checking the filtering
      //    system."
      listId = null,
      sourceType = 'manual',
    } = params;
    let users = params.users;

    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!sessionIds || sessionIds.length === 0) {
      throw new AppError('At least one session is required', 400, 'NO_SESSIONS');
    }

    if (!users || users.length === 0) {
      throw new AppError('At least one user is required', 400, 'NO_USERS');
    }

    if (!message || message.trim().length === 0) {
      throw new AppError('Message is required', 400, 'EMPTY_MESSAGE');
    }

    // No pre-job audience filtering: every user the operator
    // supplied is attempted directly. Per the operator's "remove
    // the filtering users system completly" rule, the panel never
    // drops rows up-front. Real Telegram errors during send still
    // surface per-target as failures.

    if (!users || users.length === 0) {
      throw new AppError(
        'No users to process: the input list is empty.',
        400,
        'NO_ELIGIBLE_USERS'
      );
    }

    // Verify session ownership
    const verifiedSessions = await this._verifyMultipleSessionsOwnership(sessionIds, userId);
    if (verifiedSessions.length === 0) {
      throw new AppError('No valid sessions found', 404, 'NO_VALID_SESSIONS');
    }

    const numSessions = verifiedSessions.length;
    const numUsers = users.length;

    logger.info(`Starting bulk user messaging: ${numUsers} users, ${numSessions} sessions`, {
      userId, numSessions, numUsers,
    });

    // Create job record. The schema only has a single `session_id`
    // column, so we record the primary session here and stash the
    // full session list (plus targets and rate-limit knobs) in
    // `options` so `_processBulkUsers` can reconstruct the fan-out.
    const jobResult = await pool.query(
      `INSERT INTO messaging_jobs (
        user_id, session_id, job_type, target_list, message_content, message_type,
        status, total_count, sent_count, failed_count, skipped_count, options, created_at
      ) VALUES ($1, $2, 'bulk_users', $3, $4, $5, 'pending', $6, 0, 0, 0, $7, NOW())
      RETURNING id`,
      [
        userId,
        verifiedSessions[0].id,
        JSON.stringify(users),
        message,
        messageType,
        users.length,
        JSON.stringify({
          delayBetweenRounds,
          usersPerRound,
          userCount: users.length,
          sessionIds: verifiedSessions.map((s) => s.id),
        }),
      ]
    );

    const jobId = jobResult.rows[0].id;

    // Start async processing
    this._processBulkUsers(jobId, verifiedSessions, users, message, messageType, usersPerRound, delayBetweenRounds, userId)
      .catch(err => {
        logger.error(`Bulk users job ${jobId} failed with error: ${err.message}`);
      });

    return {
      jobId,
      status: 'pending',
      total: numUsers,
      message: 'Job queued and will process in background',
    };
  }

  /**
   * Internal method to process bulk user messaging with rate limiting.
   */
  async _processBulkUsers(jobId, sessions, users, message, messageType, usersPerRound, delayBetweenRounds, userId) {
    const numSessions = sessions.length;
    const sentCount = { value: 0 };
    const failedCount = { value: 0 };
    const skippedCount = { value: 0 };
    const results = [];

    // Update job to running. NOTE: `messaging_jobs` does not have a
    // `started_at` column (only `created_at` and `completed_at`); the
    // earlier code referenced it and bombed out the bulk-users path
    // with a 500. Keep this UPDATE minimal.
    await pool.query(
      `UPDATE messaging_jobs SET status = 'running' WHERE id = $1`,
      [jobId]
    );

    // Notify progress
    await this._notifyProgress(jobId, {
      job_id: jobId,
      status: 'running',
      total: users.length,
      sent: 0,
      failed: 0,
      skipped: 0,
    });

    try {
      // Distribute users across sessions in round-robin
      // But process in batches: each session handles usersPerRound users, then wait
      const sessionUsers = {}; // sessionId -> [user1, user2, ...]
      
      for (let i = 0; i < sessions.length; i++) {
        sessionUsers[sessions[i].id] = [];
      }

      // Round-robin distribution
      for (let i = 0; i < users.length; i++) {
        const sessionIdx = i % numSessions;
        sessionUsers[sessions[sessionIdx].id].push(users[i]);
      }

      // Process in rounds
      let maxUsersPerSession = Math.max(...Object.values(sessionUsers).map(u => u.length));

      for (let r = 0; r < maxUsersPerSession; r += usersPerRound) {
        // Check if job was cancelled
        const jobStatus = await pool.query('SELECT status FROM messaging_jobs WHERE id = $1', [jobId]);
        if (jobStatus.rows[0]?.status === 'cancelled') {
          logger.info(`Bulk users job ${jobId} cancelled at round ${r}`);
          await this._finalizeJob(jobId, 'cancelled', sentCount.value, failedCount.value, skippedCount.value, results);
          return;
        }

        // If not first round, wait for delay
        if (r > 0) {
          const delayMs = delayBetweenRounds * 1000;
          logger.info(`Waiting ${delayBetweenRounds}s before next round`, { jobId, round: r });
          await sleep(delayMs);
        }

        // Each session sends to usersPerRound users in this round
        for (const session of sessions) {
          const usersForSession = sessionUsers[session.id];
          const batchEnd = Math.min(r + usersPerRound, usersForSession.length);

          for (let u = r; u < batchEnd; u++) {
            const user = usersForSession[u];
            const userId_target = user.telegram_id || user.id;
            const result = { sessionId: session.id, userId: userId_target, success: false };

            try {
              // Send message to user
              const sendResult = await telegramService.sendMessage(
                String(session.id),
                String(userId_target),
                message
              );

              result.success = true;
              result.messageId = sendResult.messageId;
              sentCount.value++;

              // Log success
              await pool.query(
                `INSERT INTO message_logs (job_id, session_id, target_id, status, sent_at)
                 VALUES ($1, $2, $3, 'sent', NOW())`,
                [jobId, session.id, String(userId_target)]
              );

            } catch (err) {
              result.error = err.message;
              failedCount.value++;

              // Log failure
              await pool.query(
                `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
                 VALUES ($1, $2, $3, 'failed', $4, NOW())`,
                [jobId, session.id, String(userId_target), err.message]
              );

              logger.warn(`Failed to send message to user ${userId_target} from session ${session.id}: ${err.message}`);
            }

            results.push(result);

            // Update progress in Redis
            await this._notifyProgress(jobId, {
              job_id: jobId,
              status: 'running',
              total: users.length,
              sent: sentCount.value,
              failed: failedCount.value,
              skipped: skippedCount.value,
              session_id: session.id,
              user_id: userId_target,
            });
          }
        }
      }

      // Job completed
      const finalStatus = 'completed';
      await this._finalizeJob(jobId, finalStatus, sentCount.value, failedCount.value, skippedCount.value, results);

      logger.info(`Bulk users job ${jobId} completed: ${sentCount.value} sent, ${failedCount.value} failed`, {
        jobId,
      });

    } catch (outerErr) {
      logger.error(`Bulk users job ${jobId} failed: ${outerErr.message}`);
      await this._finalizeJob(jobId, 'failed', sentCount.value, failedCount.value, skippedCount.value, results);
    }
  }

  // =========================================================================
  // Single-User Mass DM
  //
  // The operator picks 1..3 target users, a message, a per-send delay,
  // and one or more sessions. Every selected session DMs every
  // target, with `delaySeconds` inserted BETWEEN consecutive sends.
  //
  // Loop shape (target-major, session-minor):
  //   for each target T:
  //     for each session S:
  //       S → DM(T, message)
  //       sleep(delaySeconds)   # except after the very last send
  //
  // The 3-target hard cap is enforced by the validator, but we
  // re-check here to keep the service safe when called directly
  // (tests, scripted callers). Cancellation is honoured at every
  // pre-send gate via `messaging_jobs.status = 'cancelled'`.
  // =========================================================================

  /**
   * Create a single-user mass-DM job.
   *
   * @param {object} params
   * @param {number[]} params.sessionIds       - Sessions to fan out from.
   * @param {string[]} params.targets          - 1..3 target identifiers
   *                                              (numeric id, @username,
   *                                              or bare username).
   * @param {string}   params.message          - Message body (<=4096).
   * @param {string}  [params.messageType]     - 'text'|'html'|'markdown'.
   * @param {number}  [params.delaySeconds=3]  - Wait between sends.
   * @param {number|string} userId             - Authorisation context.
   * @returns {Promise<{ jobId, status, total, sessionCount }>}
   */
  async sendSingleUserMassDm(params, userId) {
    const {
      sessionIds,
      message,
      messageType = 'text',
      delaySeconds = 3,
    } = params;
    const targets = Array.isArray(params.targets) ? params.targets : [];

    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }
    if (!sessionIds || sessionIds.length === 0) {
      throw new AppError('At least one session is required', 400, 'NO_SESSIONS');
    }
    if (targets.length === 0) {
      throw new AppError('At least one target is required', 400, 'NO_TARGETS');
    }
    if (targets.length > 3) {
      throw new AppError(
        'A maximum of 3 targets is allowed for single-user mass DM',
        400,
        'TOO_MANY_TARGETS'
      );
    }
    if (!message || message.trim().length === 0) {
      throw new AppError('Message is required', 400, 'EMPTY_MESSAGE');
    }
    const delaySec = Number.isFinite(Number(delaySeconds)) ? Math.max(1, Math.min(120, parseInt(delaySeconds, 10))) : 3;

    // Strip duplicates / empty strings while preserving order.
    const cleanTargets = [];
    const seen = new Set();
    for (const raw of targets) {
      const t = String(raw || '').trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleanTargets.push(t);
    }
    if (cleanTargets.length === 0) {
      throw new AppError('At least one valid target is required', 400, 'NO_VALID_TARGETS');
    }

    // Verify session ownership (and skip cooldown'd sessions).
    const verifiedSessions = await this._verifyMultipleSessionsOwnership(sessionIds, userId);
    if (verifiedSessions.length === 0) {
      throw new AppError('No valid sessions found', 404, 'NO_VALID_SESSIONS');
    }

    const totalSends = cleanTargets.length * verifiedSessions.length;

    logger.info(
      `Starting single-user mass DM: ${cleanTargets.length} target(s), ${verifiedSessions.length} session(s), ${delaySec}s delay`,
      { userId, totalSends }
    );

    // Persist the job. The schema only has a single `session_id`
    // column; mirror sendBulkToUsers and stash the full session list
    // (plus the target list and the delay knob) in `options`.
    const jobResult = await pool.query(
      `INSERT INTO messaging_jobs (
        user_id, session_id, job_type, target_list, message_content, message_type,
        status, total_count, sent_count, failed_count, skipped_count, options, created_at
      ) VALUES ($1, $2, 'single_user_mass_dm', $3, $4, $5, 'pending', $6, 0, 0, 0, $7, NOW())
      RETURNING id`,
      [
        userId,
        verifiedSessions[0].id,
        JSON.stringify(cleanTargets),
        message,
        messageType,
        totalSends,
        JSON.stringify({
          delaySeconds: delaySec,
          targetCount: cleanTargets.length,
          sessionIds: verifiedSessions.map((s) => s.id),
        }),
      ]
    );

    const jobId = jobResult.rows[0].id;

    // Fire-and-forget worker. Errors are caught inside the worker so
    // the API can return 202 immediately.
    this._processSingleUserMassDm(
      jobId,
      verifiedSessions,
      cleanTargets,
      message,
      delaySec,
      userId
    ).catch((err) => {
      logger.error(`Single-user mass DM job ${jobId} failed with error: ${err.message}`);
    });

    return {
      jobId,
      status: 'pending',
      total: totalSends,
      sessionCount: verifiedSessions.length,
      targetCount: cleanTargets.length,
      delaySeconds: delaySec,
      message: 'Job queued and will process in background',
    };
  }

  /**
   * Internal worker for single-user mass DM.
   *
   * Iterates target-major: for each target, every session sends in
   * sequence with `delaySeconds` between sends. The delay is pasted
   * between every send except the very last one (no point sleeping
   * once we're done). Cancellation is checked before each send.
   *
   * @private
   */
  async _processSingleUserMassDm(jobId, sessions, targets, message, delaySeconds, userId) { // eslint-disable-line no-unused-vars
    const sentCount = { value: 0 };
    const failedCount = { value: 0 };
    const skippedCount = { value: 0 };
    const results = [];
    const totalSends = sessions.length * targets.length;

    // Per-job dead-target cache. We mark a target as unresolvable
    // ONLY when at least two distinct *alive* sessions independently
    // confirm a target-side error (USERNAME_NOT_OCCUPIED,
    // USERNAME_INVALID, PEER_ID_INVALID, USER_ID_INVALID,
    // INPUT_USER_DEACTIVATED). Single-session "Could not resolve
    // target" used to be enough to blacklist a real handle for the
    // rest of the run — that produced the bug where a typo'd or
    // revoked session falsely doomed every remaining attempt for a
    // genuine username.
    //
    // Operator quote, verbatim:
    //   "filtering should only and only works for the lists that
    //    were uploaded manually … For other places where manual ID
    //    or usernames are entered the job must started directly
    //    without checking the filtering system."
    //
    // Single-user mass DM is a *manual entry* surface, so we keep
    // the cache disabled by default and only opt in after multiple
    // alive sessions agree the user is gone.
    const TARGET_DEAD_CONFIRMATIONS = 2;
    const deadTargets = new Set();
    const targetFailureSessions = new Map(); // target → Set<sessionId>
    // Patterns that ONLY ever come from a target-side failure — never
    // from a session-level auth issue. We deliberately drop the broad
    // "Could not resolve target" and "Could not find input entity"
    // patterns the previous classifier matched: those used to fire
    // when the *session* was dead, blaming the target.
    const isUnresolvableTargetError = (msg) => {
      if (!msg) return false;
      const m = String(msg);
      return (
        m.includes('USERNAME_NOT_OCCUPIED') ||
        m.includes('USERNAME_INVALID') ||
        m.includes('PEER_ID_INVALID') ||
        m.includes('USER_ID_INVALID') ||
        m.includes('INPUT_USER_DEACTIVATED') ||
        // GramJS' user-friendly translation of USERNAME_NOT_OCCUPIED.
        // Only matches inside our sendMessage error chain — the bare
        // "No user has X" string from gramjs internal logging never
        // makes it onto the thrown error message text we see here.
        /No user has\s+"/i.test(m)
      );
    };

    // Per-job revoked-session cache. AUTH_KEY_UNREGISTERED means the
    // account logged this session out remotely; no other request from
    // this session in this job is going to succeed. Flag the row in
    // sessions table so future jobs skip it, and exclude it from this
    // job's remaining iterations.
    const revokedSessionIds = new Set();
    const isRevokedSessionError = (msg) => {
      if (!msg) return false;
      const m = String(msg);
      return (
        m.includes('AUTH_KEY_UNREGISTERED') ||
        m.includes('AUTH_KEY_INVALID') ||
        m.includes('AUTH_KEY_DUPLICATED') ||
        m.includes('USER_DEACTIVATED') ||
        m.includes('SESSION_REVOKED') ||
        m.includes('SESSION_EXPIRED')
      );
    };

    await pool.query(
      `UPDATE messaging_jobs SET status = 'running' WHERE id = $1`,
      [jobId]
    );

    await this._notifyProgress(jobId, {
      job_id: jobId,
      status: 'running',
      total: totalSends,
      sent: 0,
      failed: 0,
      skipped: 0,
    });

    let sendsDone = 0;
    try {
      for (let ti = 0; ti < targets.length; ti++) {
        const target = targets[ti];
        for (let si = 0; si < sessions.length; si++) {
          const session = sessions[si];

          // Cancellation gate.
          const jobStatus = await pool.query(
            'SELECT status FROM messaging_jobs WHERE id = $1',
            [jobId]
          );
          if (jobStatus.rows[0]?.status === 'cancelled') {
            logger.info(`Single-user mass DM job ${jobId} cancelled`, {
              jobId, sentCount: sentCount.value, failedCount: failedCount.value,
            });
            await this._finalizeJob(
              jobId, 'cancelled',
              sentCount.value, failedCount.value, skippedCount.value, results
            );
            return;
          }

          const result = {
            sessionId: session.id,
            target: String(target),
            success: false,
          };

          // Fast-skip 1: target already proven unresolvable in this job.
          // No API call, no inter-send sleep — there's nothing for
          // Telegram to do, and waiting `delaySeconds` between
          // skipped sends just delays the rest of the job for no gain.
          if (deadTargets.has(String(target))) {
            result.skipped = true;
            result.error = 'Target unresolvable (cached from earlier session in this job)';
            skippedCount.value++;
            await pool.query(
              `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
               VALUES ($1, $2, $3, 'skipped', $4, NOW())`,
              [jobId, session.id, String(target), result.error]
            );
            results.push(result);
            sendsDone++;

            await pool.query(
              `UPDATE messaging_jobs
                  SET sent_count = $1, failed_count = $2, skipped_count = $3
                WHERE id = $4`,
              [sentCount.value, failedCount.value, skippedCount.value, jobId]
            );
            await this._notifyProgress(jobId, {
              job_id: jobId,
              status: 'running',
              total: totalSends,
              sent: sentCount.value,
              failed: failedCount.value,
              skipped: skippedCount.value,
              session_id: session.id,
              target: String(target),
            });
            continue; // No sleep
          }

          // Fast-skip 2: session already proven revoked in this job.
          if (revokedSessionIds.has(session.id)) {
            result.skipped = true;
            result.error = 'Session revoked (cached from earlier failure in this job)';
            skippedCount.value++;
            await pool.query(
              `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
               VALUES ($1, $2, $3, 'skipped', $4, NOW())`,
              [jobId, session.id, String(target), result.error]
            );
            results.push(result);
            sendsDone++;
            await this._notifyProgress(jobId, {
              job_id: jobId,
              status: 'running',
              total: totalSends,
              sent: sentCount.value,
              failed: failedCount.value,
              skipped: skippedCount.value,
              session_id: session.id,
              target: String(target),
            });
            continue; // No sleep
          }

          try {
            const sendResult = await telegramService.sendMessage(
              String(session.id),
              String(target),
              message
            );
            result.success = true;
            result.messageId = sendResult.messageId;
            sentCount.value++;

            await pool.query(
              `INSERT INTO message_logs (job_id, session_id, target_id, status, sent_at)
               VALUES ($1, $2, $3, 'sent', NOW())`,
              [jobId, session.id, String(target)]
            );
          } catch (err) {
            result.error = err.message;
            failedCount.value++;
            await pool.query(
              `INSERT INTO message_logs (job_id, session_id, target_id, status, error_message, sent_at)
               VALUES ($1, $2, $3, 'failed', $4, NOW())`,
              [jobId, session.id, String(target), err.message]
            );
            logger.warn(
              `Single-user mass DM: session ${session.id} → ${target} failed: ${err.message}`,
              { jobId }
            );

            // Cache classification updates so the rest of the job
            // doesn't repeat doomed work.
            const sessionLooksRevoked = isRevokedSessionError(err.message);
            if (isUnresolvableTargetError(err.message) && !sessionLooksRevoked) {
              // Only count target-side failures from sessions that
              // are NOT themselves revoked. A revoked session's
              // resolve attempts can't be trusted — every call from
              // a dead auth_key fails, but the failure says nothing
              // about whether the *target* exists. Without this
              // gate, one bad session in a 50-session run was enough
              // to blacklist a real, healthy username for the
              // remaining 49 sessions.
              const targetKey = String(target);
              let confirmers = targetFailureSessions.get(targetKey);
              if (!confirmers) {
                confirmers = new Set();
                targetFailureSessions.set(targetKey, confirmers);
              }
              confirmers.add(session.id);
              if (confirmers.size >= TARGET_DEAD_CONFIRMATIONS) {
                deadTargets.add(targetKey);
                logger.info(
                  `Single-user mass DM job ${jobId}: target ${target} marked unresolvable after ${confirmers.size} alive-session confirmations; remaining ${sessions.length - si - 1} session(s) for this target will skip without burning resolve requests`,
                  { jobId }
                );
              } else {
                logger.info(
                  `Single-user mass DM job ${jobId}: session ${session.id} reported target ${target} unresolvable (${confirmers.size}/${TARGET_DEAD_CONFIRMATIONS} confirmations); will retry from other sessions`,
                  { jobId }
                );
              }
            }
            if (sessionLooksRevoked) {
              revokedSessionIds.add(session.id);
              // Mark the session row revoked so future jobs skip it
              // entirely — best-effort, don't fail the job if the
              // update can't run.
              try {
                await pool.query(
                  `UPDATE sessions
                      SET status = 'revoked', is_logged_in = FALSE, updated_at = NOW()
                    WHERE id = $1 AND user_id = $2`,
                  [session.id, userId]
                );
                logger.warn(
                  `Single-user mass DM job ${jobId}: session ${session.id} revoked (AUTH_KEY_UNREGISTERED); flagged in DB`,
                  { jobId }
                );
              } catch (markErr) {
                logger.warn(
                  `Failed to flag revoked session ${session.id}: ${markErr.message}`,
                  { jobId }
                );
              }
            }
          }

          results.push(result);
          sendsDone++;

          await pool.query(
            `UPDATE messaging_jobs
                SET sent_count = $1, failed_count = $2, skipped_count = $3
              WHERE id = $4`,
            [sentCount.value, failedCount.value, skippedCount.value, jobId]
          );

          await this._notifyProgress(jobId, {
            job_id: jobId,
            status: 'running',
            total: totalSends,
            sent: sentCount.value,
            failed: failedCount.value,
            skipped: skippedCount.value,
            session_id: session.id,
            target: String(target),
          });

          // Pause between consecutive sends. Skip the sleep after
          // the very last send — nothing else is going to fire.
          if (sendsDone < totalSends && delaySeconds > 0) {
            await sleep(delaySeconds * 1000);
          }
        }
      }

      await this._finalizeJob(
        jobId, 'completed',
        sentCount.value, failedCount.value, skippedCount.value, results
      );

      logger.info(
        `Single-user mass DM job ${jobId} completed: ${sentCount.value} sent, ${failedCount.value} failed`,
        { jobId }
      );
    } catch (outerErr) {
      logger.error(`Single-user mass DM job ${jobId} failed: ${outerErr.message}`);
      await this._finalizeJob(
        jobId, 'failed',
        sentCount.value, failedCount.value, skippedCount.value, results
      );
    }
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  /**
   * Verify that a session belongs to the specified user.
   *
   * @param {string|number} sessionId - Session database ID
   * @param {number|string} userId - User ID
   * @returns {Promise<{ id: number, user_id: number, status: string }>}
   * @private
   */
  async _verifySessionOwnership(sessionId, userId) {
    const result = await pool.query(
      'SELECT id, user_id, status FROM sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId]
    );

    if (result.rows.length === 0) {
      throw new AppError('Session not found or access denied', 404, 'SESSION_NOT_FOUND');
    }

    return result.rows[0];
  }

  /**
   * Verify that multiple sessions belong to the specified user.
   *
   * Sessions that are on cooldown (`cooldown_until` in the future)
   * are filtered out of the returned set unless the caller passes
   * `{ filterCooldown: false }`. This mirrors
   * `groupService.validateSessionsOwnership` so PEER_FLOOD /
   * FLOOD_WAIT cooldowns observed by the worker propagate to bulk
   * messaging too.
   *
   * The dropped sessions are attached to the returned array as a
   * non-enumerable `cooldownSkipped` property — callers that want to
   * surface the skipped count can read it without a signature change.
   * If every requested session is on cooldown, throws
   * `ALL_SESSIONS_ON_COOLDOWN` (409).
   *
   * @param {Array<string|number>} sessionIds - Array of session IDs
   * @param {number|string} userId - User ID
   * @param {{ filterCooldown?: boolean }} [opts]
   * @returns {Promise<Array<{ id: number, user_id: number, status: string }>>}
   * @private
   */
  async _verifyMultipleSessionsOwnership(sessionIds, userId, opts = {}) {
    if (!sessionIds || sessionIds.length === 0) return [];
    const { filterCooldown = true } = opts;

    let result;
    try {
      result = await pool.query(
        `SELECT id, user_id, status,
                cooldown_until, cooldown_reason, cooldown_seconds, cooldown_set_at
           FROM sessions
          WHERE id = ANY($1::int[]) AND user_id = $2`,
        [sessionIds.map((s) => parseInt(s, 10)), userId]
      );
    } catch (selErr) {
      // Columns absent on an upgrading deploy → fall back so the
      // bulk-message API doesn't 500 before the migration runs.
      logger.warn(
        `_verifyMultipleSessionsOwnership: cooldown columns missing, falling back: ${selErr.message}`
      );
      result = await pool.query(
        'SELECT id, user_id, status FROM sessions WHERE id = ANY($1::int[]) AND user_id = $2',
        [sessionIds.map((s) => parseInt(s, 10)), userId]
      );
    }

    if (!filterCooldown) return result.rows;

    const now = Date.now();
    const eligible = [];
    const skipped = [];
    for (const row of result.rows) {
      const cdAt = row.cooldown_until ? new Date(row.cooldown_until).getTime() : 0;
      if (cdAt > now) {
        skipped.push({
          id: row.id,
          cooldown_until: row.cooldown_until,
          remaining_seconds: Math.max(0, Math.ceil((cdAt - now) / 1000)),
          reason: row.cooldown_reason || null,
        });
      } else {
        eligible.push(row);
      }
    }

    if (eligible.length === 0 && skipped.length > 0) {
      const err = new AppError(
        `All ${skipped.length} requested session(s) are on cooldown`,
        409,
        'ALL_SESSIONS_ON_COOLDOWN'
      );
      err.cooldownSkipped = skipped;
      throw err;
    }

    if (skipped.length > 0) {
      logger.warn(
        `_verifyMultipleSessionsOwnership: ${skipped.length} session(s) skipped due to cooldown`,
        { userId, skipped }
      );
      Object.defineProperty(eligible, 'cooldownSkipped', {
        value: skipped,
        enumerable: false,
      });
    }

    return eligible;
  }

  /**
   * Send progress notification via Redis for WebSocket broadcast.
   */
  async _notifyProgress(jobId, data) {
    try {
      if (redisClient.isReady) {
        const key = `message:progress:${jobId}`;
        await redisClient.set(key, JSON.stringify(data), { EX: PROGRESS_TTL });
      }
    } catch (err) {
      logger.error(`Failed to notify progress for job ${jobId}`, { error: err.message });
    }
  }

  /**
   * Finalize a messaging job with final status and counts.
   *
   * NOTE: `messaging_jobs` does not have a `results` column. Per-target
   * outcomes are persisted to `message_logs` as the job runs, so we
   * deliberately do not try to write the in-memory `results` array
   * here — doing so previously made the bulk-groups / bulk-users jobs
   * silently fail at the end with `column "results" does not exist`.
   */
  async _finalizeJob(jobId, status, sentCount, failedCount, skippedCount, results) { // eslint-disable-line no-unused-vars
    try {
      await pool.query(
        `UPDATE messaging_jobs
         SET status = $1, sent_count = $2, failed_count = $3, skipped_count = $4,
             completed_at = NOW()
         WHERE id = $5`,
        [status, sentCount, failedCount, skippedCount, jobId]
      );

      // Notify completion via Redis
      await this._notifyProgress(jobId, {
        job_id: jobId,
        status,
        sent: sentCount,
        failed: failedCount,
        skipped: skippedCount,
      });
    } catch (err) {
      logger.error(`Failed to finalize job ${jobId}`, { error: err.message });
    }
  }
}

// =========================================================================
// Export
// =========================================================================

module.exports = new MessageService();

// Internal helpers exposed for unit/smoke tests. Not part of the public
// service API — prefer the singleton above.
module.exports.__internal = {
  normalizeTargetId,
  isRetryableError,
};
