/**
 * Session Bulk-Login Job Service.
 *
 * Operator workflow:
 *   1. Select N Telegram sessions in the Sessions UI.
 *   2. Click "Login All". The frontend opens a modal mirroring the
 *      clone-export job UX (per-row status pills + progress bar)
 *      and POSTs `/api/sessions/bulk-login/start` with the
 *      `sessionIds` array.
 *   3. We schedule a background runner that calls the existing
 *      `sessionService.loginSession` once per row, sequentially,
 *      with a small inter-row delay so we don't hammer Telegram /
 *      the panel's egress IP.
 *   4. The modal polls `/:jobId/status` and shows progress.
 *
 * Why a dedicated job runner instead of N independent HTTP calls:
 *   - The legacy `handleBulkLogin` in the frontend looped over the
 *     ids with `await loginSession(id)` and only displayed a single
 *     toast at the end. The operator had no visibility into which
 *     session was being attempted or where in the queue the panel
 *     was. The clone-export modal proved this UX works and the
 *     operator explicitly asked for the same shape here ("It should
 *     show the same menu and ui as it shows while during the job
 *     running of the export session feature").
 *   - Centralising progress on the server lets multiple tabs poll
 *     the same job without re-issuing logins (each row only
 *     attempts once, even if the operator reopens the modal).
 *   - The runner uses the same `sessionService.loginSession`
 *     code path the per-row Login button uses, so behavior is
 *     identical — no second copy of the auth flow to maintain.
 */

'use strict';

const crypto = require('crypto');

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const sessionService = require('./sessionService');

// In-memory job registry — one panel process is sufficient for the
// interactive bulk-login workflow. Matches the pattern used by
// sessionDuplicationService.js so the two job UIs feel identical to
// the operator.
const jobs = new Map();

const DEFAULT_INTER_ROW_DELAY_MS = 600;
const JOB_TTL_MS = 30 * 60 * 1000; // 30 min after completion
const MAX_SESSIONS_PER_JOB = 500;

