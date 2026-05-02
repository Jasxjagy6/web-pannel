/**
 * Instagram messaging subsystem (provider.messaging.*).
 *
 * Bulk DM is the IG analog of TG's bulk-message-to-users:
 *   - target_list: array of { username | user_pk } objects
 *   - message_content: text body
 *   - per-account warmup caps from sessions.platform_state.warmup
 *   - jitter delay between sends from system_settings.messaging.instagram.*
 *
 * Uses the existing messaging_jobs / message_logs tables (now platform-aware).
 * Per-job, per-account warmup state lives in messaging_jobs.platform_state
 * and sessions.platform_state.warmup.
 */

const { pool } = require('../../config/database');
const logger = require('../../utils/logger');
const igClient = require('./client');
const systemSettings = require('../../services/systemSettingsService');

const PLATFORM = 'instagram';

async function _setting(key, fallback) {
  const v = await systemSettings.getSetting(key);
  if (v == null) return fallback;
  return v;
}

function _jitter(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function _getJob(jobId) {
  const r = await pool.query(`SELECT * FROM messaging_jobs WHERE id = $1`, [jobId]);
  return r.rows[0] || null;
}

async function _setJobStatus(jobId, status, extras = {}) {
  const fields = ['status = $1'];
  const values = [status];
  let p = 2;
  for (const col of ['sent_count', 'failed_count', 'skipped_count', 'total_count']) {
    if (extras[col] !== undefined) {
      fields.push(`${col} = $${p++}`);
      values.push(extras[col]);
    }
  }
  if (extras.error) { fields.push(`error_message = $${p++}`); values.push(extras.error); }
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    fields.push(`completed_at = NOW()`);
  }
  values.push(jobId);
  await pool.query(`UPDATE messaging_jobs SET ${fields.join(', ')} WHERE id = $${p}`, values);
}

async function _logSend({ jobId, sessionId, targetId, status, error = null }) {
  await pool.query(
    `INSERT INTO message_logs
       (job_id, session_id, target_id, status, error_message, platform, sent_at)
     VALUES ($1, $2, $3, $4, $5, 'instagram', NOW())`,
    [jobId, sessionId, targetId, status, error]
  );
}

/**
 * Pull (and lazily initialise) the warmup counter blob from
 * sessions.platform_state. Resets daily / hourly counters when their
 * window has elapsed.
 */
async function _readWarmup(sessionId) {
  const r = await pool.query(`SELECT platform_state FROM sessions WHERE id = $1`, [sessionId]);
  const ps = r.rows[0]?.platform_state || {};
  const warmup = ps.warmup || {};
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH

  if (warmup.day !== today)   { warmup.day = today;   warmup.daily_sent = 0; }
  if (warmup.hour !== hour)   { warmup.hour = hour;   warmup.hourly_sent = 0; }
  warmup.lifetime_sent = warmup.lifetime_sent || 0;
  warmup.last_sent_at = warmup.last_sent_at || null;
  return { warmup, platformState: ps };
}

async function _writeWarmup(sessionId, platformState, warmup) {
  await pool.query(
    `UPDATE sessions
        SET platform_state = $1::jsonb,
            updated_at = NOW()
      WHERE id = $2`,
    [JSON.stringify({ ...platformState, warmup }), sessionId]
  );
}

async function _recordWarmupHistory({ sessionId, userId, decision, daily_sent, daily_cap, hourly_sent, hourly_cap }) {
  const now = new Date();
  await pool.query(
    `INSERT INTO ig_warmup_history
       (session_id, user_id, date, hour, decision,
        daily_sent, daily_cap, hourly_sent, hourly_cap, recorded_at)
     VALUES ($1, $2, CURRENT_DATE, EXTRACT(HOUR FROM NOW())::int,
             $3, $4, $5, $6, $7, NOW())`,
    [sessionId, userId, decision, daily_sent, daily_cap, hourly_sent, hourly_cap]
  );
}

/**
 * Check whether this account is allowed to send right now. Returns
 *   { allowed: true } or { allowed: false, reason: 'capped_daily' | ... }
 */
