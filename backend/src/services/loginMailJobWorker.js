/**
 * Login-Mail Job Worker
 * --------------------------------------------------------------------
 * Background scheduler that drains queued login_mail_jobs one at a time.
 * For every session in a job it:
 *
 *   1. Sends a verification code to the email via MTProto.
 *   2. Polls the email inbox via IMAP for the Telegram OTP.
 *   3. Submits the OTP back to Telegram to verify the login email.
 *
 * Design mirrors privacyJobWorker.js: single-process, batched
 * concurrency with jittered cooldown, cancel-aware, crash-recoverable.
 */

'use strict';

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const loginMailService = require('./loginMailService');
const emailReaderService = require('./emailReaderService');
const { decrypt } = require('../utils/crypto');

const TICK_INTERVAL_MS = parseInt(process.env.LOGIN_MAIL_JOB_TICK_MS || '5000', 10);
const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.LOGIN_MAIL_JOB_CONCURRENCY || '1', 10)
);
const BATCH_COOLDOWN_MIN_MS = parseInt(process.env.LOGIN_MAIL_COOLDOWN_MIN_MS || '2000', 10);
const BATCH_COOLDOWN_MAX_MS = parseInt(process.env.LOGIN_MAIL_COOLDOWN_MAX_MS || '5000', 10);
// How long to wait for the OTP email to arrive (ms).
const OTP_TIMEOUT_MS = parseInt(process.env.LOGIN_MAIL_OTP_TIMEOUT_MS || '90000', 10);

let timer = null;
let running = false;

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _jitter(min, max) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// -----------------------------------------------------------------------
// Job lifecycle helpers (same pattern as privacyJobWorker)
// -----------------------------------------------------------------------

async function _claimNextJob() {
  const { rows } = await pool.query(
    `WITH next AS (
        SELECT id FROM login_mail_jobs
        WHERE status = 'pending'
          AND cancel_requested = FALSE
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE login_mail_jobs j
        SET status = 'running',
            started_at = NOW()
       FROM next
      WHERE j.id = next.id
      RETURNING j.id, j.user_id, j.email, j.credential_id, j.total_sessions`
  );
  return rows[0] || null;
}

async function _markJobFinalized(jobId, status, errorMessage = null) {
  await pool.query(
    `UPDATE login_mail_jobs
        SET status = $2,
            error_message = $3,
            finished_at = NOW()
      WHERE id = $1`,
    [jobId, status, errorMessage]
  );
}

async function _isCancelRequested(jobId) {
  const { rows } = await pool.query(
    `SELECT cancel_requested FROM login_mail_jobs WHERE id = $1`,
    [jobId]
  );
  return !!(rows[0] && rows[0].cancel_requested);
}

async function _bumpJobCounters(jobId, succeededDelta, failedDelta, skippedDelta = 0) {
  await pool.query(
    `UPDATE login_mail_jobs
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
       FROM login_mail_job_items
      WHERE job_id = $1 AND status = 'pending'
      ORDER BY id ASC`,
    [jobId]
  );
  return rows;
}

