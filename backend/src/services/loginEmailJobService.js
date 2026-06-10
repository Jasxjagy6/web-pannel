/**
 * LoginEmailJobService
 * --------------------------------------------------------------------
 * Bulk job runner for setting login emails on Telegram sessions.
 *
 * Two modes:
 *   1. **Manual** — the frontend orchestrates send-code → user-enters-
 *      code → verify-code one session at a time (same UX pattern as
 *      the old recovery-email flow but hitting the login-email MTProto
 *      endpoints).
 *   2. **Automated** — the user provides IMAP credentials. For each
 *      session the runner:
 *        a. calls loginEmailService.sendCode
 *        b. calls emailReaderService.fetchVerificationCode (IMAP poll)
 *        c. calls loginEmailService.verifyCode with the extracted code
 *        d. updates the DB job row
 *        e. sleeps briefly, then moves to the next session.
 *
 * The automated runner is in-memory (like sessionBulkLoginService and
 * sessionDuplicationService) — a single panel process. The frontend
 * polls GET /:jobId/status for live progress.
 *
 * Public API:
 *   startAutomatedJob(params)      → { jobId }
 *   getJobStatus(jobId, userId)    → public view or null
 *   cancelJob(jobId, userId)       → boolean
 */

'use strict';

const crypto = require('crypto');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const loginEmailService = require('./loginEmailService');
const emailReaderService = require('./emailReaderService');

// In-memory job registry
const jobs = new Map();

const DEFAULT_INTER_SESSION_DELAY_MS = 2000;
const EMAIL_FETCH_TIMEOUT_MS = 90000;      // 90s max wait for OTP email
const EMAIL_FETCH_POLL_INTERVAL_MS = 3000;  // check every 3s
const JOB_TTL_MS = 30 * 60 * 1000;         // keep finished jobs 30 min
const MAX_SESSIONS_PER_JOB = 500;