async function _checkWarmup(session, dailyCap, hourlyCap) {
  const { warmup, platformState } = await _readWarmup(session.id);
  if (warmup.daily_sent >= dailyCap) {
    return { allowed: false, reason: 'capped_daily', warmup, platformState, dailyCap, hourlyCap };
  }
  if (warmup.hourly_sent >= hourlyCap) {
    return { allowed: false, reason: 'capped_hourly', warmup, platformState, dailyCap, hourlyCap };
  }
  return { allowed: true, warmup, platformState, dailyCap, hourlyCap };
}

async function _applySend(session, warmup, platformState) {
  warmup.daily_sent += 1;
  warmup.hourly_sent += 1;
  warmup.lifetime_sent += 1;
  warmup.last_sent_at = new Date().toISOString();
  await _writeWarmup(session.id, platformState, warmup);
}

/**
 * Public: enqueue a bulk-DM job.
 *   await provider.messaging.sendBulk({
 *     userId, sessionIds, targetList: [{ username }, ...],
 *     messageContent, options
 *   })
 */
async function sendBulk({
  userId,
  sessionIds = [],
  targetList = [],
  messageContent = '',
  messageType = 'text',
  mediaPath = null,
  options = {},
}) {
  if (!userId) throw new Error('userId required');
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new Error('At least one sessionId required');
  }
  if (!Array.isArray(targetList) || targetList.length === 0) {
    throw new Error('Non-empty targetList required');
  }
  if (messageType === 'text' && !messageContent) {
    throw new Error('messageContent required for text messages');
  }

  const totalTargets = targetList.length;

  const insert = await pool.query(
    `INSERT INTO messaging_jobs
       (user_id, platform, session_id, job_type, target_list, message_content,
        message_type, media_path, status, total_count, options, platform_state,
        created_at)
     VALUES ($1, 'instagram', $2, 'dm_bulk', $3::jsonb, $4, $5, $6,
             'pending', $7, $8::jsonb, '{}'::jsonb, NOW())
     RETURNING id, status, created_at`,
    [
      userId,
      sessionIds[0],
      JSON.stringify(targetList),
      messageContent,
      messageType,
      mediaPath,
      totalTargets,
      JSON.stringify({ session_ids: sessionIds, ...options }),
    ]
  );
  const jobRow = insert.rows[0];

  try {
    // eslint-disable-next-line global-require
    const queueManager = require('../../config/queueManager');
    if (queueManager && queueManager.enqueueMessaging) {
      await queueManager.enqueueMessaging({ jobId: jobRow.id, platform: 'instagram' });
    } else {
      throw new Error('queueManager has no enqueueMessaging');
    }
  } catch (err) {
    logger.warn(`IG.messaging.sendBulk: queue enqueue failed (${err.message}); running inline`);
    setImmediate(() => _executeMessagingJob(jobRow.id).catch((e) =>
      logger.error(`IG.messaging inline exec failed: ${e.message}`)
    ));
  }

  return jobRow;
}

