/**
 * Story Job Worker
 * --------------------------------------------------------------------
 * Background scheduler that drains queued story_jobs one at a time and
 * posts the story on each targeted session, session-by-session.
 *
 * Per session:
 *   1. Skip rows already marked 'skipped' at creation (non-premium /
 *      not-connected pre-filter).
 *   2. Re-verify eligibility live via telegramService.canSendStory
 *      (authoritative Premium/eligibility check).
 *   3. Post via telegramService.sendStory (photo/video + caption + link).
 *
 * Sequential with a jittered delay between sessions so we don't fan a
 * fleet of simultaneous SendStory calls out of the same /24. Cancellation
 * is honored before each pending item. When the last job's media is no
 * longer referenced by any non-terminal job, the temp file is removed.
 */

'use strict';

const fs = require('fs');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const tgService = require('./telegramService');

const TICK_INTERVAL_MS = parseInt(process.env.STORY_JOB_TICK_MS || '5000', 10);
const ITEM_DELAY_MIN_MS = parseInt(process.env.STORY_JOB_DELAY_MIN_MS || '1500', 10);
const ITEM_DELAY_MAX_MS = parseInt(process.env.STORY_JOB_DELAY_MAX_MS || '4000', 10);

let timer = null;
let running = false;

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function _jitter(min, max) {
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

async function _claimNextJob() {
  // Atomically flip one pending job to running and return it.
  const { rows } = await pool.query(
    `UPDATE story_jobs
        SET status = 'running', started_at = COALESCE(started_at, NOW())
      WHERE id = (
        SELECT id FROM story_jobs
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`
  );
  return rows[0] || null;
}

async function _isCancelRequested(jobId) {
  const { rows } = await pool.query(
    `SELECT cancel_requested FROM story_jobs WHERE id = $1`,
    [jobId]
  );
  return !!(rows[0] && rows[0].cancel_requested);
}

async function _pendingItems(jobId) {
  const { rows } = await pool.query(
    `SELECT id, session_id, session_label FROM story_job_items
      WHERE job_id = $1 AND status = 'pending'
      ORDER BY id ASC`,
    [jobId]
  );
  return rows;
}

async function _bump(jobId, field) {
  const col = { posted: 'succeeded_count', failed: 'failed_count', skipped: 'skipped_count' }[field];
  if (!col) return;
  await pool.query(
    `UPDATE story_jobs SET ${col} = ${col} + 1 WHERE id = $1`,
    [jobId]
  );
}

async function _finishItem(itemId, status, { skipReason = null, storyId = null, error = null } = {}) {
  await pool.query(
    `UPDATE story_job_items
        SET status = $2, skip_reason = $3, story_id = $4, error_message = $5,
            attempts = attempts + 1, finished_at = NOW()
      WHERE id = $1`,
    [itemId, status, skipReason, storyId, error ? String(error).slice(0, 500) : null]
  );
}

async function _markRemainingSkipped(jobId, reason) {
  const { rows } = await pool.query(
    `UPDATE story_job_items
        SET status = 'skipped', skip_reason = $2, finished_at = NOW()
      WHERE job_id = $1 AND status = 'pending'
      RETURNING id`,
    [jobId, reason]
  );
  if (rows.length) {
    await pool.query(
      `UPDATE story_jobs SET skipped_count = skipped_count + $2 WHERE id = $1`,
      [jobId, rows.length]
    );
  }
}

async function _finalize(jobId, status, errorMessage = null) {
  await pool.query(
    `UPDATE story_jobs
        SET status = $2, error_message = $3, finished_at = NOW()
      WHERE id = $1`,
    [jobId, status, errorMessage]
  );
  // Best-effort media cleanup once no live job still references the file.
  try {
    const { rows } = await pool.query(`SELECT media_path FROM story_jobs WHERE id = $1`, [jobId]);
    const mediaPath = rows[0] && rows[0].media_path;
    if (mediaPath) {
      const { rows: refs } = await pool.query(
        `SELECT 1 FROM story_jobs
          WHERE media_path = $1 AND status IN ('pending','running') LIMIT 1`,
        [mediaPath]
      );
      if (refs.length === 0 && fs.existsSync(mediaPath)) {
        fs.unlink(mediaPath, () => {});
      }
    }
  } catch (err) {
    logger.debug(`storyJobWorker: media cleanup skipped for job ${jobId}: ${err.message}`);
  }
}

async function _runItem(job, item) {
  const sid = String(item.session_id);
  await pool.query(
    `UPDATE story_job_items SET started_at = NOW() WHERE id = $1`,
    [item.id]
  );

  // Live premium / eligibility re-check.
  let can;
  try {
    can = await tgService.canSendStory(sid);
  } catch (err) {
    await _finishItem(item.id, 'failed', { error: err.message });
    await _bump(job.id, 'failed');
    return;
  }
  if (!can.ok) {
    await _finishItem(item.id, 'skipped', { skipReason: can.reason || 'cannot_send' });
    await _bump(job.id, 'skipped');
    return;
  }

  // Post the story.
  try {
    const { storyId } = await tgService.sendStory(sid, {
      filePath: job.media_path,
      mediaType: job.media_type,
      fileName: job.media_name,
      caption: job.caption || '',
      linkUrl: job.link_url || '',
      privacy: job.privacy,
      periodSeconds: job.period_seconds,
      pinToProfile: job.pin_to_profile,
    });
    await _finishItem(item.id, 'posted', { storyId: storyId || null });
    await _bump(job.id, 'posted');
  } catch (err) {
    const msg = (err && err.message) || String(err);
    // Premium/eligibility rejections at send time are a SKIP (account not
    // eligible), not a failure — CanSendStory can pass while the account's
    // Premium lapsed, or Telegram enforces it only at SendStory. Keep the
    // history honest: these count as skipped, not failed.
    if (/PREMIUM_ACCOUNT_REQUIRED|PREMIUM/i.test(msg)) {
      await _finishItem(item.id, 'skipped', { skipReason: 'not_premium', error: msg });
      await _bump(job.id, 'skipped');
    } else if (/STORIES_TOO_MUCH|STORY_SEND_FLOOD|STORY_PERIOD_INVALID/i.test(msg)) {
      await _finishItem(item.id, 'skipped', { skipReason: 'limit_reached', error: msg });
      await _bump(job.id, 'skipped');
    } else {
      await _finishItem(item.id, 'failed', { error: msg });
      await _bump(job.id, 'failed');
    }
  }
}

async function _processJob(job) {
  const jobId = job.id;
  logger.info(`storyJobWorker: starting job ${jobId} (user=${job.user_id}, total=${job.total_sessions})`);
  try {
    // Pre-skipped items already counted at creation; only iterate pending.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (await _isCancelRequested(jobId)) {
        await _markRemainingSkipped(jobId, 'cancelled');
        await _finalize(jobId, 'cancelled');
        logger.info(`storyJobWorker: job ${jobId} cancelled`);
        return;
      }
      const items = await _pendingItems(jobId);
      if (items.length === 0) break;

      const item = items[0];
      // eslint-disable-next-line no-await-in-loop
      await _runItem(job, item);
      // eslint-disable-next-line no-await-in-loop
      await _sleep(_jitter(ITEM_DELAY_MIN_MS, ITEM_DELAY_MAX_MS));
    }

    const { rows } = await pool.query(
      `SELECT total_sessions, succeeded_count, failed_count, skipped_count
         FROM story_jobs WHERE id = $1`,
      [jobId]
    );
    const r = rows[0] || {};
    const finalStatus =
      r.succeeded_count > 0 ? 'completed'
        : r.failed_count > 0 ? 'failed'
        : 'completed'; // all skipped (e.g. none premium) still "completed"
    await _finalize(jobId, finalStatus);
    logger.info(
      `storyJobWorker: finished job ${jobId} as ${finalStatus} ` +
      `(${r.succeeded_count} posted, ${r.failed_count} failed, ${r.skipped_count} skipped)`
    );
  } catch (err) {
    logger.error(`storyJobWorker: job ${jobId} crashed: ${err && err.message}`);
    await _markRemainingSkipped(jobId, 'worker_crashed').catch(() => {});
    await _finalize(jobId, 'failed', err && err.message);
  }
}

async function _tick() {
  if (running) return;
  running = true;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const job = await _claimNextJob();
      if (!job) break;
      await _processJob(job);
    }
  } catch (err) {
    logger.error(`storyJobWorker tick error: ${err && err.message}`);
  } finally {
    running = false;
  }
}

async function _recoverOrphaned() {
  // Reset any job/item left 'running' by a previous crash back to pending.
  await pool.query(
    `UPDATE story_jobs SET status = 'pending', started_at = NULL WHERE status = 'running'`
  ).catch(() => {});
}

function startStoryJobWorker() {
  if (timer) return;
  _recoverOrphaned()
    .catch(() => {})
    .finally(() => {
      timer = setInterval(() => {
        _tick().catch((err) => logger.error(`storyJobWorker: ${err.message}`));
      }, TICK_INTERVAL_MS);
      if (timer.unref) timer.unref();
      logger.info(`storyJobWorker started (tick=${TICK_INTERVAL_MS}ms)`);
    });
}

function stopStoryJobWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startStoryJobWorker, stopStoryJobWorker, _processJob, runSweepOnce: _tick };
