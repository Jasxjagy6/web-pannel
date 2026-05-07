/**
 * telegramClientJobs — in-memory tracker for "Delete chats" jobs kicked
 * off from the Telegram → Login page.
 *
 * The Login page bulk-action used to be synchronous: the user clicked
 * "Confirm", the modal blocked, and the request stayed in flight until
 * every dialog of every selected session was wiped. With 100+ sessions
 * that was both slow and fragile (a refresh / nav cancelled the call).
 *
 * Now the controller creates a job here, returns the job id immediately,
 * and runs the actual work in the background. The History tab on the
 * Login page polls / subscribes for live updates and renders progress.
 *
 * State is kept in memory only — restarting the backend wipes the job
 * list. We cap retention at the latest N jobs *per user* so a long-lived
 * panel doesn't accumulate unbounded state.
 *
 * Live updates are emitted on the per-user room
 *   `tg-client:u<userId>:jobs`
 * with event name `tg-client:clearJobUpdate`. The frontend listens with
 * `useTelegramJobsSocket` and renders the most recent job snapshot.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

const PER_USER_LIMIT = 200;
const PER_SESSION_RESULT_LIMIT = 1000;

/** @type {Map<string, Job>} */
const _jobsById = new Map();
/** @type {Map<string, string[]>} userId -> jobIds (newest first) */
const _jobsByUser = new Map();

function _newJobId() {
  return `cc_${crypto.randomBytes(10).toString('hex')}`;
}

function userJobsRoom(userId) {
  return `tg-client:u${userId}:jobs`;
}

function _emit(job) {
  const io = global.io;
  if (!io || !job?.userId) return;
  try {
    io.to(userJobsRoom(job.userId)).emit('tg-client:clearJobUpdate', publicJob(job));
  } catch (err) {
    logger.debug(`tg-client clearJobUpdate emit failed: ${err.message}`);
  }
}

/**
 * Strip private fields and trim large arrays before sending the job
 * over the wire. Keeps the API stable so the frontend can rely on the
 * shape regardless of how we store it internally.
 */
function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    revoke: job.revoke,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    totals: { ...job.totals },
    sessions: job.sessions.map((s) => ({
      sessionId: s.sessionId,
      displayName: s.displayName,
      phone: s.phone,
      status: s.status,
      total: s.total,
      done: s.done,
      succeeded: s.succeeded,
      failed: s.failed,
      cleared: s.cleared,
      left: s.left,
      deleted: s.deleted,
      currentTitle: s.currentTitle,
      error: s.error,
      code: s.code,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      // Trimmed peer-by-peer log; unbounded retention would balloon
      // memory when 50 sessions × 1000 dialogs are processed.
      results: s.results.slice(0, PER_SESSION_RESULT_LIMIT),
    })),
  };
}

/**
 * Create a new job. `sessions` is the list of selected session
 * descriptors (id + display info) so the History tab can render an
 * informative card before any backend work runs.
 *
 * Returns the job snapshot immediately and emits the "queued" state on
 * the per-user room.
 *
 * @param {object} args
 * @param {string|number} args.userId
 * @param {boolean} args.revoke
 * @param {Array<{ sessionId:string|number, displayName?:string, phone?:string }>} args.sessions
 */
function createJob({ userId, revoke, sessions }) {
  const id = _newJobId();
  const job = {
    id,
    userId: String(userId),
    revoke: !!revoke,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    sessions: (sessions || []).map((s) => ({
      sessionId: String(s.sessionId),
      displayName: s.displayName || null,
      phone: s.phone || null,
      status: 'queued',
      total: 0,
      done: 0,
      succeeded: 0,
      failed: 0,
      cleared: 0,
      left: 0,
      deleted: 0,
      currentTitle: null,
      error: null,
      code: null,
      results: [],
      startedAt: null,
      finishedAt: null,
    })),
    totals: _emptyTotals((sessions || []).length),
  };

  _jobsById.set(id, job);
  const key = String(userId);
  let list = _jobsByUser.get(key);
  if (!list) {
    list = [];
    _jobsByUser.set(key, list);
  }
  list.unshift(id);
  while (list.length > PER_USER_LIMIT) {
    const old = list.pop();
    if (old) _jobsById.delete(old);
  }

  _emit(job);
  return job;
}