async function _executeMessagingJob(jobId) {
  const job = await _getJob(jobId);
  if (!job) return;
  if (job.platform !== 'instagram') return;

  await _setJobStatus(jobId, 'running');

  const opts = job.options || {};
  const sessionIds = opts.session_ids || [job.session_id];

  const sessRows = await pool.query(
    `SELECT id, user_id, username, proxy_url, session_data, platform_state
       FROM sessions
      WHERE id = ANY($1::int[]) AND platform = 'instagram'
        AND is_logged_in = TRUE`,
    [sessionIds]
  );
  if (sessRows.rows.length === 0) {
    await _setJobStatus(jobId, 'failed', { error: 'No usable IG sessions' });
    return;
  }

  const dailyCap = Number(await _setting('messaging.instagram.daily_cap_default', 30));
  const hourlyCap = Number(await _setting('messaging.instagram.hourly_cap_default', 10));
  const jitterMin = Number(await _setting('messaging.instagram.send_jitter_ms_min', 4000));
  const jitterMax = Number(await _setting('messaging.instagram.send_jitter_ms_max', 12000));

  const targets = job.target_list || [];

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let sessionIdx = 0;

  for (const target of targets) {
    let attempted = false;

    for (let tries = 0; tries < sessRows.rows.length && !attempted; tries++) {
      const session = sessRows.rows[(sessionIdx + tries) % sessRows.rows.length];
      const gate = await _checkWarmup(session, dailyCap, hourlyCap);

      if (!gate.allowed) {
        await _recordWarmupHistory({
          sessionId: session.id,
          userId: session.user_id,
          decision: gate.reason,
          daily_sent: gate.warmup.daily_sent,
          daily_cap: dailyCap,
          hourly_sent: gate.warmup.hourly_sent,
          hourly_cap: hourlyCap,
        });
        continue; // try the next session
      }

      attempted = true;
      try {
        const client = await igClient.getClient(session);
        let recipientPk = null;
        if (target.user_pk) {
          recipientPk = String(target.user_pk);
        } else if (target.username) {
          recipientPk = String(await client.user.getIdByUsername(String(target.username).replace(/^@/, '').toLowerCase()));
        } else {
          throw new Error('target needs username or user_pk');
        }
        const thread = client.entity.directThread([recipientPk]);
        await thread.broadcastText(job.message_content);

        await _applySend(session, gate.warmup, gate.platformState);
        await _logSend({
          jobId,
          sessionId: session.id,
          targetId: recipientPk,
          status: 'sent',
        });
        await _recordWarmupHistory({
          sessionId: session.id,
          userId: session.user_id,
          decision: 'sent',
          daily_sent: gate.warmup.daily_sent,
          daily_cap: dailyCap,
          hourly_sent: gate.warmup.hourly_sent,
          hourly_cap: hourlyCap,
        });

        sent += 1;
        sessionIdx = (sessionIdx + 1) % sessRows.rows.length;
        await _setJobStatus(jobId, 'running', { sent_count: sent, failed_count: failed, skipped_count: skipped });
        await _sleep(_jitter(jitterMin, jitterMax));
      } catch (err) {
        failed += 1;
        await _logSend({
          jobId,
          sessionId: session.id,
          targetId: target.user_pk || target.username || null,
          status: 'failed',
          error: err.message,
        });
        await _setJobStatus(jobId, 'running', { sent_count: sent, failed_count: failed, skipped_count: skipped });
      }
    }

    if (!attempted) {
      skipped += 1;
      await _setJobStatus(jobId, 'running', { sent_count: sent, failed_count: failed, skipped_count: skipped });
    }
  }

  await _setJobStatus(jobId, 'completed', {
    sent_count: sent,
    failed_count: failed,
    skipped_count: skipped,
  });
}

async function listJobs(userId, opts = {}) {
  const { page = 1, limit = 20 } = opts;
  const offset = Math.max(0, (page - 1) * limit);
  const r = await pool.query(
    `SELECT * FROM messaging_jobs
      WHERE user_id = $1 AND platform = 'instagram'
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  const c = await pool.query(
    `SELECT COUNT(*)::int AS n FROM messaging_jobs
      WHERE user_id = $1 AND platform = 'instagram'`,
    [userId]
  );
  return { jobs: r.rows, total: c.rows[0].n, page, limit };
}

async function cancelJob(jobId, userId) {
  const job = await pool.query(
    `SELECT id, status FROM messaging_jobs WHERE id = $1 AND user_id = $2 AND platform = 'instagram'`,
    [jobId, userId]
  );
  if (job.rows.length === 0) {
    const e = new Error('Job not found');
    e.statusCode = 404;
    throw e;
  }
  if (['completed', 'failed', 'cancelled'].includes(job.rows[0].status)) {
    return { id: jobId, status: job.rows[0].status };
  }
  await _setJobStatus(jobId, 'cancelled');
  return { id: jobId, status: 'cancelled' };
}

module.exports = {
  PLATFORM,
  sendBulk,
  sendToTarget: sendBulk,
  sendToGroup: () => { throw new Error('Send-to-group is TG-only; use sendToThread'); },
  forwardMessage: () => { throw new Error('Message forwarding is TG-only on the IG private API'); },
  listJobs,
  list: listJobs,
  cancelJob,
  cancel: cancelJob,
  _executeMessagingJob,
};
