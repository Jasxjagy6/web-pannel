/**
 * monitorOrchestrator — long-running scheduler for monitor V2.
 *
 * Responsibilities
 * ----------------
 *  1. CRUD: create / pause / resume / stop multi-chat monitor jobs.
 *  2. Mode detection per chat (open_roster vs admin_only vs unknown).
 *  3. Cohort planning per chat (delegates to cohortPlanner).
 *  4. Bringing up / tearing down shifts via listenerWorker.
 *  5. Boot-time recovery (re-attach to running jobs after restart).
 *
 * Process model
 * -------------
 *  Everything is in-process today.  The data model (scrape_monitor_*
 *  tables, sessionOwnershipLock) is designed so a future cross-process
 *  workerized version can be dropped in without schema changes.
 *
 *  Single ticker (`_tick`) runs every TICK_MS, scans all running
 *  jobs+chats, calls cohortPlanner, and reconciles state with
 *  listenerWorker.  Inactive chats produce no plan output beyond
 *  "keep cohort_size=1 listener up".
 */

'use strict';

const { pool } = require('../../config/database');
const logger = require('../../utils/logger');
const planner = require('./cohortPlanner');
const listenerWorker = require('./listenerWorker');
const funnel = require('./observationFunnel');
const sessionListService = require('../sessionListService');
const telegramService = require('../telegramService');
const scrapeService = require('../scrapeService');
const { AppError } = require('../../utils/errorHandler');

const TICK_MS = 10_000;
const MODE_DETECT_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6 h
const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 14 * 24 * 60 * 60;       // 14 days
const MAX_CHATS_PER_JOB = 50;
const MAX_RUNNING_MONITORS_PER_USER = parseInt(
  process.env.MAX_RUNNING_MONITORS_PER_USER || '20', 10
);
const PROGRESS_TICK_MS = 10_000;

function emit(userId, event, payload) {
  try {
    if (global.io) global.io.to(`user:${userId}`).emit(event, payload);
  } catch (err) {
    logger.debug(`emit ${event} failed: ${err.message}`);
  }
}

function ensurePositiveInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

