/**
 * Monitor Service
 * ----------------
 * Long-running channel/group monitoring jobs. Once a scrape detects that a
 * group only exposes admin information (CHAT_ADMIN_REQUIRED), the user can
 * start a monitoring job that watches the chat for N seconds, polling new
 * history on a jittered tick and dropping every distinct sender into a
 * dedup'd `monitoring_users` table.
 *
 * Design goals:
 *   - O(1) timer footprint: ONE setInterval ticks every WORKER_TICK_MS, picks
 *     up to WORKER_BATCH_SIZE due jobs with FOR UPDATE SKIP LOCKED, and runs
 *     them concurrently. We do NOT spawn one timer per job.
 *   - Anti-detect aware: every Telegram call goes through the session's
 *     bound proxy + persisted device identity (handled by telegramService).
 *   - Round-robin sessions when multiple are bound to a job.
 *   - Strict dedup: ON CONFLICT (job_id, telegram_id) DO UPDATE only the
 *     last_seen / message_count counters; never mutates first_seen_at.
 *   - Crash-safe: state is in Postgres, the worker just polls. A restart
 *     resumes every running job from its last_offset_id.
 */

const { pool } = require('../config/database');
const tgService = require('../services/telegramService');
const logger = require('../utils/logger');

// --- Tunables (env-configurable) ---------------------------------------------
const WORKER_TICK_MS = parseInt(process.env.MONITOR_TICK_MS || '5000', 10);
const WORKER_BATCH_SIZE = parseInt(process.env.MONITOR_BATCH_SIZE || '4', 10);
const POLL_INTERVAL_MIN_MS = parseInt(process.env.MONITOR_POLL_MIN_MS || '20000', 10);
const POLL_INTERVAL_MAX_MS = parseInt(process.env.MONITOR_POLL_MAX_MS || '45000', 10);
const HISTORY_PAGE_LIMIT = parseInt(process.env.MONITOR_HISTORY_LIMIT || '100', 10);
const MAX_CONSECUTIVE_ERRORS = parseInt(process.env.MONITOR_MAX_ERRORS || '5', 10);
const MAX_DURATION_DAYS = parseInt(process.env.MONITOR_MAX_DAYS || '14', 10);

let workerHandle = null;

// =============================================================================
// Public API
// =============================================================================

/**
 * Validate the requested sessions actually belong to the caller and are
 * usable.
 *
 * @returns {Promise<{ok: boolean, error?: string, sessionIds?: number[]}>}
 */
async function validateSessions(userId, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return { ok: false, error: 'sessionIds is required' };
  }
  const ids = sessionIds.map((s) => parseInt(s, 10)).filter(Number.isInteger);
  if (ids.length === 0) return { ok: false, error: 'sessionIds invalid' };
  const r = await pool.query(
    `SELECT id, status, is_logged_in
       FROM sessions
      WHERE id = ANY($1::int[])
        AND user_id = $2`,
    [ids, userId]
  );
  if (r.rowCount !== ids.length) {
    return { ok: false, error: 'One or more sessions not found or not yours' };
  }
  const bad = r.rows.find((row) => !row.is_logged_in || row.status === 'banned');
  if (bad) return { ok: false, error: `Session ${bad.id} is not available (status=${bad.status})` };
  return { ok: true, sessionIds: ids };
}

/**
 * Create + start a monitoring job.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {number[]} params.sessionIds
 * @param {string} params.target          - link, username, numeric id
 * @param {number} params.durationSeconds
 * @param {number|null} [params.scrapingJobId] - origin scrape job (for audit)
 * @returns {Promise<object>}
 */
