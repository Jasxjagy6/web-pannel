/**
 * ScrapeMonitorService - Period-bounded passive scraper for admin-only chats.
 *
 * Why this exists
 * ---------------
 * A subset of Telegram groups and broadcast channels are configured so that
 * only admins can read the participant roster. For these chats Telegram
 * answers `getParticipants` with `CHAT_ADMIN_REQUIRED` (or simply hides the
 * roster), which makes the regular ScrapeService impossible to use.
 *
 * The next-best signal of who is in the chat is who *interacts* with it.
 * This service lets the user pick a window (e.g. 2 days), and then attaches
 * a passive `NewMessage` handler to each of their selected sessions. Every
 * distinct sender we see during the window is upserted into
 * `scrape_monitor_users` with `UNIQUE(monitor_job_id, telegram_id)` so the
 * dedup is enforced by the database.
 *
 * Properties
 * ----------
 *   * Multi-session: every selected session listens; first session to see a
 *     given user is recorded as `via_session_id`. We keep working as long as
 *     at least one session stays connected (the others' listeners no-op).
 *   * Anti-detect / proxy aware: we rely on the GramJS clients that are
 *     already booted by sessionService through the per-session bound proxy.
 *     We do not generate any extra outgoing API calls — we only consume
 *     updates Telegram is already pushing to the connection.
 *   * Pause / Resume / Stop / Cancel: pause detaches the listeners and
 *     persists `remaining_seconds`; resume reattaches and recomputes
 *     `expires_at`. Stop / cancel is a hard close.
 *   * Cancel-all: a single endpoint stops every running monitor for the
 *     calling user.
 *   * Crash-safe: on boot we re-read every job whose `status='running'`
 *     and `expires_at>NOW()` and reattach listeners; expired jobs are
 *     rolled to `completed`.
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const telegramService = require('./telegramService');
const { AppError } = require('../utils/errorHandler');

const VALID_STATUSES = new Set([
  'pending', 'running', 'paused', 'completed', 'cancelled', 'failed',
]);
const MAX_DURATION_SECONDS = 60 * 60 * 24 * 30;   // 30 days hard cap
const MIN_DURATION_SECONDS = 60;                  // 1 minute lower bound
const MAX_SESSIONS_PER_JOB = 10;
const PROGRESS_EMIT_DEBOUNCE_MS = 500;

function emit(userId, event, payload) {
  try {
    if (global.io) global.io.to(`user:${userId}`).emit(event, payload);
  } catch (err) {
    logger.debug(`emit ${event} failed: ${err.message}`);
  }
}

/**
 * Best-effort: extract the sender user ID and basic profile from a GramJS
 * NewMessage event. Returns `null` when the message has no user sender
 * (channel posts, service messages, etc).
 */
async function extractSenderProfile(event) {
  const msg = event?.message || event;
  if (!msg) return null;

  // Try senderId first (most reliable in modern GramJS).
  let telegramId = null;
  if (msg.senderId) {
    telegramId = Number(msg.senderId.value || msg.senderId);
  } else if (msg.fromId && msg.fromId.userId) {
    telegramId = Number(msg.fromId.userId.value || msg.fromId.userId);
  } else if (msg.peerId && msg.peerId.userId) {
    telegramId = Number(msg.peerId.userId.value || msg.peerId.userId);
  }
  if (!telegramId) return null;

  let username = null;
  let firstName = null;
  let lastName = null;
  let phone = null;
  let isBot = false;
  let isPremium = false;

  // Try to enrich with the cached sender entity. GramJS attaches `_sender`
  // automatically when the event passes through its dispatcher.
  const sender = msg._sender || (typeof event.getSender === 'function' ? null : null);
  let senderEntity = sender;
  if (!senderEntity && typeof event.getSender === 'function') {
    try {
      senderEntity = await event.getSender();
    } catch {
      senderEntity = null;
    }
  }
  if (senderEntity && senderEntity.className === 'User') {
    username = senderEntity.username || null;
    firstName = senderEntity.firstName || null;
    lastName = senderEntity.lastName || null;
    phone = senderEntity.phone || null;
    isBot = senderEntity.bot || false;
    isPremium = senderEntity.premium || false;
  }

  return { telegramId, username, firstName, lastName, phone, isBot, isPremium };
}

class ScrapeMonitorService {
  constructor() {
    /** jobId -> { unsubs: Map<sessionId, () => void>, timer, userId, lastEmitAt } */
    this._active = new Map();
  }

  // --------------------------------------------------------------------
  // CRUD-like surface
  // --------------------------------------------------------------------

