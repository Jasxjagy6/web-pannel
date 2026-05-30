/**
 * ScrapeService - Institutional-grade multi-session, multi-target scraping system
 * 
 * Features:
 * - Multi-session load balancing with health tracking
 * - Multi-target (groups/channels) simultaneous scraping
 * - Queue-based architecture (BullMQ default)
 * - Comprehensive bot filtering with composite scoring
 * - Real-time progress tracking via Redis + WebSocket
 * - Async export generation with filters
 * - Flood wait intelligence and adaptive rate limiting
 * - Cross-job deduplication
 * - Cancellation support for queue jobs
 */

const { pool } = require('../config/database');
const tgService = require('./telegramService');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const { buildPagination, applyPagination, applySorting } = require('../utils/pagination');
const { redisClient } = require('../config/redis');
const { filterBots, calculateBotScore } = require('../utils/botDetector');
// scrapeQueue is loaded at the bottom of this file after the class is defined
let scrapeQueue; // Will be set during module initialization

// ============================================================================
// CONSTANTS
// ============================================================================

const TELEGRAM_BATCH_SIZE = 200;
const DB_BATCH_SIZE = 500;
const INITIAL_BATCH_DELAY_MS = 800;
const MIN_BATCH_DELAY_MS = 500;
const MAX_BATCH_DELAY_MS = 5000;
const FLOOD_WAIT_MULTIPLIER = 1.5;
const REDIS_PROGRESS_TTL = 86400;
const MAX_CONCURRENT_JOBS_PER_USER = 5;
const MAX_SESSIONS_PER_JOB = 10;
const MAX_TARGETS_PER_JOB = 50;
const VALID_JOB_STATUSES = ['pending', 'running', 'completed', 'cancelled', 'failed'];
const TARGET_TYPES = { GROUP: 'group', CHANNEL: 'channel' };

// In-memory tracking for active jobs
const activeJobs = new Map();
const sessionLoadBalance = new Map(); // sessionId -> { jobs: number, lastFloodWait: number }

// ============================================================================
// SCRAPE SERVICE CLASS
// ============================================================================

class ScrapeService {
  constructor() {
    this._progressTrackers = new Map();
  }

  // ============================================================================
  // JOB CREATION - MULTI-SESSION, MULTI-TARGET
  // ============================================================================

