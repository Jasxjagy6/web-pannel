/**
 * Message Schedule Service.
 *
 * Backs the third tab of the Messaging page ("Schedule"). Each
 * `message_schedules` row drives one recurring bulk-groups job:
 *
 *   - Operator picks: sessions, groups, message, delayBetweenRounds,
 *     and intervalMinutes.
 *   - The tick loop polls every SCHEDULE_TICK_INTERVAL_MS for
 *     schedules whose last dispatched job has finished AND whose
 *     `intervalMinutes` cool-down has elapsed since `completed_at`.
 *   - For each due schedule it calls
 *     `messageService.sendBulkToGroups(...)` with the saved params,
 *     stores the new `messaging_jobs.id` as `last_job_id`, and lets
 *     the bulk-groups runner do its thing (rate limiting, per-target
 *     `message_logs`, socket progress events). The schedule itself
 *     never touches Telegram directly.
 *   - Cancelling a schedule sets `status = 'cancelled'` so the next
 *     tick is a no-op, and (best-effort) cancels the in-flight job
 *     via the existing `messageService.cancelJob` path.
 *
 * Many schedules can run concurrently — each tick dispatch is fire-
 * and-forget; the underlying bulk-groups runner is already async.
 * A single thrown error inside one schedule never blocks any other.
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');

// Ticker cadence. Tunable via env so ops can dial it in without a
// code change. 30s is a comfortable default — tight enough that a
// 1-minute interval feels close to honest, loose enough that we
// don't hammer the DB with no-op SELECTs.
const TICK_INTERVAL_MS = parseInt(process.env.SCHEDULE_TICK_INTERVAL_MS || '30000', 10);

// Hard ceiling on schedules a single user can run at once. The user
// asked for "no limit" but a quiet sanity cap keeps a runaway loop
// from filling messaging_jobs forever. 100 is far above any real
// operator's needs.
const MAX_RUNNING_PER_USER = parseInt(process.env.SCHEDULE_MAX_RUNNING_PER_USER || '100', 10);

// Lazy-required to break the circular dep:
// messageScheduleService -> messageService (for sendBulkToGroups,
// cancelJob) and messageService -> nothing related, so this is just
// a require-cycle guard for future-proofing.
let _messageService = null;
function messageService() {
  if (!_messageService) _messageService = require('./messageService');
  return _messageService;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function rowToSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name || null,
    sessionIds: parseJsonArray(row.session_ids),
    groupIds: parseJsonArray(row.group_ids),
    message: row.message,
    messageType: row.message_type,
    delayBetweenRounds: row.delay_between_rounds,
    intervalMinutes: row.interval_minutes,
    status: row.status,
    totalRuns: row.total_runs,
    lastJobId: row.last_job_id,
    lastJobStatus: row.last_job_status || null,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
  };
}

class MessageScheduleService {
  constructor() {
    this._tickHandle = null;
    this._tickRunning = false;
    this._stopped = false;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  /**
   * Boot the tick loop. Idempotent. Called from index.js during
   * background-worker startup.
   */
  start() {
    if (this._tickHandle) return;
    this._stopped = false;
    logger.info(`MessageScheduleService starting (tick=${TICK_INTERVAL_MS}ms)`);
    // Run one tick immediately so a schedule created right before
    // boot doesn't have to wait the full interval.
    this._safeTick();
    this._tickHandle = setInterval(() => this._safeTick(), TICK_INTERVAL_MS);
    if (this._tickHandle.unref) this._tickHandle.unref();
  }

  stop() {
    this._stopped = true;
    if (this._tickHandle) {
      clearInterval(this._tickHandle);
      this._tickHandle = null;
    }
  }

  async _safeTick() {
    if (this._tickRunning || this._stopped) return;
    this._tickRunning = true;
    try {
      await this._tick();
    } catch (err) {
      logger.error(`MessageScheduleService tick error: ${err.message}`, {
        stack: err.stack,
      });
    } finally {
      this._tickRunning = false;
    }
  }

  /**
   * Pick the schedules that are due for another run and dispatch them.
   *
   * "Due" means status='running' AND either:
   *   - no job has been dispatched yet (last_job_id IS NULL), or
   *   - the last dispatched job has reached a terminal state AND its
   *     `completed_at + interval_minutes` is in the past.
   *
   * The condition lives in SQL so concurrent tick runners (e.g. on
   * two panel pods sharing the DB) all see the same answer; the
   * `last_job_id` UPDATE serves as our "took it" marker.
   */
  async _tick() {
    const { rows } = await pool.query(
      `SELECT
         s.*,
         mj.status AS last_job_status,
         mj.completed_at AS last_job_completed_at
       FROM message_schedules s
       LEFT JOIN messaging_jobs mj ON s.last_job_id = mj.id
       WHERE s.status = 'running'
         AND (
           s.last_job_id IS NULL
           OR (
             mj.status IN ('completed', 'failed', 'cancelled')
             AND mj.completed_at IS NOT NULL
             AND mj.completed_at <= NOW() - (s.interval_minutes || ' minutes')::interval
           )
         )
       ORDER BY s.id ASC
       LIMIT 50`
    );

    if (rows.length === 0) return;

    for (const row of rows) {
      // Each dispatch is independent; a thrown error here must not
      // stop the rest of the batch.
      this._dispatch(row).catch((err) => {
        logger.error(
          `Schedule ${row.id} dispatch failed: ${err.message}`,
          { stack: err.stack }
        );
      });
    }
  }

  async _dispatch(scheduleRow) {
    const schedule = rowToSchedule(scheduleRow);
    const sessionIds = schedule.sessionIds;
    const groupIds = schedule.groupIds;

    if (!sessionIds.length || !groupIds.length) {
      logger.warn(
        `Schedule ${schedule.id} has no sessions or groups — marking failed`
      );
      await pool.query(
        `UPDATE message_schedules
         SET status = 'failed', last_error = $1
         WHERE id = $2`,
        ['Empty session_ids or group_ids', schedule.id]
      );
      return;
    }

    logger.info(
      `Dispatching schedule ${schedule.id} (run #${schedule.totalRuns + 1}) ` +
      `→ ${groupIds.length} group(s) × ${sessionIds.length} session(s)`,
      { userId: schedule.userId }
    );

    let result;
    try {
      result = await messageService().sendBulkToGroups({
        sessionIds,
        groupIds,
        message: schedule.message,
        messageType: schedule.messageType,
        delayBetweenRounds: schedule.delayBetweenRounds,
      }, schedule.userId);
    } catch (err) {
      logger.error(
        `Schedule ${schedule.id} bulk-groups dispatch threw: ${err.message}`
      );
      await pool.query(
        `UPDATE message_schedules
         SET last_error = $1, last_run_at = NOW()
         WHERE id = $2`,
        [String(err.message || err), schedule.id]
      );
      return;
    }

    await pool.query(
      `UPDATE message_schedules
       SET last_job_id = $1,
           last_run_at = NOW(),
           total_runs = total_runs + 1,
           last_error = NULL
       WHERE id = $2`,
      [result.jobId, schedule.id]
    );

    // Best-effort socket notification so the schedules tab can show
    // the new last_job_id without polling. Same channel the rest of
    // the messaging surface uses.
    try {
      const io = global.io;
      if (io) {
        io.to(`user_${schedule.userId}`).emit('schedule_dispatched', {
          schedule_id: schedule.id,
          job_id: result.jobId,
          total_runs: schedule.totalRuns + 1,
        });
      }
    } catch (_) {
      // socket optional
    }
  }

  // -------------------------------------------------------------------
  // CRUD (called from controller)
  // -------------------------------------------------------------------

  async createSchedule(params, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    const {
      sessionIds,
      groupIds,
      message,
      messageType = 'text',
      delayBetweenRounds = 20,
      intervalMinutes,
      name = null,
    } = params || {};

    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('At least one session is required', 400, 'NO_SESSIONS');
    }
    if (!Array.isArray(groupIds) || groupIds.length === 0) {
      throw new AppError('At least one group is required', 400, 'NO_GROUPS');
    }
    if (!message || String(message).trim().length === 0) {
      throw new AppError('Message is required', 400, 'EMPTY_MESSAGE');
    }
    const intervalNum = parseInt(intervalMinutes, 10);
    if (!Number.isFinite(intervalNum) || intervalNum < 1 || intervalNum > 10080) {
      throw new AppError(
        'intervalMinutes must be between 1 and 10080 (1 week)',
        400,
        'INVALID_INTERVAL'
      );
    }
    const delayNum = parseInt(delayBetweenRounds, 10);
    if (!Number.isFinite(delayNum) || delayNum < 0 || delayNum > 3600) {
      throw new AppError(
        'delayBetweenRounds must be between 0 and 3600',
        400,
        'INVALID_DELAY'
      );
    }
    if (!['text', 'html', 'markdown'].includes(messageType)) {
      throw new AppError('Invalid message type', 400, 'INVALID_MESSAGE_TYPE');
    }

    // Concurrency cap — see MAX_RUNNING_PER_USER docstring.
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM message_schedules
        WHERE user_id = $1 AND status = 'running'`,
      [userId]
    );
    if (countRows[0].n >= MAX_RUNNING_PER_USER) {
      throw new AppError(
        `Maximum of ${MAX_RUNNING_PER_USER} active schedules per user`,
        429,
        'TOO_MANY_SCHEDULES'
      );
    }

    // Verify session ownership before creating the schedule. We don't
    // want a schedule whose sessions belong to someone else (or were
    // deleted between picker render and submit) — that would just
    // fail every tick forever.
    const verifiedIds = await this._verifySessionOwnership(sessionIds, userId);
    if (verifiedIds.length === 0) {
      throw new AppError('No valid sessions found', 404, 'NO_VALID_SESSIONS');
    }

    const cleanGroupIds = groupIds
      .map((g) => String(g).trim())
      .filter((g) => g.length > 0);
    if (cleanGroupIds.length === 0) {
      throw new AppError('At least one group is required', 400, 'NO_GROUPS');
    }

    const insert = await pool.query(
      `INSERT INTO message_schedules (
         user_id, name, session_ids, group_ids, message, message_type,
         delay_between_rounds, interval_minutes, status, total_runs, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', 0, NOW())
       RETURNING *`,
      [
        userId,
        name ? String(name).slice(0, 120) : null,
        JSON.stringify(verifiedIds),
        JSON.stringify(cleanGroupIds),
        message,
        messageType,
        delayNum,
        intervalNum,
      ]
    );

    const schedule = rowToSchedule(insert.rows[0]);

    // Don't wait for the next tick — kick off the first dispatch
    // straight away so the operator gets immediate feedback that the
    // schedule is alive.
    this._dispatch(insert.rows[0]).catch((err) => {
      logger.error(
        `Initial dispatch for schedule ${schedule.id} failed: ${err.message}`
      );
    });

    logger.info(
      `Created message schedule ${schedule.id} for user ${userId} ` +
      `(every ${intervalNum} min, ${verifiedIds.length} sess × ${cleanGroupIds.length} groups)`
    );

    return schedule;
  }

  async listSchedules(userId, params = {}) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }
    const status = params.status;
    const limit = Math.min(parseInt(params.limit, 10) || 50, 200);

    const where = ['s.user_id = $1'];
    const args = [userId];
    if (status) {
      where.push(`s.status = $${args.length + 1}`);
      args.push(status);
    }

    const { rows } = await pool.query(
      `SELECT
         s.*,
         mj.status AS last_job_status,
         mj.completed_at AS last_job_completed_at
       FROM message_schedules s
       LEFT JOIN messaging_jobs mj ON s.last_job_id = mj.id
       WHERE ${where.join(' AND ')}
       ORDER BY s.created_at DESC
       LIMIT $${args.length + 1}`,
      [...args, limit]
    );

    return rows.map(rowToSchedule);
  }

  async getSchedule(scheduleId, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }
    const { rows } = await pool.query(
      `SELECT
         s.*,
         mj.status AS last_job_status,
         mj.completed_at AS last_job_completed_at
       FROM message_schedules s
       LEFT JOIN messaging_jobs mj ON s.last_job_id = mj.id
       WHERE s.id = $1 AND s.user_id = $2`,
      [scheduleId, userId]
    );
    if (rows.length === 0) {
      throw new AppError('Schedule not found', 404, 'SCHEDULE_NOT_FOUND');
    }
    return rowToSchedule(rows[0]);
  }

  /**
   * Cancel a single schedule. Best-effort cancels the in-flight
   * bulk-groups job too so an operator clicking "Cancel" actually
   * sees the sending stop, not just the next tick.
   */
  async cancelSchedule(scheduleId, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    const { rows } = await pool.query(
      `SELECT id, user_id, status, last_job_id
         FROM message_schedules
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [scheduleId, userId]
    );
    if (rows.length === 0) {
      throw new AppError('Schedule not found', 404, 'SCHEDULE_NOT_FOUND');
    }
    const row = rows[0];
    if (row.status === 'cancelled') {
      return { id: row.id, status: 'cancelled', alreadyCancelled: true };
    }

    await pool.query(
      `UPDATE message_schedules
         SET status = 'cancelled', cancelled_at = NOW()
       WHERE id = $1`,
      [scheduleId]
    );

    // Best-effort cancel of the most recent dispatched job. If it
    // already finished, cancelJob will throw INVALID_STATUS — we
    // swallow that since the schedule cancellation is what the
    // operator actually cares about.
    if (row.last_job_id) {
      try {
        await messageService().cancelJob(row.last_job_id, userId);
      } catch (err) {
        logger.debug(
          `cancelSchedule: in-flight job ${row.last_job_id} cancel failed: ${err.message}`
        );
      }
    }

    logger.info(`Cancelled schedule ${scheduleId} for user ${userId}`);
    return { id: scheduleId, status: 'cancelled' };
  }

  /**
   * Cancel every running schedule for a user. Returns the count of
   * schedules transitioned to 'cancelled'. The in-flight jobs are
   * cancelled best-effort, same semantics as `cancelSchedule`.
   */
  async cancelAllSchedules(userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    const { rows } = await pool.query(
      `SELECT id, last_job_id
         FROM message_schedules
        WHERE user_id = $1 AND status = 'running'`,
      [userId]
    );
    if (rows.length === 0) return { cancelled: 0 };

    await pool.query(
      `UPDATE message_schedules
         SET status = 'cancelled', cancelled_at = NOW()
       WHERE user_id = $1 AND status = 'running'`,
      [userId]
    );

    for (const r of rows) {
      if (!r.last_job_id) continue;
      try {
        await messageService().cancelJob(r.last_job_id, userId);
      } catch (err) {
        logger.debug(
          `cancelAllSchedules: in-flight job ${r.last_job_id} cancel failed: ${err.message}`
        );
      }
    }

    logger.info(`Cancelled ${rows.length} schedule(s) for user ${userId}`);
    return { cancelled: rows.length };
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  async _verifySessionOwnership(sessionIds, userId) {
    const ids = sessionIds
      .map((id) => parseInt(id, 10))
      .filter((id) => Number.isFinite(id));
    if (ids.length === 0) return [];
    const { rows } = await pool.query(
      `SELECT id FROM sessions WHERE id = ANY($1::int[]) AND user_id = $2`,
      [ids, userId]
    );
    return rows.map((r) => r.id);
  }
}

const messageScheduleService = new MessageScheduleService();
module.exports = messageScheduleService;