class MonitorOrchestrator {
  constructor() {
    this._tickTimer = null;
    this._progressTimer = null;
    this._started = false;
    this._inflight = false;
    /** chatId → last mode-detect time */
    this._lastModeDetect = new Map();
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  async start() {
    if (this._started) return;
    this._started = true;
    funnel.startBackgroundFlusher();

    // Boot-time recovery: scan running jobs and resume any that are
    // still inside their window.
    try { await this.resumeActiveJobs(); }
    catch (err) { logger.warn(`monitorOrchestrator.resume: ${err.message}`); }

    this._tickTimer = setInterval(
      () => this._tick().catch(
        (e) => logger.warn(`orchestrator tick: ${e.message}`)
      ),
      TICK_MS
    );
    this._tickTimer.unref?.();

    this._progressTimer = setInterval(
      () => this._emitProgress().catch(
        (e) => logger.debug(`progress tick: ${e.message}`)
      ),
      PROGRESS_TICK_MS
    );
    this._progressTimer.unref?.();

    logger.info('monitorOrchestrator started');
  }

  async stop() {
    if (!this._started) return;
    this._started = false;
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    if (this._progressTimer) { clearInterval(this._progressTimer); this._progressTimer = null; }
    funnel.stopBackgroundFlusher();
  }

  // -------------------------------------------------------------------
  // Public CRUD surface
  // -------------------------------------------------------------------

  /**
   * Create a multi-chat monitor job.
   *
   * Backwards-compatible: callers passing the legacy `targetId` single-chat
   * shape get a job with one entry in scrape_monitor_chats.
   *
   * @param {Object} args
   * @param {number} args.userId
   * @param {number[]} args.sessionIds  pool of sessions (>=1)
   * @param {Array<{targetId, targetType?, targetTitle?}>|string} args.chats
   *   either a list of chat refs OR a single targetId (legacy).
   * @param {string} [args.targetId]
   * @param {string} [args.targetType]
   * @param {string} [args.targetTitle]
   * @param {number} args.durationSeconds
   * @param {number} [args.cohortSizeDefault=1]
   * @param {number} [args.shiftMinSeconds=1800]
   * @param {number} [args.shiftMaxSeconds=5400]
   * @param {number} [args.overlapSeconds=60]
   * @param {boolean} [args.autoFastScrape=true]
   * @param {boolean} [args.autoStart=true]
   * @param {string} [args.reason]
   * @param {object} [args.options]
   */
  async createJob(args) {
    const userId = args.userId;
    if (!userId) throw new AppError('userId required', 400, 'MISSING_USER_ID');

    // Resolve the pool of sessions (explicit sessionIds OR sessionListId).
    let sessionIds = Array.isArray(args.sessionIds)
      ? args.sessionIds.slice()
      : [];
    if (args.sessionListId) {
      sessionIds = await sessionListService.resolveSessionIds({
        userId,
        platform: 'telegram',
        sessionIds: [],
        sessionListId: args.sessionListId,
      });
    }
    sessionIds = sessionIds.map((s) => parseInt(s, 10)).filter(Number.isFinite);
    if (sessionIds.length === 0) {
      throw new AppError(
        'Select at least one session', 400, 'NO_SESSIONS'
      );
    }

    // Verify session ownership.
    const owned = await pool.query(
      `SELECT id FROM sessions
        WHERE user_id = $1 AND id = ANY($2::int[])`,
      [userId, sessionIds]
    );
    if (owned.rows.length === 0) {
      throw new AppError('No owned sessions', 400, 'NO_OWNED_SESSIONS');
    }
    sessionIds = owned.rows.map((r) => r.id);

    // Resolve the chat list.
    const chats = this._normaliseChats(args);
    if (chats.length === 0) {
      throw new AppError('At least one chat required', 400, 'NO_CHATS');
    }
    if (chats.length > MAX_CHATS_PER_JOB) {
      throw new AppError(
        `At most ${MAX_CHATS_PER_JOB} chats per job`,
        400, 'TOO_MANY_CHATS'
      );
    }

    const duration = Math.max(
      MIN_DURATION_SECONDS,
      Math.min(
        MAX_DURATION_SECONDS,
        Math.floor(Number(args.durationSeconds) || 0)
      )
    );
    if (!duration) {
      throw new AppError('durationSeconds required', 400, 'MISSING_DURATION');
    }

    // Concurrent-monitor cap per user.
    const running = await pool.query(
      `SELECT COUNT(*)::int AS n FROM scrape_monitor_jobs
        WHERE user_id=$1 AND status IN ('running','pending')`,
      [userId]
    );
    if (running.rows[0].n >= MAX_RUNNING_MONITORS_PER_USER) {
      throw new AppError(
        `Concurrent monitor limit (${MAX_RUNNING_MONITORS_PER_USER}) reached`,
        429, 'MONITOR_LIMIT'
      );
    }

    const cohortSizeDefault = ensurePositiveInt(args.cohortSizeDefault, 1);
    const shiftMinSeconds = ensurePositiveInt(args.shiftMinSeconds, 1800);
    const shiftMaxSeconds = ensurePositiveInt(args.shiftMaxSeconds, 5400);
    const overlapSeconds = ensurePositiveInt(args.overlapSeconds, 60);
    const autoFastScrape = args.autoFastScrape !== false;
    const autoStart = args.autoStart !== false;
    const reason = args.reason || null;
    const optsIn = (args.options && typeof args.options === 'object') ? args.options : {};
    const dedupEnabled = args.dedupEnabled !== false; // V2 always dedupes

    // Persist parent job row.
    const jobRes = await pool.query(
      `INSERT INTO scrape_monitor_jobs
          (user_id, session_ids, target_id, target_type, target_title,
           status, duration_seconds, remaining_seconds,
           scraped_count, events_observed, options, reason,
           started_at, expires_at, created_at, updated_at,
           dedup_enabled, cohort_size_default, shift_min_seconds,
           shift_max_seconds, overlap_seconds, auto_fast_scrape,
           scheduler_version)
        VALUES ($1, $2, $3, $4, $5,
                $6, $7, $7,
                0, 0, $8, $9,
                NOW(), NOW() + ($7::int * INTERVAL '1 second'),
                NOW(), NOW(),
                $10, $11, $12, $13, $14, $15, 'v2')
        RETURNING *`,
      [
        userId, sessionIds,
        chats[0].targetId, chats[0].targetType, chats[0].targetTitle,
        autoStart ? 'running' : 'pending',
        duration,
        JSON.stringify({ ...optsIn, scheduler: 'v2', chats: chats.length }),
        reason,
        dedupEnabled,
        cohortSizeDefault,
        shiftMinSeconds,
        shiftMaxSeconds,
        overlapSeconds,
        autoFastScrape,
      ]
    );
    const job = jobRes.rows[0];

    // Insert per-chat rows.
    const chatRows = [];
    for (const c of chats) {
      const r = await pool.query(
        `INSERT INTO scrape_monitor_chats
            (monitor_job_id, target_id, target_type, target_title,
             detected_mode, cohort_size, status, created_at, updated_at)
          VALUES ($1, $2, $3, $4, 'unknown', $5, $6, NOW(), NOW())
          RETURNING *`,
        [
          job.id, c.targetId, c.targetType, c.targetTitle,
          cohortSizeDefault,
          autoStart ? 'running' : 'pending',
        ]
      );
      chatRows.push(r.rows[0]);
    }

    if (autoStart) {
      // Run mode detection in the background for each chat, then the
      // ticker will pick up shift scheduling on its next pass.
      Promise.resolve().then(() =>
        this._detectAllModes(job, chatRows).catch((e) =>
          logger.warn(`mode-detect job ${job.id}: ${e.message}`)
        )
      );
    }

    return this._toPublic(job, chatRows);
  }

  async listJobs(userId, { page = 1, limit = 20, status, search } = {}) {
    const offset = (page - 1) * limit;
    const where = ['j.user_id = $1'];
    const params = [userId];
    if (status) {
      params.push(status);
      where.push(`j.status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      where.push(`(j.target_id ILIKE $${i} OR j.target_title ILIKE $${i})`);
    }
    params.push(limit, offset);
    const sql = `
      SELECT j.*,
             COUNT(DISTINCT c.id)::int  AS chat_count,
             COALESCE(SUM(c.scraped_count), 0)::int AS chats_scraped_total
        FROM scrape_monitor_jobs j
        LEFT JOIN scrape_monitor_chats c ON c.monitor_job_id = j.id
        WHERE ${where.join(' AND ')}
        GROUP BY j.id
        ORDER BY j.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const r = await pool.query(sql, params);
    const total = await pool.query(
      `SELECT COUNT(*)::int AS n FROM scrape_monitor_jobs WHERE user_id = $1`,
      [userId]
    );
    return {
      jobs: r.rows.map((row) => this._toPublic(row)),
      pagination: {
        page, limit,
        total: total.rows[0].n,
        pages: Math.max(1, Math.ceil(total.rows[0].n / limit)),
      },
    };
  }

  async getJob(jobId, userId) {
    const r = await pool.query(
      `SELECT * FROM scrape_monitor_jobs WHERE id=$1 AND user_id=$2`,
      [jobId, userId]
    );
    if (r.rowCount === 0) {
      throw new AppError('Monitor job not found', 404, 'NOT_FOUND');
    }
    const chats = await pool.query(
      `SELECT * FROM scrape_monitor_chats WHERE monitor_job_id=$1
        ORDER BY id ASC`,
      [jobId]
    );
    const shifts = await pool.query(
      `SELECT s.* FROM scrape_monitor_shifts s
        WHERE s.monitor_job_id = $1
        ORDER BY s.planned_start DESC
        LIMIT 200`,
      [jobId]
    );
    return this._toPublic(r.rows[0], chats.rows, shifts.rows);
  }

  async pauseJob(jobId, userId) {
    const r = await pool.query(
      `UPDATE scrape_monitor_jobs
          SET status='paused', paused_at=NOW(),
              remaining_seconds = GREATEST(0,
                EXTRACT(EPOCH FROM (expires_at - NOW()))::int),
              updated_at=NOW()
        WHERE id=$1 AND user_id=$2 AND status='running'
        RETURNING *`,
      [jobId, userId]
    );
    if (r.rowCount === 0) {
      throw new AppError('Not a running job', 400, 'NOT_RUNNING');
    }
    await pool.query(
      `UPDATE scrape_monitor_chats SET status='paused', updated_at=NOW()
        WHERE monitor_job_id=$1`,
      [jobId]
    );
    await listenerWorker.stopJob(jobId, 'paused');
    emit(userId, 'monitor:paused', { jobId });
    return this._toPublic(r.rows[0]);
  }

  async resumeJob(jobId, userId) {
    const r = await pool.query(
      `UPDATE scrape_monitor_jobs
          SET status='running', paused_at=NULL,
              expires_at = NOW() + (remaining_seconds * INTERVAL '1 second'),
              updated_at=NOW()
        WHERE id=$1 AND user_id=$2 AND status='paused'
        RETURNING *`,
      [jobId, userId]
    );
    if (r.rowCount === 0) {
      throw new AppError('Not a paused job', 400, 'NOT_PAUSED');
    }
    await pool.query(
      `UPDATE scrape_monitor_chats SET status='running', updated_at=NOW()
        WHERE monitor_job_id=$1`,
      [jobId]
    );
    emit(userId, 'monitor:resumed', { jobId });
    // The ticker will pick up shift assignment on its next pass.
    return this._toPublic(r.rows[0]);
  }

  async stopJob(jobId, userId, status = 'cancelled') {
    const r = await pool.query(
      `UPDATE scrape_monitor_jobs
          SET status=$3, completed_at=NOW(), updated_at=NOW(),
              remaining_seconds=0
        WHERE id=$1 AND user_id=$2
          AND status NOT IN ('cancelled','failed','completed')
        RETURNING *`,
      [jobId, userId, status]
    );
    if (r.rowCount === 0) {
      throw new AppError('Job already terminal', 400, 'TERMINAL');
    }
    await pool.query(
      `UPDATE scrape_monitor_chats SET status=$2, updated_at=NOW()
        WHERE monitor_job_id=$1`,
      [jobId, status]
    );
    await listenerWorker.stopJob(jobId, status);
    emit(userId, 'monitor:stopped', { jobId, status });
    return this._toPublic(r.rows[0]);
  }

  async cancelAll(userId) {
    const r = await pool.query(
      `SELECT id FROM scrape_monitor_jobs
        WHERE user_id = $1
          AND status IN ('running','paused','pending')`,
      [userId]
    );
    let cancelled = 0;
    for (const row of r.rows) {
      try {
        await this.stopJob(row.id, userId, 'cancelled');
        cancelled += 1;
      } catch (err) {
        logger.debug(`cancelAll skip ${row.id}: ${err.message}`);
      }
    }
    return { cancelled };
  }

  /**
   * Boot-time recovery.  Pulls running jobs and lets the ticker bring
   * them back online.  Any shift rows still in warming/active/handoff
   * state are released — they're stale (worker that owned them is gone).
   */
  async resumeActiveJobs() {
    // Reap stale shifts.
    await pool.query(
      `UPDATE scrape_monitor_shifts
          SET state = 'failed',
              fail_reason = COALESCE(fail_reason, 'process_restart'),
              actual_end = COALESCE(actual_end, NOW()),
              updated_at = NOW()
        WHERE state IN ('warming','active','handoff')`
    );

    // Roll over any expired running jobs.
    const expired = await pool.query(
      `SELECT id, user_id FROM scrape_monitor_jobs
        WHERE status = 'running' AND expires_at <= NOW()`
    );
    for (const row of expired.rows) {
      try { await this.stopJob(row.id, row.user_id, 'completed'); }
      catch (err) { logger.debug(`resume expire ${row.id}: ${err.message}`); }
    }
  }

  // -------------------------------------------------------------------
  // Tick: planner + reconcile
  // -------------------------------------------------------------------

  async _tick() {
    if (this._inflight) return;
    this._inflight = true;
    try {
      // 1. Finalise jobs whose window expired.
      const expired = await pool.query(
        `SELECT id, user_id FROM scrape_monitor_jobs
          WHERE status='running' AND expires_at <= NOW()`
      );
      for (const row of expired.rows) {
        try { await this.stopJob(row.id, row.user_id, 'completed'); }
        catch (err) { logger.debug(`tick expire ${row.id}: ${err.message}`); }
      }

      // 2. Pull every running chat in every running job and run the
      //    planner on each.  We batch to avoid 1+N queries.
      const chats = await pool.query(
        `SELECT c.*,
                j.user_id, j.cohort_size_default, j.shift_min_seconds,
                j.shift_max_seconds, j.overlap_seconds,
                j.auto_fast_scrape, j.scheduler_version,
                j.session_ids AS pool_session_ids
           FROM scrape_monitor_chats c
           JOIN scrape_monitor_jobs j ON j.id = c.monitor_job_id
          WHERE j.status='running' AND c.status='running'
            AND j.scheduler_version='v2'
          ORDER BY c.id ASC
          LIMIT 500`
      );
      if (chats.rows.length === 0) return;

      // Pre-fetch each chat's active shifts in one query.
      const chatIds = chats.rows.map((r) => r.id);
      const shifts = await pool.query(
        `SELECT * FROM scrape_monitor_shifts
          WHERE monitor_chat_id = ANY($1::bigint[])
            AND state IN ('warming','active','handoff')`,
        [chatIds]
      );
      const byChat = new Map();
      for (const s of shifts.rows) {
        if (!byChat.has(s.monitor_chat_id)) byChat.set(s.monitor_chat_id, []);
        byChat.get(s.monitor_chat_id).push({
          shiftId: s.id, sessionId: s.session_id, chatId: s.monitor_chat_id,
          plannedStart: s.planned_start, plannedEnd: s.planned_end,
        });
      }

      // Pre-fetch fatigue + risk for ALL sessions used by ANY job we
      // saw.  This bounds the per-tick DB load to constant queries
      // regardless of fleet size.
      const allSessionIds = new Set();
      for (const c of chats.rows) {
        for (const sid of (c.pool_session_ids || [])) allSessionIds.add(sid);
      }
      const poolMeta = await this._fetchSessionMeta(Array.from(allSessionIds));
      // Active shifts across ALL chats — used by isEligible's
      // activeShifts cap.
      const activeAll = await pool.query(
        `SELECT session_id, monitor_chat_id, planned_end
           FROM scrape_monitor_shifts
          WHERE state IN ('warming','active','handoff')`
      );
      const activeBySession = new Map();
      for (const row of activeAll.rows) {
        activeBySession.set(
          row.session_id,
          (activeBySession.get(row.session_id) || 0) + 1
        );
      }

      // 3. For each chat, run planner + reconcile.
      for (const chat of chats.rows) {
        try {
          await this._reconcileChat(chat, byChat.get(chat.id) || [], poolMeta, activeBySession);
        } catch (err) {
          logger.warn(`reconcile chat ${chat.id}: ${err.message}`);
        }
      }
    } finally {
      this._inflight = false;
    }
  }

  async _reconcileChat(chat, activeShifts, poolMeta, activeBySession) {
    // 0. Mode re-detection if we're due.
    const lastDetect = this._lastModeDetect.get(chat.id) || 0;
    if (Date.now() - lastDetect > MODE_DETECT_INTERVAL_MS) {
      this._lastModeDetect.set(chat.id, Date.now());
      // Don't block reconcile on the detect call.
      this._detectMode(chat).catch(() => {});
    }

    // 1. Update events-per-minute (the planner reads it).
    const epm = funnel.getEventsPerMinute(chat.id);
    if (epm > 0 || chat.events_per_minute_recent > 0) {
      try {
        await pool.query(
          `UPDATE scrape_monitor_chats
              SET events_per_minute_recent = $2, updated_at = NOW()
            WHERE id = $1`,
          [chat.id, epm]
        );
      } catch {}
    }

    // 2. Construct the pool snapshot.
    const poolList = (chat.pool_session_ids || [])
      .map((sid) => this._sessionMetaToPlannerInput(sid, chat, poolMeta, activeBySession))
      .filter((s) => s !== null);

    // 3. Convert active shifts into planner shape.
    const activeShiftsForPlanner = activeShifts.map((s) => ({
      shiftId: s.shiftId,
      sessionId: s.sessionId,
      chatId: s.chatId,
      plannedStart: s.plannedStart,
      plannedEnd: s.plannedEnd,
    }));

    // 4. Run the planner.
    const out = planner.plan({
      now: new Date(),
      job: {
        id: chat.monitor_job_id,
        userId: chat.user_id,
        cohortSizeDefault: chat.cohort_size_default || 1,
        shiftMinSeconds: chat.shift_min_seconds || 1800,
        shiftMaxSeconds: chat.shift_max_seconds || 5400,
        overlapSeconds: chat.overlap_seconds || 60,
      },
      chat: {
        id: chat.id,
        targetId: chat.target_id,
        targetType: chat.target_type,
        detectedMode: chat.detected_mode || 'unknown',
        cohortSize: chat.cohort_size || 1,
        cohortSizePinned: !!chat.cohort_size_pinned,
        eventsPerMinuteRecent: Number(chat.events_per_minute_recent) || 0,
      },
      pool: poolList,
      activeShifts: activeShiftsForPlanner,
    });

    // 5. Persist computed cohort size if the planner re-computed it.
    if (out.cohortSize && out.cohortSize !== chat.cohort_size
        && !chat.cohort_size_pinned) {
      try {
        await pool.query(
          `UPDATE scrape_monitor_chats
              SET cohort_size = $2, updated_at = NOW()
            WHERE id = $1`,
          [chat.id, out.cohortSize]
        );
      } catch {}
    }

    // 6. End-now (graceful stops — listenerWorker auto-stops on
    //    planned_end too, this is a safety net).
    for (const e of out.endNow || []) {
      if (e.shiftId) {
        try { await listenerWorker.stop(e.shiftId, 'planned_end'); }
        catch (err) { logger.debug(`endNow ${e.shiftId}: ${err.message}`); }
      }
    }

    // 7. Start-now.
    for (const s of out.startNow || []) {
      try {
        const ins = await pool.query(
          `INSERT INTO scrape_monitor_shifts
              (monitor_chat_id, monitor_job_id, session_id, state,
               planned_start, planned_end, plan_reason)
            VALUES ($1, $2, $3, 'pending', NOW(), $4, $5)
            ON CONFLICT (monitor_chat_id, session_id, planned_start) DO NOTHING
            RETURNING *`,
          [chat.id, chat.monitor_job_id, s.sessionId, s.plannedEnd, s.reason]
        );
        if (ins.rowCount === 0) continue;
        const row = ins.rows[0];
        await listenerWorker.start({
          id: row.id,
          monitorChatId: chat.id,
          monitorJobId: chat.monitor_job_id,
          userId: chat.user_id,
          sessionId: s.sessionId,
          targetId: chat.target_id,
          plannedEnd: row.planned_end,
        });
      } catch (err) {
        logger.warn(
          `startNow shift chat=${chat.id} session=${s.sessionId}: ${err.message}`
        );
      }
    }

    // 8. Notes → audit log only (don't spam).
    if (out.notes && out.notes.length > 0) {
      logger.debug(`chat ${chat.id} notes: ${out.notes.join(',')}`);
    }
  }

  /**
   * Mode detection for one chat.  Best-effort across all pool sessions
   * (we try until one resolves the entity, since admin-only chats are
   * the whole reason this code exists).
   */
  async _detectMode(chat) {
    const sessionIds = (chat.pool_session_ids || []).map(String);
    if (sessionIds.length === 0) return;
    let canViewParticipants = null;
    let lastErr = null;
    for (const sid of sessionIds) {
      try {
        const entity = await telegramService._resolveEntity(sid, chat.target_id);
        if (!entity) continue;
        // canViewParticipants only exists on Channels (incl supergroups).
        // For basic chats and channels-without-the-flag, fall back to
        // probing iterParticipants.
        if (typeof entity.canViewParticipants === 'boolean') {
          canViewParticipants = entity.canViewParticipants;
        } else {
          // Probe: try a single-iter participant fetch.
          try {
            const cli = telegramService.clients?.get(sid)?.client;
            if (cli) {
              const it = cli.iterParticipants(entity, { limit: 1 });
              const first = await it.next();
              canViewParticipants = !first.done;
            }
          } catch (probeErr) {
            if (/CHAT_ADMIN_REQUIRED/i.test(probeErr.message)) {
              canViewParticipants = false;
            } else {
              lastErr = probeErr;
              continue;
            }
          }
        }
        if (canViewParticipants !== null) break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (canViewParticipants === null) {
      logger.debug(`mode-detect chat ${chat.id}: unknown (${lastErr?.message || 'no session resolved'})`);
      return;
    }

    const newMode = canViewParticipants ? 'open_roster' : 'admin_only';
    await pool.query(
      `UPDATE scrape_monitor_chats
          SET detected_mode = $2, last_detected_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [chat.id, newMode]
    );

    // If open_roster and we haven't fast-scraped yet, kick off
    // scrapeService now.  We use the same chat row's first session
    // from the pool.
    if (newMode === 'open_roster' && !chat.fast_scrape_done
        && chat.auto_fast_scrape !== false && sessionIds.length > 0) {
      try {
        await this._triggerFastScrape(chat, sessionIds);
      } catch (err) {
        logger.warn(`fast-scrape chat ${chat.id}: ${err.message}`);
      }
    }
  }

  async _detectAllModes(job, chatRows) {
    for (const c of chatRows) {
      const enriched = {
        ...c,
        user_id: job.user_id,
        pool_session_ids: job.session_ids,
        auto_fast_scrape: job.auto_fast_scrape !== false,
      };
      try { await this._detectMode(enriched); }
      catch (err) { logger.debug(`detect-all chat ${c.id}: ${err.message}`); }
    }
  }

  async _triggerFastScrape(chat, sessionIds) {
    if (!scrapeService || typeof scrapeService.createScrapeJob !== 'function') {
      logger.debug('scrapeService.createScrapeJob missing — skipping fast scrape');
      return;
    }
    const targetType = chat.target_type || 'group';
    let fastJobId = null;
    try {
      const job = await scrapeService.createScrapeJob({
        userId: chat.user_id,
        sessionIds: sessionIds.map(Number),
        targetIds: [chat.target_id],
        targetType,
        limit: 100000,
        options: { saveToList: false, source: 'monitor-v2-auto' },
      });
      fastJobId = job?.id || null;
      // Fire-and-forget start; the scrapeService runner handles its
      // own lifecycle and persistence.
      if (fastJobId) {
        scrapeService.startScrapeJob(fastJobId, true).catch((e) =>
          logger.warn(`fast scrape job ${fastJobId} start: ${e.message}`)
        );
      }
    } catch (err) {
      // If the fast path also returns CHAT_ADMIN_REQUIRED, downgrade
      // back to admin_only and move on; the cohort scheduler will
      // continue to monitor.
      if (/CHAT_ADMIN_REQUIRED|canViewParticipants/i.test(err.message)) {
        await pool.query(
          `UPDATE scrape_monitor_chats
              SET detected_mode = 'admin_only', last_detected_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1`,
          [chat.id]
        );
        return;
      }
      throw err;
    }
    await pool.query(
      `UPDATE scrape_monitor_chats
          SET fast_scrape_done = TRUE,
              fast_scrape_job_id = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [chat.id, fastJobId]
    );
    logger.info(`monitor v2: fast scrape kicked off for chat ${chat.id} → job ${fastJobId}`);
  }

  // -------------------------------------------------------------------
  // Planner input helpers
  // -------------------------------------------------------------------

  async _fetchSessionMeta(sessionIds) {
    if (!sessionIds || sessionIds.length === 0) return new Map();
    const meta = new Map();
    // One query for sessions + tg_session_health + last-shift info.
    const r = await pool.query(
      `SELECT s.id, s.user_id, s.is_logged_in, s.dc_id, s.proxy_id,
              p.country AS proxy_country,
              h.risk_score
         FROM sessions s
         LEFT JOIN tg_session_health h ON h.session_id = s.id
         LEFT JOIN user_proxies p ON p.id = s.proxy_id
        WHERE s.id = ANY($1::int[])`,
      [sessionIds]
    );
    for (const row of r.rows) {
      meta.set(row.id, {
        sessionId: row.id,
        ownerUserId: row.user_id,
        isLoggedIn: row.is_logged_in !== false,
        riskScore: row.risk_score != null ? Number(row.risk_score) : 0,
        dcId: row.dc_id,
        proxyCountry: row.proxy_country,
      });
    }

    // Fatigue: sum last 24 h of buckets per (session, target).  We
    // attach per-chat fatigue lazily in _sessionMetaToPlannerInput so
    // the same fatigue map can be reused across multiple chats.
    const fatigueRows = await pool.query(
      `SELECT session_id, target_id,
              SUM(events_observed)::int AS events,
              SUM(active_seconds)::int  AS seconds
         FROM scrape_monitor_session_fatigue
        WHERE session_id = ANY($1::int[])
          AND window_start >= NOW() - INTERVAL '24 hours'
        GROUP BY session_id, target_id`,
      [sessionIds]
    );
    const fatigueMap = new Map();
    for (const f of fatigueRows.rows) {
      const m = fatigueMap.get(f.session_id) || { perTarget: new Map(), totalEvents: 0 };
      m.perTarget.set(String(f.target_id), { events: f.events, seconds: f.seconds });
      m.totalEvents += f.events;
      fatigueMap.set(f.session_id, m);
    }
    for (const [sid, m] of fatigueMap) {
      const entry = meta.get(sid);
      if (entry) entry.fatigue = m;
    }

    // Last shift end on any chat.
    const lastShiftRows = await pool.query(
      `SELECT DISTINCT ON (session_id) session_id, monitor_chat_id, actual_end
         FROM scrape_monitor_shifts
        WHERE session_id = ANY($1::int[])
          AND actual_end IS NOT NULL
        ORDER BY session_id, actual_end DESC`,
      [sessionIds]
    );
    for (const row of lastShiftRows.rows) {
      const entry = meta.get(row.session_id);
      if (!entry) continue;
      entry.lastShiftEndedAt = row.actual_end;
      entry.lastShiftEndedOnChatId = row.monitor_chat_id;
    }
    return meta;
  }

  _sessionMetaToPlannerInput(sessionId, chat, poolMeta, activeBySession) {
    const m = poolMeta.get(sessionId);
    if (!m) return null;
    const f = m.fatigue || { perTarget: new Map(), totalEvents: 0 };
    const onChat = f.perTarget.get(String(chat.target_id))
      || { events: 0, seconds: 0 };
    return {
      sessionId,
      ownerUserId: m.ownerUserId,
      isLoggedIn: m.isLoggedIn,
      riskScore: m.riskScore,
      dcId: m.dcId,
      proxyCountry: m.proxyCountry,
      lastShiftEndedAt: m.lastShiftEndedAt || null,
      lastShiftEndedOnChatId: m.lastShiftEndedOnChatId
        ? Number(m.lastShiftEndedOnChatId) : null,
      fatigueOnThisChat: Math.min(1, onChat.events / 20000),
      fatigueGlobal: Math.min(1, (f.totalEvents || 0) / 20000),
      activeShifts: activeBySession.get(sessionId) || 0,
    };
  }

  _normaliseChats(args) {
    const out = [];
    const seen = new Set();
    const push = (targetId, targetType, targetTitle) => {
      const id = String(targetId || '').trim();
      if (!id) return;
      if (seen.has(id)) return;
      seen.add(id);
      out.push({
        targetId: id,
        targetType: targetType || 'group',
        targetTitle: targetTitle || null,
      });
    };
    if (Array.isArray(args.chats)) {
      for (const c of args.chats) {
        if (!c) continue;
        if (typeof c === 'string') push(c, 'group', null);
        else push(c.targetId || c.target_id, c.targetType || c.target_type, c.targetTitle || c.target_title);
      }
    }
    if (args.targetId && !seen.has(String(args.targetId).trim())) {
      push(args.targetId, args.targetType, args.targetTitle);
    }
    if (Array.isArray(args.targetIds)) {
      for (const t of args.targetIds) push(t, args.targetType || 'group', null);
    }
    return out;
  }

  async _emitProgress() {
    const r = await pool.query(
      `SELECT j.id, j.user_id,
              GREATEST(0,
                EXTRACT(EPOCH FROM (j.expires_at - NOW()))::int) AS remaining,
              j.scraped_count, j.events_observed,
              j.duration_seconds,
              COUNT(DISTINCT c.id)::int AS chat_count
         FROM scrape_monitor_jobs j
         LEFT JOIN scrape_monitor_chats c ON c.monitor_job_id = j.id
        WHERE j.status='running' AND j.scheduler_version='v2'
        GROUP BY j.id`
    );
    for (const row of r.rows) {
      emit(row.user_id, 'monitor:tick', {
        jobId: row.id,
        remainingSeconds: row.remaining,
        scrapedCount: row.scraped_count,
        eventsObserved: row.events_observed,
        chatCount: row.chat_count,
        durationSeconds: row.duration_seconds,
      });
    }
  }

  // -------------------------------------------------------------------
  // Serialisation
  // -------------------------------------------------------------------

  _toPublic(jobRow, chats = null, shifts = null) {
    if (!jobRow) return null;
    const payload = {
      id: jobRow.id,
      userId: jobRow.user_id,
      sessionIds: jobRow.session_ids || [],
      targetId: jobRow.target_id,
      targetType: jobRow.target_type,
      targetTitle: jobRow.target_title,
      status: jobRow.status,
      durationSeconds: jobRow.duration_seconds,
      remainingSeconds: jobRow.remaining_seconds,
      scrapedCount: jobRow.scraped_count,
      eventsObserved: jobRow.events_observed || 0,
      dedupEnabled: jobRow.dedup_enabled !== false,
      reason: jobRow.reason,
      options: jobRow.options || {},
      schedulerVersion: jobRow.scheduler_version || 'legacy',
      cohortSizeDefault: jobRow.cohort_size_default || 1,
      shiftMinSeconds: jobRow.shift_min_seconds || 1800,
      shiftMaxSeconds: jobRow.shift_max_seconds || 5400,
      overlapSeconds: jobRow.overlap_seconds || 60,
      autoFastScrape: jobRow.auto_fast_scrape !== false,
      startedAt: jobRow.started_at,
      pausedAt: jobRow.paused_at,
      expiresAt: jobRow.expires_at,
      completedAt: jobRow.completed_at,
      createdAt: jobRow.created_at,
      updatedAt: jobRow.updated_at,
      chatCount: jobRow.chat_count,
      chatsScrapedTotal: jobRow.chats_scraped_total,
    };
    if (chats) {
      payload.chats = chats.map((c) => ({
        id: c.id,
        targetId: c.target_id,
        targetType: c.target_type,
        targetTitle: c.target_title,
        detectedMode: c.detected_mode,
        fastScrapeDone: !!c.fast_scrape_done,
        fastScrapeJobId: c.fast_scrape_job_id,
        cohortSize: c.cohort_size,
        cohortSizePinned: !!c.cohort_size_pinned,
        status: c.status,
        scrapedCount: c.scraped_count,
        eventsObserved: c.events_observed,
        eventsPerMinuteRecent: Number(c.events_per_minute_recent) || 0,
        handoffMissCount: c.handoff_miss_count,
        lastEventAt: c.last_event_at,
        lastDetectedAt: c.last_detected_at,
      }));
    }
    if (shifts) {
      payload.recentShifts = shifts.map((s) => ({
        id: s.id,
        monitorChatId: s.monitor_chat_id,
        sessionId: s.session_id,
        state: s.state,
        plannedStart: s.planned_start,
        plannedEnd: s.planned_end,
        actualStart: s.actual_start,
        actualEnd: s.actual_end,
        eventsObserved: s.events_observed,
        usersCredited: s.users_credited,
        failReason: s.fail_reason,
        planReason: s.plan_reason,
      }));
    }
    return payload;
  }
}

module.exports = new MonitorOrchestrator();