  /**
   * Create a monitor job. Validates ownership of the sessions and that the
   * target string is non-empty. Returns the inserted row plus the live job
   * lifecycle info.
   */
  async createJob({
    userId, sessionIds, targetId, targetType = 'group',
    targetTitle = null, durationSeconds, reason = null, options = {},
    autoStart = true,
  }) {
    if (!userId) throw new AppError('User id required', 400, 'MISSING_USER_ID');
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('Select at least one session', 400, 'NO_SESSIONS');
    }
    if (sessionIds.length > MAX_SESSIONS_PER_JOB) {
      throw new AppError(`At most ${MAX_SESSIONS_PER_JOB} sessions`, 400, 'TOO_MANY_SESSIONS');
    }
    if (!targetId) {
      throw new AppError('Target id required', 400, 'MISSING_TARGET');
    }
    const duration = Math.max(
      MIN_DURATION_SECONDS,
      Math.min(MAX_DURATION_SECONDS, Math.floor(Number(durationSeconds) || 0))
    );
    if (!duration) {
      throw new AppError('durationSeconds required', 400, 'MISSING_DURATION');
    }

    const ids = sessionIds.map((s) => parseInt(s, 10)).filter(Number.isFinite);
    const owned = await pool.query(
      `SELECT id FROM sessions
       WHERE id = ANY($1::int[]) AND user_id = $2 AND is_logged_in = TRUE`,
      [ids, userId]
    );
    if (owned.rows.length === 0) {
      throw new AppError('No logged-in sessions selected', 400, 'NO_VALID_SESSIONS');
    }
    const validIds = owned.rows.map((r) => r.id);

    const insert = await pool.query(
      `INSERT INTO scrape_monitor_jobs
         (user_id, session_ids, target_id, target_type, target_title,
          status, duration_seconds, remaining_seconds, options, reason)
       VALUES ($1, $2::int[], $3, $4, $5,
               'pending', $6::int, $6::int, $7::jsonb, $8)
       RETURNING *`,
      [
        userId, validIds, String(targetId), String(targetType),
        targetTitle, duration, JSON.stringify(options || {}), reason,
      ]
    );
    const job = insert.rows[0];
    logger.info(`Monitor job created`, {
      jobId: job.id, userId, sessionCount: validIds.length, durationSeconds: duration,
    });
    emit(userId, 'monitor:created', { jobId: job.id });

    if (autoStart) {
      try {
        await this.startJob(job.id, userId);
      } catch (err) {
        logger.error(`Monitor job ${job.id} autoStart failed`, { error: err.message });
        await pool.query(
          `UPDATE scrape_monitor_jobs SET status='failed', reason=$1, updated_at=NOW() WHERE id=$2`,
          [err.message.slice(0, 500), job.id]
        );
      }
    }