async function createMonitorJob({ userId, sessionIds, target, durationSeconds, scrapingJobId = null, options = {} }) {
  if (!target || typeof target !== 'string') {
    throw new Error('target is required');
  }
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
    throw new Error('durationSeconds must be a positive integer');
  }
  const cap = MAX_DURATION_DAYS * 86400;
  if (durationSeconds > cap) {
    throw new Error(`durationSeconds capped at ${cap} (${MAX_DURATION_DAYS} days)`);
  }

  const v = await validateSessions(userId, sessionIds);
  if (!v.ok) throw new Error(v.error);

  // Resolve the chat once via the first session so we can persist
  // target_id / target_title for the UI even if the input is a private
  // invite link or username.
  let resolved = { id: null, accessHash: null, title: null, type: null };
  try {
    const entity = await tgService._resolveEntity(v.sessionIds[0], target);
    if (entity) {
      resolved.id = entity.id ? String(entity.id) : null;
      resolved.accessHash = entity.accessHash ? String(entity.accessHash) : null;
      resolved.title = entity.title || entity.username || null;
      if (entity.megagroup) resolved.type = 'megagroup';
      else if (entity.broadcast) resolved.type = 'channel';
      else if (entity.className === 'Channel') resolved.type = 'channel';
      else resolved.type = 'group';
    }
  } catch (e) {
    logger.warn('monitor: failed to pre-resolve target, will retry on first tick', {
      target, err: e.message,
    });
  }

  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + durationSeconds * 1000);

  const insert = await pool.query(
    `INSERT INTO monitoring_jobs (
        user_id, scraping_job_id, target, target_type, target_id,
        target_access_hash, target_title, duration_seconds, started_at,
        ends_at, session_ids, current_session_idx, last_offset_id,
        next_poll_at, status, options, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11::int[], 0, 0, NOW(), 'running', $12::jsonb, NOW(), NOW())
      RETURNING *`,
    [
      userId, scrapingJobId, target,
      resolved.type, resolved.id, resolved.accessHash, resolved.title,
      durationSeconds, startedAt, endsAt,
      v.sessionIds, options || {},
    ]
  );
  logger.info('monitor: job created', {
    jobId: insert.rows[0].id, userId, target, durationSeconds,
    sessions: v.sessionIds, endsAt,
  });
  return insert.rows[0];
}

