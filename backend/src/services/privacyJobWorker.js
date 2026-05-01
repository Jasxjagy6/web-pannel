/**
 * Privacy Job Worker
 * --------------------------------------------------------------------
 * Background scheduler that drains queued privacy_jobs in the database
 * one at a time and processes their privacy_job_items session-by-session
 * via PrivacyService.applyToSession.
 *
 * Design notes:
 *
 *  * Single-process worker — we hold an in-memory `running` lock so a
 *    second tick never picks up the same job. Multiple processes would
 *    need a Postgres advisory lock, but the panel runs as one node.
 *
 *  * Concurrency is configurable via the PRIVACY_JOB_CONCURRENCY env
 *    var (default 3). When the user submits a job that targets 100
 *    sessions we don't fan all 100 out at once — we run them in batches
 *    of `concurrency`, with jittered cooldown between batches, so the
 *    proxy pool isn't slammed and Telegram doesn't see 100 simultaneous
 *    SetPrivacy invocations from the same /24.
 *
 *  * Per-session work goes through PrivacyService.applyToSession, which
 *    in turn calls telegramService._ensureConnected — that path already
 *    re-applies the persisted device_identity and bound proxy from the
 *    anti-detect feature, so no extra wiring is needed here.
 *
 *  * Cancellation: every batch checks the `cancel_requested` flag on
 *    the job row. If set, remaining items are marked 'skipped' and the
 *    job is finalized as 'cancelled'.
 */

'use strict';

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const privacyService = require('./privacyService');

const TICK_INTERVAL_MS = parseInt(process.env.PRIVACY_JOB_TICK_MS || '5000', 10);
const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.PRIVACY_JOB_CONCURRENCY || '3', 10)
);
const BATCH_COOLDOWN_MIN_MS = parseInt(process.env.PRIVACY_JOB_COOLDOWN_MIN_MS || '750', 10);
const BATCH_COOLDOWN_MAX_MS = parseInt(process.env.PRIVACY_JOB_COOLDOWN_MAX_MS || '2500', 10);

let timer = null;
let running = false;

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _jitter(min, max) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function _claimNextJob() {
  // Atomically move the oldest queued job into 'running'. We use
  // SKIP LOCKED so two concurrent callers can never see the same row.
  const { rows } = await pool.query(
    `WITH next AS (
        SELECT id FROM privacy_jobs
        WHERE status = 'pending'
          AND cancel_requested = FALSE
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE privacy_jobs j
        SET status = 'running',
            started_at = NOW()
       FROM next
      WHERE j.id = next.id
      RETURNING j.id, j.user_id, j.settings, j.total_sessions`
  );
  return rows[0] || null;
}

async function _markJobFinalized(jobId, status, errorMessage = null) {
  await pool.query(
    `UPDATE privacy_jobs
        SET status = $2,
            error_message = $3,
            finished_at = NOW()
      WHERE id = $1`,
    [jobId, status, errorMessage]
  );
}

async function _isCancelRequested(jobId) {
  const { rows } = await pool.query(
    `SELECT cancel_requested FROM privacy_jobs WHERE id = $1`,
    [jobId]
  );
  return !!(rows[0] && rows[0].cancel_requested);
}

async function _bumpJobCounters(jobId, succeededDelta, failedDelta, skippedDelta = 0) {
  await pool.query(
    `UPDATE privacy_jobs
        SET succeeded_count = succeeded_count + $2,
            failed_count    = failed_count    + $3,
            skipped_count   = skipped_count   + $4
      WHERE id = $1`,
    [jobId, succeededDelta, failedDelta, skippedDelta]
  );
}

async function _getPendingItems(jobId) {
  const { rows } = await pool.query(
    `SELECT id, session_id
       FROM privacy_job_items
      WHERE job_id = $1 AND status = 'pending'
      ORDER BY id ASC`,
    [jobId]
  );
  return rows;
}

async function _runItem(jobId, item, settings) {
  const itemId = item.id;
  const sessionId = item.session_id;
  await pool.query(
    `UPDATE privacy_job_items
        SET status = 'running',
            started_at = NOW(),
            attempts = attempts + 1
      WHERE id = $1`,
    [itemId]
  );

  try {
    const { results, succeeded, failed } = await privacyService.applyToSession(
      sessionId,
      settings
    );
    const overall = failed === 0 ? 'succeeded' : succeeded === 0 ? 'failed' : 'succeeded';
    await pool.query(
      `UPDATE privacy_job_items
          SET status = $2,
              results = $3::jsonb,
              error_code = $4,
              error_message = $5,
              finished_at = NOW()
        WHERE id = $1`,
      [
        itemId,
        overall,
        JSON.stringify(results),
        failed > 0 ? 'PARTIAL' : null,
        failed > 0
          ? `Partial: ${failed}/${succeeded + failed} keys failed`
          : null,
      ]
    );
    if (overall === 'succeeded') {
      await _bumpJobCounters(jobId, 1, 0, 0);
    } else {
      await _bumpJobCounters(jobId, 0, 1, 0);
    }
  } catch (err) {
    const code = (err && (err.errorMessage || err.code)) || 'ERROR';
    const message = (err && err.message) || String(err);
    logger.warn(
      `privacyJobWorker: session ${sessionId} job ${jobId} failed: ${code} - ${message}`
    );
    await pool.query(
      `UPDATE privacy_job_items
          SET status = 'failed',
              error_code = $2,
              error_message = $3,
              finished_at = NOW()
        WHERE id = $1`,
      [itemId, String(code).slice(0, 60), message.slice(0, 500)]
    );
    await _bumpJobCounters(jobId, 0, 1, 0);
  }
}