function newJobId() {
  return `login-email-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Build the public-facing view of a job (no internal state leaked).
 */
function publicJobView(job) {
  return {
    jobId: job.id,
    userId: job.userId,
    status: job.status,
    mode: job.mode,
    email: job.email,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error || null,
    summary: {
      total: job.sessions.length,
      succeeded: job.sessions.filter((s) => s.status === 'done').length,
      failed: job.sessions.filter((s) => s.status === 'failed').length,
      skipped: job.sessions.filter((s) => s.status === 'skipped').length,
      pending: job.sessions.filter(
        (s) => s.status === 'queued' || s.status === 'sending_code' || s.status === 'reading_email' || s.status === 'verifying'
      ).length,
    },
    sessions: job.sessions.map((s) => ({
      sessionId: s.sessionId,
      phone: s.phone,
      username: s.username,
      status: s.status,
      step: s.step || null,
      error: s.error || null,
    })),
  };
}

function scheduleCleanup(jobId) {
  setTimeout(() => { jobs.delete(jobId); }, JOB_TTL_MS).unref?.();
}

/**
 * Process one session in automated mode.
 */
async function processOneAutomated(job, sessionState) {
  const { email, imapConfig } = job;

  // Step 1: Send verification code
  sessionState.status = 'sending_code';
  sessionState.step = 'Sending verification code to email...';
  const sentAfter = new Date(); // track time so we only read emails after this point
  try {
    await loginEmailService.sendCode(sessionState.sessionId, email);
  } catch (err) {
    sessionState.status = 'failed';
    sessionState.error = err.message || String(err);
    sessionState.step = null;
    return;
  }

  // Step 2: Read verification code from email
  sessionState.status = 'reading_email';
  sessionState.step = 'Waiting for OTP email...';
  let code;
  try {
    const result = await emailReaderService.fetchVerificationCode(imapConfig, {
      timeoutMs: EMAIL_FETCH_TIMEOUT_MS,
      pollIntervalMs: EMAIL_FETCH_POLL_INTERVAL_MS,
      sentAfter,
    });
    code = result.code;
    sessionState.step = `Got code from email (${result.from})`;
  } catch (err) {
    sessionState.status = 'failed';
    sessionState.error = `Email read failed: ${err.message || String(err)}`;
    sessionState.step = null;
    return;
  }

  // Step 3: Verify the code
  sessionState.status = 'verifying';
  sessionState.step = 'Verifying code with Telegram...';
  try {
    await loginEmailService.verifyCode(sessionState.sessionId, email, code);
    sessionState.status = 'done';
    sessionState.step = 'Login email set successfully';
  } catch (err) {
    sessionState.status = 'failed';
    sessionState.error = `Verification failed: ${err.message || String(err)}`;
    sessionState.step = null;
  }
}

/**
 * Background runner for the automated job.
 */
async function runAutomatedJob(job) {
  try {
    for (const sessionState of job.sessions) {
      if (job.status === 'cancelled') {
        if (sessionState.status === 'queued') {
          sessionState.status = 'skipped';
          sessionState.error = 'Job cancelled';
        }
        continue;
      }

      // Refresh phone for UI labels
      try {
        const r = await pool.query(
          `SELECT id, phone, account_info FROM sessions
           WHERE id = $1 AND user_id = $2 AND platform = 'telegram'`,
          [sessionState.sessionId, job.userId]
        );
        const row = r.rows[0];
        if (!row) {
          sessionState.status = 'failed';
          sessionState.error = 'Session not found or deleted';
          continue;
        }
        sessionState.phone = row.phone || sessionState.phone;
        if (row.account_info) {
          sessionState.username = row.account_info.username || sessionState.username;
        }
      } catch (_) { /* best-effort */ }

      await processOneAutomated(job, sessionState);

      if (job.status === 'cancelled') continue;

      // Inter-session delay to avoid hammering Telegram + email server
      await new Promise((r) => setTimeout(r, job.interSessionDelayMs));
    }

    if (job.status !== 'cancelled') {
      const failed = job.sessions.filter((s) => s.status === 'failed').length;
      job.status = failed === job.sessions.length ? 'failed' : 'completed';
    }
  } catch (err) {
    job.status = 'failed';
    job.error = err && err.message ? err.message : String(err);
    logger.error(`loginEmailJob: job ${job.id} crashed: ${job.error}`);
  } finally {
    job.finishedAt = new Date().toISOString();
    scheduleCleanup(job.id);
  }
}

/**
 * Start a new automated login-email job.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {string} params.email           - The login email to set on all sessions
 * @param {number[]} params.sessionIds     - Session IDs to process
 * @param {object} params.imapConfig       - { email, password, provider?, host?, port?, secure? }
 * @param {number} [params.interSessionDelayMs]
 * @returns {Promise<{ jobId: string }>}
 */
async function startAutomatedJob(params) {
  const { userId, email, sessionIds, imapConfig, interSessionDelayMs } = params || {};

  if (!userId) throw new Error('userId required');
  if (!email || typeof email !== 'string') throw new Error('email required');
  if (!loginEmailService.validateEmail(email)) throw new Error('Invalid email address');
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new Error('sessionIds required (non-empty array)');
  }
  if (sessionIds.length > MAX_SESSIONS_PER_JOB) {
    throw new Error(`At most ${MAX_SESSIONS_PER_JOB} sessions per job`);
  }
  if (!imapConfig || !imapConfig.email || !imapConfig.password) {
    throw new Error('IMAP credentials (email + password) required for automated mode');
  }

  // Pre-fetch session phones for UI labels
  const rows = await pool.query(
    `SELECT id, phone, account_info FROM sessions
     WHERE user_id = $1 AND platform = 'telegram' AND id = ANY($2::int[])`,
    [userId, sessionIds.map(Number)]
  );
  const infoById = new Map();
  for (const r of rows.rows) {
    infoById.set(Number(r.id), {
      phone: r.phone || null,
      username: r.account_info && r.account_info.username ? r.account_info.username : null,
    });
  }

  const jobId = newJobId();
  const job = {
    id: jobId,
    userId,
    email: email.trim(),
    mode: 'automated',
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    imapConfig,
    interSessionDelayMs:
      Number.isFinite(interSessionDelayMs) && interSessionDelayMs >= 0
        ? Number(interSessionDelayMs)
        : DEFAULT_INTER_SESSION_DELAY_MS,
    sessions: sessionIds.map((sid) => {
      const info = infoById.get(Number(sid)) || {};
      return {
        sessionId: Number(sid),
        phone: info.phone,
        username: info.username,
        status: 'queued',
        step: null,
        error: null,
      };
    }),
  };
  jobs.set(jobId, job);

  // Fire-and-forget — controller returns 202 immediately
  setImmediate(() => {
    runAutomatedJob(job).catch((err) => {
      logger.error(`loginEmailJob: unhandled runner error: ${err && err.message}`);
    });
  });

  return { jobId };
}

/**
 * Get job status (with ownership check).
 */
function getJobStatus(jobId, userId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.userId !== userId) return null;
  return publicJobView(job);
}

/**
 * Cancel a running job.
 */
function cancelJob(jobId, userId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.userId !== userId) return false;
  if (job.status === 'completed' || job.status === 'failed') return true;
  job.status = 'cancelled';
  return true;
}

module.exports = {
  startAutomatedJob,
  getJobStatus,
  cancelJob,
  _jobs: jobs,
};