async function listJobs({ userId, limit = 50 }) {
  const r = await pool.query(
    `SELECT mj.*,
            (SELECT COUNT(*) FROM monitoring_users mu WHERE mu.job_id = mj.id) AS users_count
       FROM monitoring_jobs mj
      WHERE user_id = $1
   ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return r.rows;
}

async function getJob({ userId, jobId }) {
  const r = await pool.query(
    `SELECT mj.*,
            (SELECT COUNT(*) FROM monitoring_users mu WHERE mu.job_id = mj.id) AS users_count
       FROM monitoring_jobs mj
      WHERE mj.id = $1 AND mj.user_id = $2`,
    [jobId, userId]
  );
  return r.rows[0] || null;
}

async function listUsers({ userId, jobId, limit = 100, offset = 0, search = null }) {
  // Ownership check — never let one user read another's monitor users.
  const own = await pool.query(
    `SELECT id FROM monitoring_jobs WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );
  if (own.rowCount === 0) throw new Error('Job not found');

  const conds = ['job_id = $1'];
  const args = [jobId];
  if (search) {
    args.push(`%${String(search).toLowerCase()}%`);
    conds.push(`(LOWER(COALESCE(username, '')) LIKE $${args.length} OR LOWER(COALESCE(first_name, '')) LIKE $${args.length})`);
  }
  const where = conds.join(' AND ');

  const total = await pool.query(
    `SELECT COUNT(*)::int AS n FROM monitoring_users WHERE ${where}`,
    args
  );

  args.push(limit, offset);
  const list = await pool.query(
    `SELECT * FROM monitoring_users
      WHERE ${where}
      ORDER BY last_seen_at DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args
  );
  return { users: list.rows, total: total.rows[0].n };
}

async function pauseJob({ userId, jobId }) {
  const r = await pool.query(
    `UPDATE monitoring_jobs
        SET status = 'paused',
            paused_at = NOW(),
            pause_remaining_seconds = GREATEST(0,
              EXTRACT(EPOCH FROM (ends_at - NOW()))::int
            ),
            updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'running'
      RETURNING *`,
    [jobId, userId]
  );
  if (r.rowCount === 0) throw new Error('Job not running or not yours');
  return r.rows[0];
}

async function resumeJob({ userId, jobId }) {
  const r = await pool.query(
    `UPDATE monitoring_jobs
        SET status = 'running',
            ends_at = NOW() + (COALESCE(pause_remaining_seconds, 0) || ' seconds')::interval,
            paused_at = NULL,
            pause_remaining_seconds = NULL,
            next_poll_at = NOW(),
            consecutive_errors = 0,
            updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'paused'
      RETURNING *`,
    [jobId, userId]
  );
  if (r.rowCount === 0) throw new Error('Job not paused or not yours');
  return r.rows[0];
}

async function stopJob({ userId, jobId }) {
  const r = await pool.query(
    `UPDATE monitoring_jobs
        SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status IN ('running', 'paused', 'pending')
      RETURNING *`,
    [jobId, userId]
  );
  if (r.rowCount === 0) throw new Error('Job not running/paused or not yours');
  return r.rows[0];
}

async function cancelAll({ userId }) {
  const r = await pool.query(
    `UPDATE monitoring_jobs
        SET status = 'cancelled', updated_at = NOW()
      WHERE user_id = $1 AND status IN ('running', 'paused', 'pending')
      RETURNING id`,
    [userId]
  );
  return { cancelled: r.rowCount, ids: r.rows.map((x) => x.id) };
}

// =============================================================================
// Worker
// =============================================================================

function startWorker() {
  if (workerHandle) return;
  if (process.env.MONITOR_ENABLED === 'false') {
    logger.info('monitorService: disabled via MONITOR_ENABLED=false');
    return;
  }
  workerHandle = setInterval(() => {
    workerTick().catch((err) => logger.error('monitorService: tick crashed', { err: err.message }));
  }, WORKER_TICK_MS);
  logger.info(`monitorService: worker started (tick=${WORKER_TICK_MS}ms, batch=${WORKER_BATCH_SIZE})`);
}

function stopWorker() {
  if (workerHandle) clearInterval(workerHandle);
  workerHandle = null;
}

async function workerTick() {
  // Mark expired jobs as completed first.
  await pool.query(
    `UPDATE monitoring_jobs
        SET status = 'completed', updated_at = NOW()
      WHERE status = 'running' AND ends_at <= NOW()`
  );

  // Atomically claim a small batch of due running jobs.
  const claim = await pool.query(
    `WITH due AS (
       SELECT id
         FROM monitoring_jobs
        WHERE status = 'running'
          AND next_poll_at <= NOW()
          AND ends_at > NOW()
        ORDER BY next_poll_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE monitoring_jobs mj
        SET next_poll_at = NOW() + ($2 || ' milliseconds')::interval
       FROM due
      WHERE mj.id = due.id
      RETURNING mj.*`,
    [WORKER_BATCH_SIZE, POLL_INTERVAL_MAX_MS * 2]
  );
  if (claim.rowCount === 0) return;

  await Promise.all(claim.rows.map((job) => runJobOnce(job).catch((err) => {
    logger.error(`monitor[${job.id}]: tick failed`, { err: err.message });
    return markError(job.id, err.message);
  })));
}

async function runJobOnce(job) {
  const sessionIds = Array.isArray(job.session_ids) ? job.session_ids : [];
  if (sessionIds.length === 0) {
    await markError(job.id, 'no sessions bound');
    return;
  }
  // Round-robin which session this tick uses.
  const idx = (job.current_session_idx || 0) % sessionIds.length;
  const sessionId = sessionIds[idx];

  // Resolve the entity (uses cached state in telegramService when possible).
  let entity;
  try {
    entity = await tgService._resolveEntity(sessionId, job.target);
  } catch (e) {
    return markError(job.id, `resolve failed: ${e.message}`);
  }
  if (!entity) {
    return markError(job.id, 'could not resolve target');
  }

  // Pull new messages since the last cursor. We use the gramJS shorthand
  // `getMessages` which paginates on minId for us.
  const client = tgService.clients.get(String(sessionId))?.client;
  if (!client) {
    return markError(job.id, `session ${sessionId} not connected`);
  }

  let messages;
  try {
    messages = await tgService._withFloodRetry(sessionId, async () =>
      client.getMessages(entity, {
        limit: HISTORY_PAGE_LIMIT,
        minId: Number(job.last_offset_id) || 0,
      })
    );
  } catch (e) {
    if (/FLOOD_WAIT/i.test(e.message)) {
      // Push next poll out by the flood wait.
      const m = e.message.match(/(\d+)/);
      const wait = m ? Math.min(parseInt(m[1], 10), 600) : 60;
      await pool.query(
        `UPDATE monitoring_jobs
            SET next_poll_at = NOW() + ($2 || ' seconds')::interval,
                last_error = $3,
                updated_at = NOW()
          WHERE id = $1`,
        [job.id, wait, `FLOOD_WAIT ${wait}s`]
      );
      logger.warn(`monitor[${job.id}]: flood wait ${wait}s`);
      return;
    }
    return markError(job.id, `getMessages: ${e.message}`);
  }

  if (!messages || messages.length === 0) {
    // Nothing new — schedule the next poll with jitter.
    return scheduleNextPoll(job, sessionIds, idx, /*newOffset*/ job.last_offset_id, /*scraped*/ 0);
  }

  // Telegram returns newest first. Track the largest message id so we don't
  // re-fetch the same window next tick.
  let maxId = Number(job.last_offset_id) || 0;
  let collected = 0;

  for (const m of messages) {
    if (m.id > maxId) maxId = m.id;
    const sender = extractSender(m);
    if (!sender || !sender.telegramId) continue;
    const inserted = await upsertMonitoredUser(job.id, sender, m);
    if (inserted) collected++;
  }

  await scheduleNextPoll(job, sessionIds, idx, maxId, collected, messages.length);
}

function extractSender(message) {
  // Prefer the sender object if gramJS hydrated it; fall back to the raw
  // peer id.
  const s = message.sender || message.fromUser || null;
  if (s && (s.id || s.userId)) {
    return {
      telegramId: String(s.id ?? s.userId),
      username: s.username || null,
      firstName: s.firstName || null,
      lastName: s.lastName || null,
      phone: s.phone || null,
      isBot: Boolean(s.bot),
      isPremium: Boolean(s.premium),
    };
  }
  // Anonymous channel admins / chat events have no user — skip.
  if (!message.fromId) return null;
  if (message.fromId.className !== 'PeerUser') return null;
  return {
    telegramId: String(message.fromId.userId),
    username: null, firstName: null, lastName: null,
    phone: null, isBot: false, isPremium: false,
  };
}

async function upsertMonitoredUser(jobId, sender, message) {
  const text = message.message ? String(message.message).slice(0, 4000) : null;
  const r = await pool.query(
    `INSERT INTO monitoring_users (
        job_id, telegram_id, username, first_name, last_name, phone,
        is_premium, is_bot, source, message_count,
        first_seen_at, last_seen_at, last_message_id, last_message_text)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'message', 1,
              NOW(), NOW(), $9, $10)
      ON CONFLICT (job_id, telegram_id) DO UPDATE SET
        message_count = monitoring_users.message_count + 1,
        last_seen_at = NOW(),
        last_message_id = EXCLUDED.last_message_id,
        last_message_text = EXCLUDED.last_message_text,
        username = COALESCE(EXCLUDED.username, monitoring_users.username),
        first_name = COALESCE(EXCLUDED.first_name, monitoring_users.first_name),
        last_name = COALESCE(EXCLUDED.last_name, monitoring_users.last_name),
        phone = COALESCE(EXCLUDED.phone, monitoring_users.phone)
      RETURNING (xmax = 0) AS inserted`,
    [
      jobId, sender.telegramId, sender.username, sender.firstName, sender.lastName,
      sender.phone, sender.isPremium, sender.isBot,
      message.id ? Number(message.id) : null, text,
    ]
  );
  return r.rows[0]?.inserted === true;
}

async function scheduleNextPoll(job, sessionIds, lastIdx, newOffset, scrapedThisTick, fetchedThisTick = 0) {
  // Random jitter so we look like a real client.
  const jitter = POLL_INTERVAL_MIN_MS + Math.floor(Math.random() * (POLL_INTERVAL_MAX_MS - POLL_INTERVAL_MIN_MS));
  const nextIdx = (lastIdx + 1) % sessionIds.length;
  await pool.query(
    `UPDATE monitoring_jobs
        SET last_offset_id = $2,
            next_poll_at = NOW() + ($3 || ' milliseconds')::interval,
            current_session_idx = $4,
            scraped_count = scraped_count + $5,
            ticks_completed = ticks_completed + 1,
            consecutive_errors = 0,
            last_error = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [job.id, Number(newOffset) || 0, jitter, nextIdx, scrapedThisTick]
  );
  if (scrapedThisTick > 0 || fetchedThisTick > 0) {
    logger.debug(`monitor[${job.id}]: tick ok — fetched=${fetchedThisTick} new=${scrapedThisTick}, next in ~${Math.round(jitter / 1000)}s`);
  }
}

async function markError(jobId, message) {
  const r = await pool.query(
    `UPDATE monitoring_jobs
        SET consecutive_errors = consecutive_errors + 1,
            last_error = $2,
            next_poll_at = NOW() + INTERVAL '60 seconds',
            updated_at = NOW(),
            status = CASE
              WHEN consecutive_errors + 1 >= $3 THEN 'error'
              ELSE status
            END
      WHERE id = $1
      RETURNING status, consecutive_errors`,
    [jobId, message?.slice(0, 1000) || 'unknown', MAX_CONSECUTIVE_ERRORS]
  );
  if (r.rows[0]?.status === 'error') {
    logger.error(`monitor[${jobId}]: gave up after ${r.rows[0].consecutive_errors} errors: ${message}`);
  } else {
    logger.warn(`monitor[${jobId}]: tick error #${r.rows[0]?.consecutive_errors}: ${message}`);
  }
}

module.exports = {
  // Queries
  validateSessions,
  createMonitorJob,
  listJobs,
  getJob,
  listUsers,
  // State transitions
  pauseJob,
  resumeJob,
  stopJob,
  cancelAll,
  // Worker
  startWorker,
  stopWorker,
};