function newJobId() {
  return `bulk-login-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Public view of a job — strips internal resolvers / clients.
 *
 * @param {object} job
 */
function publicJobView(job) {
  return {
    jobId: job.id,
    userId: job.userId,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error || null,
    summary: {
      total: job.sessions.length,
      succeeded: job.sessions.filter((s) => s.status === 'logged_in').length,
      alreadyLoggedIn: job.sessions.filter((s) => s.status === 'already_logged_in').length,
      failed: job.sessions.filter((s) => s.status === 'failed').length,
      pending: job.sessions.filter((s) => s.status === 'queued' || s.status === 'logging_in').length,
    },
    sessions: job.sessions.map((s) => ({
      sessionId: s.sessionId,
      phone: s.phone,
      status: s.status,
      progress: s.progress,
      error: s.error || null,
      accountInfo: s.accountInfo || null,
    })),
  };
}

/**
 * Schedule a job for deletion JOB_TTL_MS after completion.
 *
 * @param {string} jobId
 */
function scheduleCleanup(jobId) {
  setTimeout(() => {
    jobs.delete(jobId);
  }, JOB_TTL_MS).unref?.();
}

/**
 * Run a single login attempt against one session.
 *
 * We call the existing `sessionService.loginSession` so this job
 * uses the exact same code path as the per-row Login button. Errors
 * are recorded on the per-row state and the job continues with the
 * next row.
 *
 * @param {object} job
 * @param {object} sessionState
 */
async function loginOne(job, sessionState) {
  sessionState.status = 'logging_in';
  sessionState.progress = 25;
  try {
    const result = await sessionService.loginSession(sessionState.sessionId, job.userId);
    sessionState.progress = 100;
    sessionState.status = 'logged_in';
    sessionState.accountInfo = result && result.accountInfo ? result.accountInfo : null;
    if (result && result.accountInfo && result.accountInfo.phone) {
      sessionState.phone = result.accountInfo.phone;
    }
  } catch (err) {
    // Telegram's "already logged in" path comes back as a 409
    // AppError from sessionService. The operator's expectation is
    // that an already-logged-in row should not appear as a failure
    // in the bulk-login panel — surface it as its own state.
    const code = err && (err.errorCode || err.code);
    const status = err && err.statusCode;
    const msg = err && err.message ? err.message : String(err);
    if (code === 'SESSION_ALREADY_LOGGED_IN' || status === 409) {
      sessionState.status = 'already_logged_in';
      sessionState.progress = 100;
      sessionState.error = null;
      return;
    }
    sessionState.status = 'failed';
    sessionState.progress = 100;
    sessionState.error = msg;
    logger.warn(
      `sessionBulkLogin: login failed for session ${sessionState.sessionId}: ${msg}`,
      { jobId: job.id }
    );
  }
}

/**
 * Background runner. Iterates sessions sequentially with a small
 * inter-row delay so we don't hit Telegram's per-IP rate limits.
 *
 * @param {object} job
 */
async function runJob(job) {
  try {
    for (const sessionState of job.sessions) {
      if (job.status === 'cancelled') {
        if (sessionState.status === 'queued') {
          sessionState.status = 'cancelled';
        }
        continue;
      }
      try {
        // Refresh the row's phone for nicer UI labels and short-
        // circuit early if the operator deleted the session.
        const r = await pool.query(
          `SELECT id, phone FROM sessions WHERE id = $1 AND user_id = $2 AND platform = 'telegram'`,
          [sessionState.sessionId, job.userId]
        );
        const row = r.rows[0];
        if (!row) {
          sessionState.status = 'failed';
          sessionState.progress = 100;
          sessionState.error = 'Session not found (deleted or wrong user)';
          continue;
        }
        sessionState.phone = row.phone || sessionState.phone || null;
      } catch (_) {
        // Best-effort phone refresh — not fatal.
      }

      await loginOne(job, sessionState);
      if (job.status === 'cancelled') continue;
      await new Promise((res) => setTimeout(res, job.interRowDelayMs));
    }

    if (job.status !== 'cancelled') {
      job.status = 'completed';
    }
  } catch (err) {
    job.status = 'failed';
    job.error = err && err.message ? err.message : String(err);
    logger.error(`sessionBulkLogin: job ${job.id} crashed: ${job.error}`);
  } finally {
    job.finishedAt = new Date().toISOString();
    scheduleCleanup(job.id);
  }
}

/**
 * Kick off a new bulk-login job. Returns the job id immediately;
 * the heavy work happens in the background.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {Array<number|string>} params.sessionIds
 * @param {number} [params.interRowDelayMs]
 */
async function startBulkLoginJob(params) {
  const { userId, sessionIds, interRowDelayMs } = params || {};
  if (!userId) throw new Error('userId required');
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new Error('sessionIds required (non-empty array)');
  }
  if (sessionIds.length > MAX_SESSIONS_PER_JOB) {
    throw new Error(`At most ${MAX_SESSIONS_PER_JOB} sessions can be logged in per job`);
  }

  // Pull the rows up-front so the modal can show a phone label per
  // row even before we attempt the login.
  const rows = await pool.query(
    `SELECT id, phone
       FROM sessions
      WHERE user_id = $1
        AND platform = 'telegram'
        AND id = ANY($2::int[])`,
    [userId, sessionIds.map((id) => Number(id))]
  );
  const phoneById = new Map();
  for (const r of rows.rows) phoneById.set(Number(r.id), r.phone || null);

  const jobId = newJobId();
  const job = {
    id: jobId,
    userId,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    interRowDelayMs:
      Number.isFinite(interRowDelayMs) && interRowDelayMs >= 0
        ? Number(interRowDelayMs)
        : DEFAULT_INTER_ROW_DELAY_MS,
    sessions: sessionIds.map((sid) => ({
      sessionId: Number(sid),
      phone: phoneById.get(Number(sid)) || null,
      status: 'queued',
      progress: 0,
      error: null,
      accountInfo: null,
    })),
  };
  jobs.set(jobId, job);

  // Fire-and-forget runner. We never await it — the controller
  // returns 202 immediately so the frontend can start polling.
  setImmediate(() => {
    runJob(job).catch((err) => {
      logger.error(`sessionBulkLogin: unhandled runner error: ${err && err.message}`);
    });
  });

  return { jobId };
}

/**
 * Public job lookup with ownership check.
 *
 * @param {string} jobId
 * @param {number} userId
 */
function getJobStatus(jobId, userId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.userId !== userId) return null;
  return publicJobView(job);
}

/**
 * Operator-initiated cancel. Rows that are already attempting will
 * still complete (we don't interrupt mid-RPC), but anything queued
 * is marked cancelled and the runner exits.
 *
 * @param {string} jobId
 * @param {number} userId
 */
function cancelJob(jobId, userId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.userId !== userId) return false;
  if (job.status === 'completed' || job.status === 'failed') {
    return true;
  }
  job.status = 'cancelled';
  return true;
}

module.exports = {
  startBulkLoginJob,
  getJobStatus,
  cancelJob,
  // Exposed for tests.
  _jobs: jobs,
};