async function _markRemainingSkipped(jobId, reason) {
  const { rowCount } = await pool.query(
    `UPDATE privacy_job_items
        SET status = 'skipped',
            error_code = 'CANCELLED',
            error_message = $2,
            finished_at = NOW()
      WHERE job_id = $1 AND status IN ('pending','running')`,
    [jobId, reason]
  );
  if (rowCount > 0) {
    await _bumpJobCounters(jobId, 0, 0, rowCount);
  }
  return rowCount;
}

async function _processJob(job) {
  const jobId = job.id;
  const settings = job.settings || {};
  logger.info(
    `privacyJobWorker: starting job ${jobId} (user=${job.user_id}, sessions=${job.total_sessions})`
  );

  try {
    while (true) {
      if (await _isCancelRequested(jobId)) {
        await _markRemainingSkipped(jobId, 'job cancelled by user');
        await _markJobFinalized(jobId, 'cancelled');
        return;
      }

      const items = await _getPendingItems(jobId);
      if (items.length === 0) break;

      const batch = items.slice(0, CONCURRENCY);
      await Promise.all(batch.map((it) => _runItem(jobId, it, settings)));

      if (batch.length < items.length) {
        await _sleep(_jitter(BATCH_COOLDOWN_MIN_MS, BATCH_COOLDOWN_MAX_MS));
      }
    }

    // Determine final status from counters.
    const { rows } = await pool.query(
      `SELECT total_sessions, succeeded_count, failed_count, skipped_count
         FROM privacy_jobs WHERE id = $1`,
      [jobId]
    );
    const r = rows[0] || {};
    const finalStatus =
      r.failed_count > 0 && r.succeeded_count === 0
        ? 'failed'
        : 'completed';
    await _markJobFinalized(jobId, finalStatus);
    logger.info(
      `privacyJobWorker: finished job ${jobId} as ${finalStatus} ` +
        `(${r.succeeded_count}/${r.total_sessions} ok, ${r.failed_count} failed, ${r.skipped_count} skipped)`
    );
  } catch (err) {
    logger.error(
      `privacyJobWorker: job ${jobId} crashed`,
      { error: err && err.message }
    );
    await _markRemainingSkipped(jobId, 'worker crashed');
    await _markJobFinalized(jobId, 'failed', err && err.message);
  }
}

async function _tick() {
  if (running) return;
  running = true;
  try {
    while (true) {
      const job = await _claimNextJob();
      if (!job) break;
      await _processJob(job);
    }
  } catch (err) {
    logger.error('privacyJobWorker tick error', { error: err && err.message });
  } finally {
    running = false;
  }
}

async function _recoverOrphanedRows() {
  // Anything left in 'running' from a previous process crash is reset
  // back to 'pending' so the worker picks it up fresh on this tick.
  const { rowCount: jobsRecovered } = await pool.query(
    `UPDATE privacy_jobs SET status = 'pending', started_at = NULL
      WHERE status = 'running'`
  );
  const { rowCount: itemsRecovered } = await pool.query(
    `UPDATE privacy_job_items SET status = 'pending', started_at = NULL
      WHERE status = 'running'`
  );
  if (jobsRecovered || itemsRecovered) {
    logger.info(
      `privacyJobWorker: recovered ${jobsRecovered} stalled jobs and ${itemsRecovered} stalled items from previous run`
    );
  }
}

function startPrivacyJobWorker() {
  if (timer) return;
  timer = setInterval(() => {
    _tick().catch(() => {});
  }, TICK_INTERVAL_MS);
  // Kick once on boot so any queued-but-orphaned jobs from a crash are
  // resumed immediately.
  setTimeout(() => {
    _recoverOrphanedRows()
      .then(() => _tick())
      .catch((err) =>
        logger.error('privacyJobWorker boot recovery failed', {
          error: err && err.message,
        })
      );
  }, 1500);
  logger.info(
    `privacyJobWorker started (tick=${TICK_INTERVAL_MS}ms, concurrency=${CONCURRENCY})`
  );
}

function stopPrivacyJobWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startPrivacyJobWorker,
  stopPrivacyJobWorker,
  // exported for unit tests / admin tools
  _tick,
};