async function _markRemainingSkipped(jobId, reason) {
  const { rowCount } = await pool.query(
    `UPDATE login_mail_job_items
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

/**
 * Load decrypted IMAP credentials for a credential row.
 */
async function _loadCredentials(credentialId) {
  const { rows } = await pool.query(
    `SELECT id, email, imap_host, imap_port, imap_user,
            imap_pass_encrypted, use_tls
       FROM login_mail_credentials WHERE id = $1`,
    [credentialId]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    email: row.email,
    imap_host: row.imap_host,
    imap_port: row.imap_port,
    imap_user: row.imap_user,
    imap_pass: decrypt(row.imap_pass_encrypted),
    use_tls: row.use_tls,
  };
}

// -----------------------------------------------------------------------
// Per-session processing
// -----------------------------------------------------------------------

async function _runItem(jobId, item, email, imapCreds) {
  const itemId = item.id;
  const sessionId = item.session_id;

  await pool.query(
    `UPDATE login_mail_job_items
        SET status = 'running',
            started_at = NOW(),
            attempts = attempts + 1
      WHERE id = $1`,
    [itemId]
  );

  try {
    // Step 1: Send verification code via Telegram
    logger.info(
      `loginMailWorker: session ${sessionId} — sending verification code to ${email}`
    );
    const beforeSend = new Date();
    await loginMailService.sendLoginEmailCode(sessionId, email);

    // Small delay to allow the email to arrive.
    await _sleep(3000);

    // Step 2: Auto-read OTP from inbox
    logger.info(
      `loginMailWorker: session ${sessionId} — polling inbox for OTP`
    );
    const otpResult = await emailReaderService.waitForTelegramOTP(imapCreds, {
      sinceDate: beforeSend,
      timeoutMs: OTP_TIMEOUT_MS,
      pollIntervalMs: 4000,
      onCancel: async () => _isCancelRequested(jobId),
    });

    if (!otpResult || !otpResult.code) {
      throw Object.assign(
        new Error('Timed out waiting for verification email. The email may not have arrived.'),
        { code: 'OTP_TIMEOUT' }
      );
    }

    // Step 3: Verify the code
    logger.info(
      `loginMailWorker: session ${sessionId} — verifying OTP code ${otpResult.code}`
    );
    await loginMailService.verifyLoginEmailCode(sessionId, otpResult.code);

    // Success
    await pool.query(
      `UPDATE login_mail_job_items
          SET status = 'succeeded',
              finished_at = NOW()
        WHERE id = $1`,
      [itemId]
    );
    await _bumpJobCounters(jobId, 1, 0, 0);

    logger.info(
      `loginMailWorker: session ${sessionId} — login email set successfully`
    );
  } catch (err) {
    const code = (err && (err.errorMessage || err.code)) || 'ERROR';
    const message = (err && err.message) || String(err);
    logger.warn(
      `loginMailWorker: session ${sessionId} failed: ${code} — ${message}`
    );
    await pool.query(
      `UPDATE login_mail_job_items
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

// -----------------------------------------------------------------------
// Job processing loop
// -----------------------------------------------------------------------

async function _processJob(job) {
  const jobId = job.id;
  const email = job.email;
  const credentialId = job.credential_id;

  logger.info(
    `loginMailWorker: starting job ${jobId} (user=${job.user_id}, ` +
    `email=${email}, sessions=${job.total_sessions})`
  );

  // Load IMAP credentials.
  const imapCreds = await _loadCredentials(credentialId);
  if (!imapCreds) {
    await _markRemainingSkipped(jobId, 'IMAP credentials not found');
    await _markJobFinalized(jobId, 'failed', 'IMAP credentials deleted or missing');
    return;
  }

  // Quick IMAP connectivity check before burning through sessions.
  const testResult = await emailReaderService.testConnection(imapCreds);
  if (!testResult.ok) {
    await _markRemainingSkipped(jobId, `IMAP connection failed: ${testResult.error}`);
    await _markJobFinalized(
      jobId,
      'failed',
      `IMAP connection failed: ${testResult.error}`
    );
    return;
  }

  try {
    while (true) {
      if (await _isCancelRequested(jobId)) {
        await _markRemainingSkipped(jobId, 'job cancelled by user');
        await _markJobFinalized(jobId, 'cancelled');
        return;
      }

      const items = await _getPendingItems(jobId);
      if (items.length === 0) break;

      // Process one at a time for login-mail because each session needs
      // to send → wait for OTP → verify sequentially, and we don't want
      // multiple OTP emails arriving at once (they'd be ambiguous).
      const batch = items.slice(0, CONCURRENCY);
      for (const item of batch) {
        if (await _isCancelRequested(jobId)) {
          await _markRemainingSkipped(jobId, 'job cancelled by user');
          await _markJobFinalized(jobId, 'cancelled');
          return;
        }
        await _runItem(jobId, item, email, imapCreds);

        // Cooldown between sessions to avoid rate limits.
        if (items.length > 1) {
          await _sleep(_jitter(BATCH_COOLDOWN_MIN_MS, BATCH_COOLDOWN_MAX_MS));
        }
      }
    }

    // Determine final status.
    const { rows } = await pool.query(
      `SELECT total_sessions, succeeded_count, failed_count, skipped_count
         FROM login_mail_jobs WHERE id = $1`,
      [jobId]
    );
    const r = rows[0] || {};
    const finalStatus =
      r.failed_count > 0 && r.succeeded_count === 0
        ? 'failed'
        : 'completed';
    await _markJobFinalized(jobId, finalStatus);
    logger.info(
      `loginMailWorker: finished job ${jobId} as ${finalStatus} ` +
      `(${r.succeeded_count}/${r.total_sessions} ok, ${r.failed_count} failed, ${r.skipped_count} skipped)`
    );
  } catch (err) {
    logger.error(
      `loginMailWorker: job ${jobId} crashed`,
      { error: err && err.message }
    );
    await _markRemainingSkipped(jobId, 'worker crashed');
    await _markJobFinalized(jobId, 'failed', err && err.message);
  }
}

// -----------------------------------------------------------------------
// Scheduler
// -----------------------------------------------------------------------

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
    logger.error('loginMailWorker tick error', { error: err && err.message });
  } finally {
    running = false;
  }
}

async function _recoverOrphanedRows() {
  const { rowCount: jobsRecovered } = await pool.query(
    `UPDATE login_mail_jobs SET status = 'pending', started_at = NULL
      WHERE status = 'running'`
  );
  const { rowCount: itemsRecovered } = await pool.query(
    `UPDATE login_mail_job_items SET status = 'pending', started_at = NULL
      WHERE status = 'running'`
  );
  if (jobsRecovered || itemsRecovered) {
    logger.info(
      `loginMailWorker: recovered ${jobsRecovered} stalled jobs and ` +
      `${itemsRecovered} stalled items from previous run`
    );
  }
}

function startLoginMailJobWorker() {
  if (timer) return;
  timer = setInterval(() => {
    _tick().catch(() => {});
  }, TICK_INTERVAL_MS);
  setTimeout(() => {
    _recoverOrphanedRows()
      .then(() => _tick())
      .catch((err) =>
        logger.error('loginMailWorker boot recovery failed', {
          error: err && err.message,
        })
      );
  }, 2000);
  logger.info(
    `loginMailWorker started (tick=${TICK_INTERVAL_MS}ms, concurrency=${CONCURRENCY})`
  );
}

function stopLoginMailJobWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startLoginMailJobWorker,
  stopLoginMailJobWorker,
  _tick,
};