function _emptyTotals(totalSessions) {
  return {
    totalSessions,
    completedSessions: 0,
    totalDialogs: 0,
    done: 0,
    succeeded: 0,
    failed: 0,
    cleared: 0,
    left: 0,
    deleted: 0,
  };
}

function _recomputeTotals(job) {
  const totals = _emptyTotals(job.sessions.length);
  for (const s of job.sessions) {
    totals.totalDialogs += s.total || 0;
    totals.done += s.done || 0;
    totals.succeeded += s.succeeded || 0;
    totals.failed += s.failed || 0;
    totals.cleared += s.cleared || 0;
    totals.left += s.left || 0;
    totals.deleted += s.deleted || 0;
    if (s.status === 'done' || s.status === 'failed' || s.status === 'partial') {
      totals.completedSessions += 1;
    }
  }
  job.totals = totals;

  if (totals.completedSessions === totals.totalSessions && totals.totalSessions > 0) {
    if (job.sessions.every((s) => s.status === 'done')) job.status = 'done';
    else if (job.sessions.every((s) => s.status === 'failed')) job.status = 'failed';
    else job.status = 'partial';
    if (!job.finishedAt) job.finishedAt = Date.now();
  } else if (totals.completedSessions > 0 || job.sessions.some((s) => s.status === 'running')) {
    job.status = 'running';
    if (!job.startedAt) job.startedAt = Date.now();
  }
}

function getJobForUser(jobId, userId) {
  const job = _jobsById.get(jobId);
  if (!job) return null;
  if (String(job.userId) !== String(userId)) return null;
  return job;
}

function listJobsForUser(userId, { limit = 50 } = {}) {
  const list = _jobsByUser.get(String(userId)) || [];
  const out = [];
  for (const id of list) {
    const job = _jobsById.get(id);
    if (!job) continue;
    out.push(job);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Apply a partial update to a session's progress entry and recompute
 * the job-level totals + status. Always emits the latest snapshot on
 * the per-user room.
 *
 * Numeric fields named `_inc` are added to the existing value; named
 * fields are replaced.
 */
function patchJobSession(jobId, sessionId, patch) {
  const job = _jobsById.get(jobId);
  if (!job) return null;
  const s = job.sessions.find((x) => x.sessionId === String(sessionId));
  if (!s) return null;

  for (const [k, v] of Object.entries(patch || {})) {
    if (k.endsWith('_inc') && typeof v === 'number') {
      const base = k.slice(0, -4);
      s[base] = (s[base] || 0) + v;
    } else {
      s[k] = v;
    }
  }
  _recomputeTotals(job);
  _emit(job);
  return job;
}

function appendSessionResult(jobId, sessionId, result) {
  const job = _jobsById.get(jobId);
  if (!job) return null;
  const s = job.sessions.find((x) => x.sessionId === String(sessionId));
  if (!s) return null;
  // Cap the in-memory results array; the History tab only ever
  // renders the first PER_SESSION_RESULT_LIMIT entries anyway.
  if (s.results.length < PER_SESSION_RESULT_LIMIT) s.results.push(result);
  return job;
}

/**
 * Mark the job as finished, regardless of per-session state. Used as a
 * safety hatch when the controller's background worker raises before
 * the per-session updates can run (e.g. a coding bug in the service).
 */
function failJob(jobId, errorMessage) {
  const job = _jobsById.get(jobId);
  if (!job) return null;
  for (const s of job.sessions) {
    if (s.status === 'queued' || s.status === 'running') {
      s.status = 'failed';
      s.error = s.error || errorMessage || 'Job aborted';
      s.finishedAt = Date.now();
    }
  }
  _recomputeTotals(job);
  job.status = 'failed';
  job.finishedAt = Date.now();
  _emit(job);
  return job;
}

module.exports = {
  createJob,
  getJobForUser,
  listJobsForUser,
  patchJobSession,
  appendSessionResult,
  failJob,
  publicJob,
  userJobsRoom,
};