    return await this.getJob(job.id, userId);
  }

  async startJob(jobId, userId) {
    const job = await this._loadOwned(jobId, userId);
    if (!['pending', 'paused'].includes(job.status)) {
      throw new AppError(
        `Cannot start a job in status '${job.status}'`, 400, 'INVALID_STATE'
      );
    }
    const remaining = Math.max(
      MIN_DURATION_SECONDS,
      Number(job.remaining_seconds || job.duration_seconds || 0)
    );
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + remaining * 1000);

    await pool.query(
      `UPDATE scrape_monitor_jobs
         SET status='running',
             started_at = COALESCE(started_at, NOW()),
             paused_at = NULL,
             remaining_seconds = $1,
             expires_at = $2,
             updated_at = NOW()
       WHERE id = $3`,
      [remaining, expiresAt, jobId]
    );

    await this._attach(jobId, userId, job.session_ids, remaining, job.target_id);
    emit(userId, 'monitor:started', { jobId, expiresAt });
    return await this.getJob(jobId, userId);
  }

  async pauseJob(jobId, userId) {
    const job = await this._loadOwned(jobId, userId);
    if (job.status !== 'running') {
      throw new AppError(`Cannot pause a job in status '${job.status}'`, 400, 'INVALID_STATE');
    }
    const remaining = job.expires_at
      ? Math.max(0, Math.floor((new Date(job.expires_at).getTime() - Date.now()) / 1000))
      : 0;

    await this._detach(jobId);
    await pool.query(
      `UPDATE scrape_monitor_jobs
         SET status='paused', paused_at=NOW(),
             remaining_seconds=$1, updated_at=NOW()
       WHERE id=$2`,
      [remaining, jobId]
    );
    emit(userId, 'monitor:paused', { jobId, remainingSeconds: remaining });
    return await this.getJob(jobId, userId);
  }

  async resumeJob(jobId, userId) {
    return await this.startJob(jobId, userId);
  }

  async stopJob(jobId, userId, status = 'cancelled') {
    const job = await this._loadOwned(jobId, userId);
    if (['completed', 'cancelled', 'failed'].includes(job.status)) {
      return await this.getJob(jobId, userId);
    }
    if (!VALID_STATUSES.has(status)) status = 'cancelled';

    await this._detach(jobId);
    await pool.query(
      `UPDATE scrape_monitor_jobs
         SET status=$1, completed_at=NOW(), updated_at=NOW()
       WHERE id=$2`,
      [status, jobId]
    );
    emit(userId, 'monitor:stopped', { jobId, status });
    return await this.getJob(jobId, userId);
  }

  async cancelAll(userId) {
    const r = await pool.query(
      `SELECT id FROM scrape_monitor_jobs
       WHERE user_id=$1 AND status IN ('pending', 'running', 'paused')`,
      [userId]
    );
    let cancelled = 0;
    for (const row of r.rows) {
      try {
        await this.stopJob(row.id, userId, 'cancelled');
        cancelled++;
      } catch (err) {
        logger.warn(`cancelAll: skip ${row.id}: ${err.message}`);
      }
    }
    emit(userId, 'monitor:cancel-all', { cancelled });
    return { cancelled };
  }

  // --------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------

  async listJobs(userId, { page = 1, limit = 20, status, search } = {}) {
    const where = ['user_id = $1'];
    const values = [userId];
    let i = 2;
    if (status && VALID_STATUSES.has(status)) {
      where.push(`status = $${i++}`);
      values.push(status);
    }
    if (search) {
      where.push(`(target_id ILIKE $${i} OR COALESCE(target_title,'') ILIKE $${i})`);
      values.push(`%${search}%`);
      i++;
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = await pool.query(
      `SELECT COUNT(*)::int AS n FROM scrape_monitor_jobs ${whereSql}`,
      values
    );
    const offset = Math.max(0, (page - 1) * limit);
    const list = await pool.query(
      `SELECT * FROM scrape_monitor_jobs ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...values, limit, offset]
    );
    return {
      jobs: list.rows.map(this._toPublic),
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
    if (!r.rows[0]) throw new AppError('Monitor job not found', 404, 'JOB_NOT_FOUND');
    return this._toPublic(r.rows[0]);
  }

  async listScrapedUsers(jobId, userId, { page = 1, limit = 50, search } = {}) {
    await this._loadOwned(jobId, userId); // authorize
    const where = ['monitor_job_id = $1'];
    const values = [jobId];
    let i = 2;
    if (search) {
      where.push(`(
        username ILIKE $${i} OR first_name ILIKE $${i}
        OR last_name ILIKE $${i} OR CAST(telegram_id AS TEXT) ILIKE $${i}
      )`);
      values.push(`%${search}%`);
      i++;
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = await pool.query(
      `SELECT COUNT(*)::int AS n FROM scrape_monitor_users ${whereSql}`,
      values
    );
    const offset = Math.max(0, (page - 1) * limit);
    const list = await pool.query(
      `SELECT * FROM scrape_monitor_users ${whereSql}
       ORDER BY last_seen_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...values, limit, offset]
    );
    return {
      users: list.rows,
      pagination: {
        page, limit,
        total: total.rows[0].n,
        pages: Math.max(1, Math.ceil(total.rows[0].n / limit)),
      },
    };
  }

  // --------------------------------------------------------------------
  // Boot-time recovery
  // --------------------------------------------------------------------

  /**
   * On startup, re-attach listeners for monitor jobs that were running
   * before the process restarted and whose window hasn't expired. Jobs
   * whose window already elapsed get rolled to `completed`.
   */
  async resumeActiveJobs() {
    const r = await pool.query(
      `SELECT id, user_id, session_ids, target_id, expires_at
         FROM scrape_monitor_jobs
        WHERE status = 'running'`
    );
    for (const job of r.rows) {
      const remaining = job.expires_at
        ? Math.floor((new Date(job.expires_at).getTime() - Date.now()) / 1000)
        : 0;
      if (remaining <= 0) {
        await this._finishJob(job.id, job.user_id);
        continue;
      }
      try {
        await this._attach(job.id, job.user_id, job.session_ids, remaining, job.target_id);
        logger.info(`Resumed monitor job ${job.id} (${remaining}s remaining)`);
      } catch (err) {
        logger.warn(`Failed to resume monitor job ${job.id}: ${err.message}`);
      }
    }
  }

  // --------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------

  async _loadOwned(jobId, userId) {
    const r = await pool.query(
      `SELECT * FROM scrape_monitor_jobs WHERE id=$1 AND user_id=$2`,
      [jobId, userId]
    );
    if (!r.rows[0]) throw new AppError('Monitor job not found', 404, 'JOB_NOT_FOUND');
    return r.rows[0];
  }

  async _attach(jobId, userId, sessionIds, remainingSeconds, targetId) {
    // Idempotent: replace any existing listeners for this job.
    await this._detach(jobId);

    const unsubs = new Map();
    const chats = [String(targetId)];
    for (const sid of sessionIds) {
      try {
        const off = await telegramService.addNewMessageHandler(
          String(sid),
          (event) => this._onEvent(jobId, userId, sid, event),
          { chats }
        );
        unsubs.set(sid, off);
      } catch (err) {
        logger.warn(`Monitor job ${jobId} could not attach to session ${sid}: ${err.message}`);
      }
    }

    if (unsubs.size === 0) {
      // No sessions could attach; mark job as failed so the user notices.
      await pool.query(
        `UPDATE scrape_monitor_jobs
           SET status='failed', reason=$1, completed_at=NOW(), updated_at=NOW()
         WHERE id=$2`,
        ['no sessions could attach (all disconnected?)', jobId]
      );
      emit(userId, 'monitor:failed', { jobId });
      return;
    }

    const timer = setTimeout(
      () => this._finishJob(jobId, userId).catch((e) =>
        logger.error(`Monitor job ${jobId} finishJob error: ${e.message}`)
      ),
      remainingSeconds * 1000
    );

    this._active.set(jobId, { unsubs, timer, userId, lastEmitAt: 0 });
  }

  async _detach(jobId) {
    const ctx = this._active.get(jobId);
    if (!ctx) return;
    try { clearTimeout(ctx.timer); } catch { /* ignore */ }
    for (const off of ctx.unsubs.values()) {
      try { off(); } catch { /* ignore */ }
    }
    this._active.delete(jobId);
  }

  async _finishJob(jobId, userId) {
    await this._detach(jobId);
    await pool.query(
      `UPDATE scrape_monitor_jobs
         SET status='completed', completed_at=NOW(), updated_at=NOW(),
             remaining_seconds = 0
       WHERE id=$1 AND status NOT IN ('cancelled','failed','completed')`,
      [jobId]
    );
    emit(userId, 'monitor:completed', { jobId });
  }

  async _onEvent(jobId, userId, sessionId, event) {
    try {
      const profile = await extractSenderProfile(event);
      if (!profile) return;
      const upserted = await pool.query(
        `INSERT INTO scrape_monitor_users
           (monitor_job_id, telegram_id, username, first_name, last_name,
            phone, is_bot, is_premium, message_count,
            first_seen_at, last_seen_at, via_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, NOW(), NOW(), $9)
         ON CONFLICT (monitor_job_id, telegram_id) DO UPDATE
            SET message_count = scrape_monitor_users.message_count + 1,
                last_seen_at  = NOW(),
                username      = COALESCE(EXCLUDED.username, scrape_monitor_users.username),
                first_name    = COALESCE(EXCLUDED.first_name, scrape_monitor_users.first_name),
                last_name     = COALESCE(EXCLUDED.last_name, scrape_monitor_users.last_name),
                phone         = COALESCE(EXCLUDED.phone, scrape_monitor_users.phone),
                is_premium    = scrape_monitor_users.is_premium OR EXCLUDED.is_premium,
                is_bot        = scrape_monitor_users.is_bot OR EXCLUDED.is_bot
         RETURNING xmax = 0 AS inserted`,
        [
          jobId, profile.telegramId, profile.username,
          profile.firstName, profile.lastName, profile.phone,
          !!profile.isBot, !!profile.isPremium, sessionId,
        ]
      );
      const inserted = upserted.rows[0]?.inserted;
      if (inserted) {
        await pool.query(
          `UPDATE scrape_monitor_jobs SET scraped_count = scraped_count + 1, updated_at=NOW() WHERE id=$1`,
          [jobId]
        );
      }

      // Debounced WS emit so a flood of messages doesn't drown the channel.
      const ctx = this._active.get(jobId);
      const now = Date.now();
      if (ctx && (now - ctx.lastEmitAt) >= PROGRESS_EMIT_DEBOUNCE_MS) {
        ctx.lastEmitAt = now;
        const r = await pool.query(
          `SELECT scraped_count FROM scrape_monitor_jobs WHERE id=$1`, [jobId]
        );
        emit(userId, 'monitor:progress', {
          jobId,
          scrapedCount: r.rows[0]?.scraped_count || 0,
          newUser: inserted ? {
            telegramId: String(profile.telegramId),
            username: profile.username,
            firstName: profile.firstName,
            lastName: profile.lastName,
          } : null,
        });
      }
    } catch (err) {
      logger.warn(`Monitor job ${jobId} event error: ${err.message}`);
    }
  }

  _toPublic(row) {
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      sessionIds: row.session_ids || [],
      targetId: row.target_id,
      targetType: row.target_type,
      targetTitle: row.target_title,
      status: row.status,
      durationSeconds: row.duration_seconds,
      remainingSeconds: row.remaining_seconds,
      scrapedCount: row.scraped_count,
      reason: row.reason,
      options: row.options || {},
      startedAt: row.started_at,
      pausedAt: row.paused_at,
      expiresAt: row.expires_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = new ScrapeMonitorService();