  /**
   * Create a new scraping job with support for multiple sessions and targets.
   * 
   * @param {object} params
   * @param {number[]} params.sessionIds - Array of session IDs to use
   * @param {string[]} params.targetIds - Array of group/channel IDs
   * @param {string} params.targetType - 'group' or 'channel'
   * @param {number} params.limit - Max users per target
   * @param {object} params.options - Scraping options
   * @param {number} params.userId - User creating the job
   * @returns {object} Created job info
   */
  async createScrapeJob({ sessionIds, targetIds, targetType, limit, options = {}, userId }) {
    // Validate inputs
    if (!sessionIds || sessionIds.length === 0) {
      throw new AppError('At least one session ID is required', 400, 'NO_SESSIONS');
    }
    if (sessionIds.length > MAX_SESSIONS_PER_JOB) {
      throw new AppError(`Maximum ${MAX_SESSIONS_PER_JOB} sessions per job`, 400, 'TOO_MANY_SESSIONS');
    }
    if (!targetIds || targetIds.length === 0) {
      throw new AppError('At least one target ID is required', 400, 'NO_TARGETS');
    }
    if (targetIds.length > MAX_TARGETS_PER_JOB) {
      throw new AppError(`Maximum ${MAX_TARGETS_PER_JOB} targets per job`, 400, 'TOO_MANY_TARGETS');
    }
    if (!VALID_JOB_STATUSES.includes(options.status || 'pending')) {
      throw new AppError('Invalid job status', 400, 'INVALID_STATUS');
    }

    // Check concurrent job limit
    const runningJobs = await this._getRunningJobCount(userId);
    if (runningJobs >= MAX_CONCURRENT_JOBS_PER_USER) {
      throw new AppError(
        `Maximum ${MAX_CONCURRENT_JOBS_PER_USER} concurrent jobs allowed. Wait for jobs to complete.`,
        429,
        'TOO_MANY_JOBS'
      );
    }

    // Validate sessions are active
    const validSessions = await this._validateSessions(sessionIds, userId);
    
    // Determine job mode
    let jobMode = 'single';
    if (sessionIds.length > 1) jobMode = 'multi-session';
    if (targetIds.length > 1) jobMode = jobMode === 'single' ? 'multi-target' : 'multi-session-multi-target';

    // Create job in database
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO scraping_jobs (
          session_id, session_ids, target_type, target_id, target_ids,
          status, options, job_mode, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING id`,
        [
          sessionIds[0], // Primary session (for backwards compatibility)
          sessionIds, // Array of all sessions
          targetType,
          targetIds[0], // Primary target
          targetIds, // Array of all targets
          'pending',
          JSON.stringify({
            limit: limit || 50000,
            // Aggressive alphabetical search sweep (Phase B) is on by default
            // so large channels/supergroups yield thousands rather than just
            // the first recent page. Callers can disable it for quick runs.
            deepSweep: options.deepSweep !== false,
            filterBots: options.filterBots !== false,
            botFilterOptions: options.botFilterOptions || {},
            saveToList: options.saveToList || false,
            listName: options.listName || null,
            interGroupDelay: options.interGroupDelay || 5,
            floodProtection: options.floodProtection !== false,
          }),
          jobMode,
        ]
      );

      const jobId = result.rows[0].id;

      // Initialize progress tracking
      await this._initializeProgress(jobId, {
        totalTargets: targetIds.length,
        totalSessions: sessionIds.length,
        limit: limit || 1000,
        status: 'pending',
        progress: 0,
        totalFound: 0,
        currentTarget: null,
        currentSession: null,
        startTime: null,
        endTime: null,
        stats: {
          totalFound: 0,
          newUsers: 0,
          duplicates: 0,
          botsFiltered: 0,
          errors: 0,
        },
      });

      await client.query('COMMIT');

      logger.info(`Scrape job created`, {
        jobId,
        userId,
        sessionCount: sessionIds.length,
        targetCount: targetIds.length,
        jobMode,
      });

      return {
        jobId,
        status: 'pending',
        jobMode,
        sessionCount: sessionIds.length,
        targetCount: targetIds.length,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Start a scraping job (executes immediately or queues).
   * 
   * @param {number} jobId 
   * @param {boolean} async - Whether to run async (default true)
   * @returns {object} Job status
   */
  async startScrapeJob(jobId, async = true) {
    logger.info(`startScrapeJob called`, { jobId, async });
    const job = await this._getJob(jobId);
    logger.info(`Job retrieved`, { jobId, status: job?.status });
    if (!job) {
      throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    }
    if (job.status !== 'pending') {
      throw new AppError(`Job cannot be started (current status: ${job.status})`, 400, 'INVALID_JOB_STATE');
    }

    if (async) {
      logger.info(`Adding to queue`, { jobId });
      const queueJob = await scrapeQueue.addJob({ jobId, userId: job.user_id });
      logger.info(`Queue job added`, { jobId, queueJobId: queueJob.id });

      await this._updateProgress(jobId, { status: 'queued', queueJobId: queueJob.id });

      logger.info(`Job queued`, { jobId, queueJobId: queueJob.id });

      return { jobId, status: 'queued', queueJobId: queueJob.id };
    } else {
      // Execute immediately (sync)
      return await this._executeScrapeJob(jobId);
    }
  }

  // ============================================================================
  // JOB EXECUTION - CORE LOGIC
  // ============================================================================

  /**
   * Execute a scraping job.
   * 
   * @param {number} jobId 
   * @returns {object} Job results
   */
  async _executeScrapeJob(jobId) {
    const startTime = Date.now();
    const job = await this._getJob(jobId);
    const options = job.options || {};
    const sessionIds = job.session_ids || [job.session_id];
    const targetIds = job.target_ids || [job.target_id];

    // Mark as running
    await this._updateJobStatus(jobId, 'running');
    await this._updateProgress(jobId, {
      status: 'running',
      startTime: new Date().toISOString(),
    });

    // Track as active
    activeJobs.set(jobId, { cancelled: false, floodWaitUntil: null });

    const results = {
      totalFound: 0,
      newUsers: 0,
      duplicates: 0,
      botsFiltered: 0,
      errors: 0,
      targetsCompleted: 0,
      targetResults: [], // Track per-target results
    };

    try {
      // Iterate through targets
      for (let targetIdx = 0; targetIdx < targetIds.length; targetIdx++) {
        const targetId = targetIds[targetIdx];
        
        // Check cancellation
        if (this._isCancelled(jobId)) {
          await this._updateJobStatus(jobId, 'cancelled');
          break;
        }

        await this._updateProgress(jobId, {
          currentTarget: targetId,
          targetsCompleted: targetIdx,
        });

        // Select best session (load balancing)
        const sessionId = this._selectBestSession(sessionIds);

        try {
          // Anti-revoke Phase 3 (B17): refuse to use a session whose
          // anti-revoke risk score exceeds the configured threshold.
          // The session stays alive — we just don't add fuel to the
          // fire by hammering it with another scrape job.
          try {
            const cfg = require('../config/telegram');
            if (cfg.ANTI_REVOKE_PHASE_3_ENABLED) {
              const tgRisk = require('../providers/telegram/riskScore');
              await tgRisk.gateOnRisk(sessionId);
            }
          } catch (gateErr) {
            if (gateErr && gateErr.code === 'RISK_TOO_HIGH') {
              logger.warn(
                `Scrape job ${jobId} skipping target ${targetId}: ` +
                `session ${sessionId} risk_score=${(gateErr.riskScore || 0).toFixed(3)}`
              );
              results.errors++;
              results.targetsCompleted++;
              results.targetResults.push({
                target: targetId,
                status: 'skipped_risk_too_high',
                error: gateErr.message,
                riskScore: gateErr.riskScore,
                usersFound: 0,
              });
              await this._updateProgress(jobId, {
                errors: results.errors,
                lastError: gateErr.message,
              });
              continue;
            }
            // Non-RISK_TOO_HIGH errors fall through to normal handling.
            throw gateErr;
          }

          // Scrape the target
          const scrapeResult = await this._scrapeTarget(
            sessionId,
            targetId,
            job.target_type,
            options,
            jobId
          );

          results.totalFound += scrapeResult.totalFound;
          results.newUsers += scrapeResult.newUsers;
          results.duplicates += scrapeResult.duplicates;
          results.botsFiltered += scrapeResult.botsFiltered;
          results.errors += scrapeResult.errors;
          results.targetsCompleted++;
          
          // Track per-target result
          results.targetResults.push({
            target: targetId,
            status: 'success',
            usersFound: scrapeResult.totalFound,
            usersSaved: scrapeResult.newUsers,
          });

          // Update progress
          await this._updateProgress(jobId, {
            totalFound: results.totalFound,
            targetsCompleted: results.targetsCompleted,
            progress: Math.round((results.targetsCompleted / targetIds.length) * 100),
          });

          // Adaptive delay between targets
          if (targetIdx < targetIds.length - 1) {
            const delay = (options.interGroupDelay || 5) * 1000;
            await this._delayWithCancellation(jobId, delay);
          }
        } catch (error) {
          logger.error(`Target scraping failed: ${targetId}`, { error: error.message });
          results.errors++;
          results.targetsCompleted++;
          
          // Track per-target failure
          results.targetResults.push({
            target: targetId,
            status: 'failed',
            error: error.message,
            usersFound: 0,
          });
          
          await this._updateProgress(jobId, {
            errors: results.errors,
            lastError: error.message,
          });
        }
      }

      // Finalize
      const endTime = Date.now();
      const finalStatus = this._isCancelled(jobId) ? 'cancelled' : (results.errors > 0 ? 'completed_with_errors' : 'completed');
      
      await this._updateJobStatus(jobId, finalStatus, {
        targetResults: results.targetResults,
        // History page uses scraping_jobs.total_found for the "Users"
        // column — make it equal to the rows actually persisted so the
        // headline number matches the export contents.
        totalFound: results.newUsers,
      });
      await this._updateProgress(jobId, {
        status: finalStatus,
        endTime: new Date().toISOString(),
        progress: 100,
        duration: endTime - startTime,
        targetResults: results.targetResults, // Save per-target results
      });

      // Save to list if requested
      if (options.saveToList) {
        await this._saveToList(jobId, options.listName);
      }

      activeJobs.delete(jobId);

      return {
        jobId,
        status: finalStatus,
        results,
        duration: endTime - startTime,
      };
    } catch (error) {
      await this._updateJobStatus(jobId, 'failed');
      await this._updateProgress(jobId, {
        status: 'failed',
        endTime: new Date().toISOString(),
        lastError: error.message,
      });
      
      activeJobs.delete(jobId);
      throw error;
    }
  }

  /**
   * Scrape a single target (group or channel).
   *
   * Delegates to telegramService.scrapeMembers(), which auto-detects the
   * target type (basic group / supergroup / broadcast channel), paginates with
   * a real advancing offset, and — for channels/supergroups — runs an
   * aggressive alphabetical search sweep to break past Telegram's per-filter
   * enumeration cap. Members stream back through `onBatch`; we bot-filter,
   * persist, and publish live progress per batch. FLOOD_WAIT / SLOWMODE /
   * PEER_FLOOD are handled inside telegramService._withFloodRetry.
   */
  async _scrapeTarget(sessionId, targetId, targetType, options, jobId) {
    const results = { totalFound: 0, newUsers: 0, duplicates: 0, botsFiltered: 0, errors: 0 };

    const limit = Number(options.limit) > 0 ? Number(options.limit) : 50000;
    const deepSweep = options.deepSweep !== false;
    const batchDelayMs = options.floodProtection !== false ? INITIAL_BATCH_DELAY_MS : 0;

    const onBatch = async (members) => {
      if (!members || members.length === 0) return;
      results.totalFound += members.length;

      // Comprehensive bot filtering (the scraper does its own scoring rather
      // than relying on Telegram's coarse `bot` flag).
      const filteredUsers = options.filterBots !== false
        ? filterBots(members, options.botFilterOptions || {})
        : members.map((u) => ({ ...u, botScore: 0, botFlags: [] }));
      results.botsFiltered += members.length - filteredUsers.length;

      const insertResult = await this._insertUsersBatch(jobId, filteredUsers);
      results.newUsers += insertResult.inserted;
      results.duplicates += insertResult.duplicates;

      await this._updateProgress(jobId, {
        totalFound: results.totalFound,
        currentCount: results.newUsers,
      });
    };

    try {
      await tgService.scrapeMembers(sessionId, targetId, {
        limit,
        deepSweep,
        batchDelayMs,
        onBatch,
        shouldStop: () => this._isCancelled(jobId),
      });
    } catch (error) {
      // If Telegram returned a permanent auth error, flag the session as
      // revoked so future jobs skip it and the Sessions UI updates.
      try {
        const sessionService = require('./sessionService');
        sessionService
          .maybeFlagRevoked(sessionId, error, `scrapeService.${targetType}`)
          .catch(() => {});
      } catch (_) { /* defensive — should never fire */ }
      throw error;
    }

    return results;
  }

  /**
   * Legacy per-batch scrape loop, retained for reference / fallback. No longer
   * used by _scrapeTarget (which now streams via telegramService.scrapeMembers).
   */
  async _scrapeTargetLegacy(sessionId, targetId, targetType, options, jobId) {
    const results = { totalFound: 0, newUsers: 0, duplicates: 0, botsFiltered: 0, errors: 0 };
    let delay = options.floodProtection !== false ? INITIAL_BATCH_DELAY_MS : 0;

    if (targetType === TARGET_TYPES.GROUP) {
      // Scrape group members
      logger.info(`Scraping group ${targetId} with session ${sessionId}`);
      let offset = 0;
      let hasMore = true;
      let consecutiveFloodWaits = 0;

      while (hasMore && !this._isCancelled(jobId)) {
        try {
          // Wait for flood protection
          if (delay > 0) {
            await this._delayWithCancellation(jobId, delay);
          }

          const members = await tgService.getGroupMembers(sessionId, targetId, {
            limit: TELEGRAM_BATCH_SIZE,
            offset,
            filterBots: false, // We do our own comprehensive filtering
          });

          if (!members || members.length === 0) {
            hasMore = false;
            break;
          }

          offset += members.length;
          results.totalFound += members.length;

          // Apply comprehensive bot filtering
          const filteredUsers = options.filterBots !== false
            ? filterBots(members, options.botFilterOptions || {})
            : members.map(u => ({ ...u, botScore: 0, botFlags: [] }));

          results.botsFiltered += members.length - filteredUsers.length;

          // Save to database
          const insertResult = await this._insertUsersBatch(jobId, filteredUsers);
          results.newUsers += insertResult.inserted;
          results.duplicates += insertResult.duplicates;

          // Adaptive rate limiting
          if (options.floodProtection !== false) {
            consecutiveFloodWaits = 0;
            delay = Math.max(MIN_BATCH_DELAY_MS, delay * 0.9); // Gradually decrease
          }

          // Update progress
          await this._updateProgress(jobId, {
            totalFound: results.totalFound,
            currentCount: offset,
          });

          if (members.length < TELEGRAM_BATCH_SIZE) {
            hasMore = false;
          }

          // Check limit
          if (options.limit && offset >= options.limit) {
            hasMore = false;
          }
        } catch (error) {
          if (error.message.includes('FLOOD_WAIT')) {
            const match = error.message.match(/(\d+)/);
            const waitSeconds = match ? parseInt(match[1]) : 30;
            
            consecutiveFloodWaits++;
            delay = Math.min(MAX_BATCH_DELAY_MS, waitSeconds * 1000 * FLOOD_WAIT_MULTIPLIER);
            
            logger.warn(`Flood wait detected, delaying ${delay}ms`, { waitSeconds, consecutiveFloodWaits });
            
            await this._updateProgress(jobId, {
              floodWaitRemaining: waitSeconds,
              lastError: `Flood wait: ${waitSeconds}s`,
            });

            // Wait out the flood wait
            await this._delayWithCancellation(jobId, waitSeconds * 1000);
          } else {
            // If Telegram returned a permanent auth error, flag the
            // session as revoked so future jobs skip it and the
            // Sessions UI updates immediately.
            try {
              const sessionService = require('./sessionService');
              sessionService
                .maybeFlagRevoked(sessionId, error, 'scrapeService.group')
                .catch(() => {});
            } catch (_) { /* defensive — should never fire */ }
            throw error;
          }
        }
      }
    } else if (targetType === TARGET_TYPES.CHANNEL) {
      // Scrape channel subscribers
      let offset = 0;
      let hasMore = true;

      while (hasMore && !this._isCancelled(jobId)) {
        try {
          if (delay > 0) {
            await this._delayWithCancellation(jobId, delay);
          }

          const subscribers = await tgService.getChannelSubscribers(sessionId, targetId, {
            limit: TELEGRAM_BATCH_SIZE,
            offset,
          });

          if (!subscribers || subscribers.length === 0) {
            hasMore = false;
            break;
          }

          offset += subscribers.length;
          results.totalFound += subscribers.length;

          // Apply bot filtering to channel subscribers
          const filteredUsers = options.filterBots !== false
            ? filterBots(subscribers, options.botFilterOptions || {})
            : subscribers.map(u => ({ ...u, botScore: 0, botFlags: [] }));

          results.botsFiltered += subscribers.length - filteredUsers.length;

          const insertResult = await this._insertUsersBatch(jobId, filteredUsers);
          results.newUsers += insertResult.inserted;
          results.duplicates += insertResult.duplicates;

          await this._updateProgress(jobId, {
            totalFound: results.totalFound,
            currentCount: offset,
          });

          if (subscribers.length < TELEGRAM_BATCH_SIZE) {
            hasMore = false;
          }

          if (options.limit && offset >= options.limit) {
            hasMore = false;
          }
        } catch (error) {
          if (error.message.includes('FLOOD_WAIT')) {
            const match = error.message.match(/(\d+)/);
            const waitSeconds = match ? parseInt(match[1]) : 30;
            delay = Math.min(MAX_BATCH_DELAY_MS, waitSeconds * 1000 * FLOOD_WAIT_MULTIPLIER);
            await this._delayWithCancellation(jobId, waitSeconds * 1000);
          } else {
            try {
              const sessionService = require('./sessionService');
              sessionService
                .maybeFlagRevoked(sessionId, error, 'scrapeService.channel')
                .catch(() => {});
            } catch (_) { /* defensive */ }
            throw error;
          }
        }
      }
    }

    return results;
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  _isCancelled(jobId) {
    const job = activeJobs.get(jobId);
    return job && job.cancelled;
  }

  async _delayWithCancellation(jobId, ms) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (this._isCancelled(jobId)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  _selectBestSession(sessionIds) {
    // Simple round-robin with load tracking
    let bestSession = sessionIds[0];
    let minLoad = Infinity;

    for (const sid of sessionIds) {
      const load = sessionLoadBalance.get(sid) || { jobs: 0, lastFloodWait: 0 };
      const score = load.jobs + (load.lastFloodWait / 10);
      if (score < minLoad) {
        minLoad = score;
        bestSession = sid;
      }
    }

    // Increment load
    const current = sessionLoadBalance.get(bestSession) || { jobs: 0, lastFloodWait: 0 };
    sessionLoadBalance.set(bestSession, { ...current, jobs: current.jobs + 1 });

    return bestSession;
  }

  async _validateSessions(sessionIds, userId) {
    const result = await pool.query(
      `SELECT id, status, is_logged_in, rate_limit_until FROM sessions
       WHERE id = ANY($1::int[]) AND user_id = $2`,
      [sessionIds, userId]
    );

    if (result.rows.length !== sessionIds.length) {
      throw new AppError('Some sessions not found or access denied', 400, 'INVALID_SESSIONS');
    }

    for (const session of result.rows) {
      if (!session.is_logged_in || session.status !== 'active') {
        throw new AppError(`Session ${session.id} is not active`, 400, 'SESSION_NOT_ACTIVE');
      }
      if (session.rate_limit_until && new Date(session.rate_limit_until) > new Date()) {
        throw new AppError(`Session ${session.id} is rate limited`, 429, 'SESSION_RATE_LIMITED');
      }
    }

    return result.rows;
  }

  async _getRunningJobCount(userId) {
    const result = await pool.query(
      `SELECT COUNT(*) FROM scraping_jobs j
       JOIN sessions s ON j.session_id = s.id
       WHERE s.user_id = $1 AND j.status IN ('running', 'pending', 'queued')`,
      [userId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  async _getJob(jobId) {
    const id = parseInt(jobId, 10);
    const result = await pool.query('SELECT * FROM scraping_jobs WHERE id = $1', [id]);
    const job = result.rows[0];
    if (job && job.options) {
      job.options = typeof job.options === 'string' ? JSON.parse(job.options) : job.options;
    }
    return job;
  }

  async _updateJobStatus(jobId, status, extraData = {}) {
    const id = parseInt(jobId, 10);
    const now = ['completed', 'failed', 'cancelled', 'completed_with_errors'].includes(status);
    
    // If there are target results, save them to stats and update total_found and progress
    if (extraData.targetResults && extraData.targetResults.length > 0) {
      const totalFound = extraData.totalFound || 0;
      const progress = extraData.progress || 100;
      await pool.query(
        `UPDATE scraping_jobs SET status = $1,
         completed_at = CASE WHEN $2 THEN NOW() ELSE completed_at END,
         total_found = $3,
         progress = $4,
         stats = jsonb_set(stats, '{targetResults}', $5::jsonb)
         WHERE id = $6`,
        [status, now, totalFound, progress, JSON.stringify(extraData.targetResults), id]
      );
    } else {
      const totalFound = extraData.totalFound || 0;
      const progress = extraData.progress || (status === 'completed' ? 100 : 0);
      await pool.query(
        `UPDATE scraping_jobs SET status = $1,
         completed_at = CASE WHEN $2 THEN NOW() ELSE completed_at END,
         total_found = $3,
         progress = $4
         WHERE id = $5`,
        [status, now, totalFound, progress, id]
      );
    }
  }

  async _initializeProgress(jobId, data) {
    await redisClient.set(`scrape:${jobId}:progress`, JSON.stringify(data), { EX: REDIS_PROGRESS_TTL });
  }

  async _updateProgress(jobId, data) {
    const existing = await redisClient.get(`scrape:${jobId}:progress`);
    const progress = existing ? JSON.parse(existing) : {};
    Object.assign(progress, data);
    await redisClient.set(`scrape:${jobId}:progress`, JSON.stringify(progress), { EX: REDIS_PROGRESS_TTL });

    // Also update database for UI display
    const id = parseInt(jobId, 10);
    const updateFields = [];
    const queryParams = [];
    let paramIdx = 1;
    
    if (data.totalFound !== undefined) {
      updateFields.push(`total_found = $${paramIdx}`);
      queryParams.push(data.totalFound);
      paramIdx++;
    }
    if (data.progress !== undefined) {
      updateFields.push(`progress = $${paramIdx}`);
      queryParams.push(data.progress);
      paramIdx++;
    }
    if (data.status !== undefined) {
      updateFields.push(`status = $${paramIdx}`);
      queryParams.push(data.status);
      paramIdx++;
    }
    
    if (updateFields.length > 0) {
      updateFields.push(`id = $${paramIdx}`);
      queryParams.push(id);
      await pool.query(
        `UPDATE scraping_jobs SET ${updateFields.join(', ')} WHERE id = $${paramIdx}`,
        queryParams
      );
    }

    // Emit WebSocket event
    if (global.io) {
      global.io.emit('scrape_progress', { jobId, ...progress });
    }
  }

  async _insertUsersBatch(jobId, users) {
    if (!users || users.length === 0) return { inserted: 0, duplicates: 0 };

    const jobIdInt = parseInt(jobId, 10);
    let inserted = 0;
    let duplicates = 0;

    // v19: widened the row from 12 columns to 24 so scrape exports get
    // every User flag we can read off the GramJS object — see
    // normalizeParticipant() in telegramService.js for the full list.
    const COLS_PER_ROW = 24;

    for (let i = 0; i < users.length; i += DB_BATCH_SIZE) {
      const batch = users.slice(i, i + DB_BATCH_SIZE);

      const values = [];
      const placeholders = [];

      batch.forEach((user, idx) => {
        const base = idx * COLS_PER_ROW;
        const pks = [];
        for (let k = 1; k <= COLS_PER_ROW; k += 1) pks.push(`$${base + k}`);
        placeholders.push(`(${pks.join(', ')})`);

        const lastSeen = user.lastSeenAt ? new Date(user.lastSeenAt) : null;
        values.push(
          jobIdInt,                                                 // job_id
          user.telegramId || user.id,                               // telegram_id
          user.username || null,                                    // username
          user.firstName || null,                                   // first_name
          user.lastName || null,                                    // last_name
          user.phone || null,                                       // phone
          user.isBot || false,                                      // is_bot
          user.isPremium || false,                                  // is_premium
          user.accessHash || null,                                  // access_hash
          user.botScore || 0,                                       // bot_score
          user.botFlags ? JSON.stringify(user.botFlags) : null,     // bot_flags
          new Date(),                                               // scraped_at
          user.isVerified || false,                                 // is_verified
          user.isScam || false,                                     // is_scam
          user.isFake || false,                                     // is_fake
          user.isRestricted || false,                               // is_restricted
          user.isDeleted || false,                                  // is_deleted
          user.isSupport || false,                                  // is_support
          user.isContact || false,                                  // is_contact
          user.isMutualContact || false,                            // is_mutual_contact
          user.isCloseFriend || false,                              // is_close_friend
          user.langCode || null,                                    // lang_code
          user.status || null,                                      // status
          lastSeen,                                                 // last_seen
        );
      });

      const query = `
        INSERT INTO scraped_users (
          job_id, telegram_id, username, first_name, last_name, phone,
          is_bot, is_premium, access_hash, bot_score, bot_flags, scraped_at,
          is_verified, is_scam, is_fake, is_restricted, is_deleted,
          is_support, is_contact, is_mutual_contact, is_close_friend,
          lang_code, status, last_seen
        ) VALUES ${placeholders.join(', ')}
        ON CONFLICT (job_id, telegram_id) DO NOTHING
      `;

      const result = await pool.query(query, values);
      // Postgres returns rowCount = rows actually written, so for an
      // INSERT ... ON CONFLICT DO NOTHING the inserted count IS rowCount
      // and the duplicate count is whatever fell on the floor. The
      // original code had these swapped, which made every successful
      // scrape report `usersSaved: 0` even though every row was in fact
      // persisted (you could see them in the export). Operators were
      // taking that 0 to mean the scrape silently failed.
      const written = parseInt(result.rowCount || 0);
      inserted += written;
      duplicates += batch.length - written;
    }

    // Best-effort: also persist the has_profile_photo / restriction_reason
    // / dc_id columns in a single follow-up UPDATE so the INSERT stays
    // narrow and ON CONFLICT cheap. Each scraped user already has a
    // unique (job_id, telegram_id) row at this point.
    const enriched = users.filter((u) => (u.telegramId || u.id) && (u.hasProfilePhoto || u.restrictionReason || u.dcId));
    for (const u of enriched) {
      try {
        await pool.query(
          `UPDATE scraped_users
              SET has_profile_photo = COALESCE($3, has_profile_photo),
                  restriction_reason = COALESCE($4, restriction_reason),
                  dc_id              = COALESCE($5, dc_id)
            WHERE job_id = $1 AND telegram_id = $2`,
          [
            jobIdInt,
            u.telegramId || u.id,
            u.hasProfilePhoto || null,
            u.restrictionReason || null,
            u.dcId || null,
          ]
        );
      } catch (err) {
        // Non-fatal — the row is still useful even without these.
        logger.debug(`scraped_users enrich update failed: ${err.message}`);
      }
    }

    return { inserted, duplicates };
  }

  async _saveToList(jobId, listName) {
    const jobIdInt = parseInt(jobId, 10);
    // Get job owner
    const jobResult = await pool.query(
      `SELECT s.user_id FROM scraping_jobs j
       JOIN sessions s ON j.session_id = s.id
       WHERE j.id = $1`,
      [jobIdInt]
    );
    
    if (!jobResult.rows[0]) return;
    
    const userId = jobResult.rows[0].user_id;
    const name = listName || `Scrape Job ${jobId}`;

    // Create list
    const listResult = await pool.query(
      `INSERT INTO lists (user_id, name, type, source, items_count, created_at)
       VALUES ($1, $2, 'users', 'scrape_job_${jobId}', 0, NOW())
       RETURNING id`,
      [userId, name]
    );

    const listId = listResult.rows[0].id;

    // Copy users to list
    await pool.query(
      `INSERT INTO list_items (list_id, telegram_id, username, first_name, last_name, phone, is_bot, is_premium, added_at)
       SELECT $1, telegram_id, username, first_name, last_name, phone, is_bot, is_premium, scraped_at
       FROM scraped_users WHERE job_id = $2`,
      [listId, jobId]
    );

    // Update count
    await pool.query(
      `UPDATE lists SET items_count = (SELECT COUNT(*) FROM list_items WHERE list_id = $1) WHERE id = $1`,
      [listId]
    );
  }

  async cancelJob(jobId) {
    const job = activeJobs.get(jobId);
    if (job) {
      job.cancelled = true;
    }
    await this._updateJobStatus(jobId, 'cancelled');
    await this._updateProgress(jobId, { status: 'cancelled', endTime: new Date().toISOString() });
    activeJobs.delete(jobId);
  }

  async getJob(jobId) {
    return this._getJob(jobId);
  }

  async getProgress(jobId) {
    const data = await redisClient.get(`scrape:${jobId}:progress`);
    return data ? JSON.parse(data) : null;
  }

  async listJobs(userId, { page = 1, limit = 20, sort = 'created_at', order = 'DESC', filter } = {}) {
    const conditions = ['s.user_id = $1'];
    const params = [userId];
    let paramIdx = 2;

    if (filter) {
      conditions.push(`(j.target_id ILIKE $${paramIdx} OR j.status ILIKE $${paramIdx})`);
      params.push(`%${filter}%`);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');
    const offset = (page - 1) * limit;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM scraping_jobs j
       JOIN sessions s ON j.session_id = s.id
       WHERE ${whereClause}`,
      params
    );

    const total = parseInt(countResult.rows[0].count, 10);

    const jobsResult = await pool.query(
      `SELECT j.*, s.user_id
       FROM scraping_jobs j
       JOIN sessions s ON j.session_id = s.id
       WHERE ${whereClause}
       ORDER BY j.${sort} ${order.toUpperCase()}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    return {
      jobs: jobsResult.rows.map(j => ({
        ...j,
        options: typeof j.options === 'string' ? JSON.parse(j.options) : j.options,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getStats(userId) {
    // Get overall job statistics
    const overallResult = await pool.query(
      `SELECT 
        COUNT(*) as "totalJobs",
        COUNT(*) FILTER (WHERE j.status = 'completed') as "completedJobs",
        COUNT(*) FILTER (WHERE j.status = 'running') as "runningJobs",
        COUNT(*) FILTER (WHERE j.status = 'failed') as "failedJobs",
        COUNT(*) FILTER (WHERE j.status = 'pending') as "pendingJobs",
        COUNT(*) FILTER (WHERE j.status = 'cancelled') as "cancelledJobs",
        COALESCE(SUM((j.stats->>'totalFound')::int), 0) as "totalUsersScraped",
        COALESCE(SUM((j.stats->>'botsFiltered')::int), 0) as "totalBotsFiltered"
       FROM scraping_jobs j
       JOIN sessions s ON j.session_id = s.id
       WHERE s.user_id = $1`,
      [userId]
    );

    const stats = overallResult.rows[0];

    // Calculate success rate
    const total = parseInt(stats.totalJobs) || 0;
    const completed = parseInt(stats.completedJobs) || 0;
    const failed = parseInt(stats.failedJobs) || 0;
    stats.successRate = total > 0 ? Math.round((completed / total) * 10000) / 100 : 0;
    stats.averageUsersPerJob = total > 0 ? Math.round((parseInt(stats.totalUsersScraped) / total) * 100) / 100 : 0;

    // Get last job date
    const lastJobResult = await pool.query(
      `SELECT j.created_at as "lastJobDate"
       FROM scraping_jobs j
       JOIN sessions s ON j.session_id = s.id
       WHERE s.user_id = $1
       ORDER BY j.created_at DESC
       LIMIT 1`,
      [userId]
    );
    stats.lastJobDate = lastJobResult.rows[0]?.lastJobDate || null;

    // Get jobs by type (using job_mode)
    const jobsByTypeResult = await pool.query(
      `SELECT 
        j.job_mode as "type",
        COUNT(*) as "count"
       FROM scraping_jobs j
       JOIN sessions s ON j.session_id = s.id
       WHERE s.user_id = $1
       GROUP BY j.job_mode`,
      [userId]
    );
    stats.jobsByType = jobsByTypeResult.rows.reduce((acc, row) => {
      acc[row.type] = parseInt(row.count);
      return acc;
    }, {});

    // Get recent jobs (last 10)
    const recentJobsResult = await pool.query(
      `SELECT 
        j.id,
        j.status,
        j.job_mode as "jobMode",
        j.target_type as "targetType",
        j.target_id as "targetId",
        j.target_title as "targetTitle",
        j.total_found as "totalFound",
        j.progress,
        j.created_at as "createdAt",
        j.completed_at as "completedAt",
        j.error_message as "errorMessage",
        j.stats
       FROM scraping_jobs j
       JOIN sessions s ON j.session_id = s.id
       WHERE s.user_id = $1
       ORDER BY j.created_at DESC
       LIMIT 10`,
      [userId]
    );
    stats.recentJobs = recentJobsResult.rows;

    return stats;
  }
}

const scrapeServiceInstance = new ScrapeService();

logger.info(`Registering job executor with queue manager...`);

// Register job executor with queue manager to avoid circular dependency
scrapeQueue = require('../queues/scrapeQueue');
logger.info(`Queue manager loaded: ${typeof scrapeQueue.setJobExecutor}`);
scrapeQueue.setJobExecutor((jobId) => scrapeServiceInstance._executeScrapeJob(jobId));
logger.info(`Job executor registered`);

module.exports = scrapeServiceInstance;
