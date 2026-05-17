/**
 * Session Bulk Auth-Purge Job Service.
 *
 * Operator workflow:
 *   1. Select N Telegram sessions in the Sessions UI.
 *   2. Click "Terminate Other Sessions". The frontend opens a modal
 *      mirroring the bulk-login / clone-export job UX (per-row status
 *      pills with a nested per-device list) and POSTs
 *      `/api/sessions/bulk-auth-purge/start` with the `sessionIds`.
 *   3. For each selected panel session, we:
 *        a) call `telegramClientService.listAuthorizations` to fetch
 *           every device that is signed in to that Telegram account,
 *        b) for each authorization with `isCurrent === false`, call
 *           `telegramClientService.resetAuthorization(hash)` so the
 *           panel's own login is the only one left standing.
 *      Sub-row status is tracked per (panelSessionId, hash) so the
 *      modal can show which device was killed and which (if any)
 *      Telegram refused (e.g. FRESH_RESET_FORBIDDEN for < 24h-old
 *      authorizations).
 *   4. The modal polls `/:jobId/status` and shows progress.
 *
 * Why a dedicated job runner instead of N independent HTTP calls:
 *   - The operator wants visible per-device progress, not a single
 *     "done" toast. Terminating an account-level session takes 1-2
 *     RPCs per device and a panel session can have 5-15 devices.
 *   - Centralising progress on the server lets multiple tabs poll
 *     the same job. Reopening the modal after closing it shows the
 *     real state instead of restarting the purge.
 *   - We re-use the existing `telegramClientService.listAuthorizations`
 *     + `.resetAuthorization` code paths the per-row Settings drawer
 *     uses, so behaviour is identical — no second copy of the RPC
 *     plumbing to maintain.
 *
 * Mirrors the shape of sessionBulkLoginService so the frontend can
 * reuse the same polling pattern.
 */

'use strict';

const crypto = require('crypto');

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const telegramClientService = require('./telegramClientService');

// In-memory job registry — one panel process is sufficient for the
// interactive purge workflow. Same trade-off as bulk-login.
const jobs = new Map();

const DEFAULT_INTER_SESSION_DELAY_MS = 600;
const DEFAULT_INTER_DEVICE_DELAY_MS = 300;
const JOB_TTL_MS = 30 * 60 * 1000; // 30 min after completion
const MAX_SESSIONS_PER_JOB = 500;

// Telegram historically uses hash="0" to mean "the current session".
// Even if the schema's `current` flag is missing, we refuse to ever
// call account.ResetAuthorization(hash=0) as belt-and-suspenders.
const RESERVED_CURRENT_HASH = '0';

function newJobId() {
  return `bulk-auth-purge-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Human-friendly label for a Telegram authorization row, used in the
 * modal next to the status pill. Keep this terse so the row fits.
 */
function authLabel(a) {
  if (!a) return 'device';
  const bits = [];
  if (a.deviceModel) bits.push(a.deviceModel);
  if (a.appName) bits.push(a.appName);
  if (a.country) bits.push(a.country);
  if (a.ip) bits.push(a.ip);
  return bits.length ? bits.join(' · ') : `device ${a.hash}`;
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
      completed: job.sessions.filter((s) => s.status === 'completed').length,
      partial: job.sessions.filter((s) => s.status === 'partial').length,
      noOthers: job.sessions.filter((s) => s.status === 'no_others').length,
      failed: job.sessions.filter((s) => s.status === 'failed').length,
      aborted: job.sessions.filter((s) => s.status === 'aborted_unsafe').length,
      pending: job.sessions.filter(
        (s) => s.status === 'queued' || s.status === 'listing' || s.status === 'purging'
      ).length,
      cancelled: job.sessions.filter((s) => s.status === 'cancelled').length,
      devicesTerminated: job.sessions.reduce(
        (n, s) => n + s.devices.filter((d) => d.status === 'terminated').length,
        0
      ),
      devicesFailed: job.sessions.reduce(
        (n, s) => n + s.devices.filter((d) => d.status === 'failed').length,
        0
      ),
      devicesSkipped: job.sessions.reduce(
        (n, s) => n + s.devices.filter((d) => d.status === 'skipped').length,
        0
      ),
    },
    sessions: job.sessions.map((s) => ({
      sessionId: s.sessionId,
      phone: s.phone,
      status: s.status,
      progress: s.progress,
      error: s.error || null,
      panelHash: s.panelHash || null,
      panelHashStored: s.panelHashStored || null,
      devices: s.devices.map((d) => ({
        hash: d.hash,
        label: d.label,
        isCurrent: d.isCurrent,
        status: d.status,
        error: d.error || null,
      })),
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
 * Read the persisted panel auth hash for a session (if any).
 * Best-effort: returns null on DB error rather than aborting the job.
 */
async function loadStoredPanelHash(userId, sessionId) {
  try {
    const r = await pool.query(
      `SELECT tg_panel_auth_hash
         FROM sessions
        WHERE id = $1 AND user_id = $2 AND platform = 'telegram'`,
      [sessionId, userId]
    );
    const row = r.rows[0];
    return row && row.tg_panel_auth_hash ? String(row.tg_panel_auth_hash) : null;
  } catch (e) {
    logger.warn(
      `sessionBulkAuthPurge: loadStoredPanelHash failed for session ${sessionId}: ${e && e.message}`
    );
    return null;
  }
}

/**
 * Persist the panel's own auth hash for future cross-checks. Called
 * after a successful safety-check identifies exactly one row with
 * current=true. Idempotent.
 */
async function persistPanelHash(userId, sessionId, hash) {
  if (!hash) return;
  try {
    await pool.query(
      `UPDATE sessions
          SET tg_panel_auth_hash = $1,
              tg_panel_auth_hash_observed_at = NOW()
        WHERE id = $2 AND user_id = $3 AND platform = 'telegram'`,
      [String(hash), sessionId, userId]
    );
  } catch (e) {
    logger.warn(
      `sessionBulkAuthPurge: persistPanelHash failed for session ${sessionId}: ${e && e.message}`
    );
  }
}

/**
 * Purge every other authorization for a single panel session.
 *
 * Step 1: listAuthorizations.
 * Step 2: SAFETY GATE — abort if we cannot unambiguously identify the
 *         panel's own row. Specifically: exactly one row must have
 *         current=true, and (if a hash was previously persisted for
 *         this session) it must match the live current row's hash.
 * Step 3: for each row where (hash !== panelHash) AND (current=false)
 *         AND (hash !== "0"), call resetAuthorization(hash).
 *
 * Per-device errors are recorded inline; the session row's final
 * status reflects whether ALL succeeded / NONE / SOME / aborted-unsafe.
 *
 * @param {object} job
 * @param {object} sessionState
 */
async function purgeOne(job, sessionState) {
  // Step 1: list authorizations.
  sessionState.status = 'listing';
  sessionState.progress = 10;
  let authList;
  try {
    const res = await telegramClientService.listAuthorizations(
      sessionState.sessionId,
      job.userId
    );
    authList = res && Array.isArray(res.authorizations) ? res.authorizations : [];
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    sessionState.status = 'failed';
    sessionState.progress = 100;
    sessionState.error = `listAuthorizations: ${msg}`;
    logger.warn(
      `sessionBulkAuthPurge: list failed for session ${sessionState.sessionId}: ${msg}`,
      { jobId: job.id }
    );
    return;
  }

  // Build the per-device sub-rows. The "current" row is the panel's
  // own login — we surface it in the UI as "Kept (this panel)" so the
  // operator can see we didn't touch it.
  sessionState.devices = authList.map((a) => ({
    hash: String(a.hash),
    label: authLabel(a),
    isCurrent: !!a.isCurrent,
    status: a.isCurrent ? 'kept' : 'queued',
    error: null,
  }));

  // ── SAFETY GATE ────────────────────────────────────────────────
  // The original (merged) implementation trusted the schema-optional
  // `current` boolean alone. When Telegram omitted that flag on the
  // panel's row (DC migrate / freshly bound key / transient flap)
  // every row was treated as "other" and the panel terminated its
  // OWN session. Refuse to proceed in any ambiguous state.
  const currentRows = sessionState.devices.filter((d) => d.isCurrent);
  const storedPanelHash = await loadStoredPanelHash(job.userId, sessionState.sessionId);
  sessionState.panelHashStored = storedPanelHash || null;

  if (currentRows.length !== 1) {
    sessionState.status = 'aborted_unsafe';
    sessionState.progress = 100;
    sessionState.error =
      currentRows.length === 0
        ? 'Refused to purge: Telegram did not mark any row as the panel\'s current session. Re-try later or re-list manually.'
        : `Refused to purge: ${currentRows.length} rows are marked current — ambiguous.`;
    logger.warn(
      `sessionBulkAuthPurge: ABORT session ${sessionState.sessionId} — currentRows=${currentRows.length}`,
      { jobId: job.id }
    );
    return;
  }

  const panelHash = currentRows[0].hash;
  sessionState.panelHash = panelHash;

  if (storedPanelHash && storedPanelHash !== panelHash) {
    sessionState.status = 'aborted_unsafe';
    sessionState.progress = 100;
    sessionState.error = `Refused to purge: live current-row hash ${panelHash} does not match previously observed panel hash ${storedPanelHash}. The panel auth_key may have been rotated externally.`;
    logger.warn(
      `sessionBulkAuthPurge: ABORT session ${sessionState.sessionId} — stored panel hash ${storedPanelHash} ≠ live ${panelHash}`,
      { jobId: job.id }
    );
    return;
  }

  // Safe to proceed. Persist the observed hash (first observation OR
  // confirmation) so subsequent purges have an even stronger guard.
  await persistPanelHash(job.userId, sessionState.sessionId, panelHash);

  // Defense in depth: explicitly flag any non-current row whose hash
  // matches the reserved current value (hash="0") as skipped —
  // surfaces in the UI as a non-failure non-kill so the operator can
  // see we deliberately did not touch it.
  for (const d of sessionState.devices) {
    if (!d.isCurrent && d.hash === RESERVED_CURRENT_HASH) {
      d.status = 'skipped';
      d.error = 'Skipped: hash=0 is Telegram\'s reserved current-session value.';
    }
  }

  // Build the kill list from the explicit hash (NOT from the
  // current flag). Defense in depth: never kill panelHash or hash=0
  // even if their `current` flag happens to be false.
  const targets = sessionState.devices.filter(
    (d) => d.hash !== panelHash && d.hash !== RESERVED_CURRENT_HASH && !d.isCurrent
  );
  if (targets.length === 0) {
    sessionState.status = 'no_others';
    sessionState.progress = 100;
    return;
  }

  // Step 2: terminate each non-current authorization, one at a time.
  // We loop instead of calling auth.ResetAuthorizations() (which kills
  // every other in one RPC) for two reasons:
  //   - Per-device visibility in the UI.
  //   - auth.ResetAuthorizations carries a 7-day-since-registration
  //     restriction that account.ResetAuthorization(hash) does not.
  sessionState.status = 'purging';
  let killed = 0;
  let failed = 0;
  let i = 0;
  for (const d of targets) {
    if (job.status === 'cancelled') {
      d.status = 'cancelled';
      continue;
    }
    // Belt-and-suspenders: re-assert the invariant immediately before
    // every kill. If anything mutated the device list (panel reload,
    // concurrent listAuthorizations from another tab, etc), abort
    // this specific row rather than risk the wrong hash.
    if (d.hash === panelHash || d.hash === RESERVED_CURRENT_HASH || d.isCurrent) {
      d.status = 'skipped';
      d.error = 'Refused: matches panel\'s own authorization.';
      i += 1;
      sessionState.progress = 10 + Math.floor((i / targets.length) * 85);
      continue;
    }
    d.status = 'terminating';
    try {
      await telegramClientService.resetAuthorization(
        sessionState.sessionId,
        job.userId,
        d.hash
      );
      d.status = 'terminated';
      killed += 1;
    } catch (err) {
      const code = err && (err.errorCode || err.code);
      const msg = err && err.message ? err.message : String(err);
      // Telegram refuses to reset an authorization < 24h old, but
      // that is the user's own freshly-added device, not a failure
      // condition for the purge — surface it as 'skipped' so the
      // operator sees it didn't disappear.
      if (code === 'FRESH_RESET_FORBIDDEN' || /FRESH_RESET_AUTHORISATION_FORBIDDEN/i.test(msg)) {
        d.status = 'skipped';
        d.error = 'Authorization is < 24h old — Telegram refuses to reset it.';
      } else {
        d.status = 'failed';
        d.error = msg;
        failed += 1;
        logger.warn(
          `sessionBulkAuthPurge: resetAuthorization failed for session ${sessionState.sessionId} hash ${d.hash}: ${msg}`,
          { jobId: job.id }
        );
      }
    }
    i += 1;
    sessionState.progress = 10 + Math.floor((i / targets.length) * 85);
    if (i < targets.length && job.status !== 'cancelled') {
      await new Promise((res) => setTimeout(res, job.interDeviceDelayMs));
    }
  }

  sessionState.progress = 100;
  if (job.status === 'cancelled' && sessionState.devices.some((d) => d.status === 'cancelled')) {
    sessionState.status = 'cancelled';
  } else if (failed === 0) {
    sessionState.status = 'completed';
  } else if (killed > 0) {
    sessionState.status = 'partial';
    sessionState.error = `${failed} of ${targets.length} device(s) failed to terminate.`;
  } else {
    sessionState.status = 'failed';
    sessionState.error = `All ${targets.length} device terminations failed.`;
  }
}

/**
 * Background runner. Iterates sessions sequentially with a small
 * inter-row delay so we don't hammer Telegram's per-egress-IP rate
 * limits.
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
          `SELECT id, phone FROM sessions
            WHERE id = $1 AND user_id = $2 AND platform = 'telegram'`,
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

      await purgeOne(job, sessionState);
      if (job.status === 'cancelled') continue;
      await new Promise((res) => setTimeout(res, job.interSessionDelayMs));
    }

    if (job.status !== 'cancelled') {
      job.status = 'completed';
    }
  } catch (err) {
    job.status = 'failed';
    job.error = err && err.message ? err.message : String(err);
    logger.error(`sessionBulkAuthPurge: job ${job.id} crashed: ${job.error}`);
  } finally {
    job.finishedAt = new Date().toISOString();
    scheduleCleanup(job.id);
  }
}

/**
 * Kick off a new bulk auth-purge job. Returns the job id immediately;
 * the heavy work happens in the background.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {Array<number|string>} params.sessionIds
 * @param {number} [params.interSessionDelayMs]
 * @param {number} [params.interDeviceDelayMs]
 */
async function startBulkAuthPurgeJob(params) {
  const {
    userId,
    sessionIds,
    interSessionDelayMs,
    interDeviceDelayMs,
    acknowledged,
  } = params || {};
  if (!userId) throw new Error('userId required');
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new Error('sessionIds required (non-empty array)');
  }
  if (sessionIds.length > MAX_SESSIONS_PER_JOB) {
    throw new Error(`At most ${MAX_SESSIONS_PER_JOB} sessions can be purged per job`);
  }
  // The frontend must send acknowledged=true only after the operator
  // has reviewed the preview and ticked the confirm checkbox. This
  // makes accidental purges (e.g. from a stale tab calling the API
  // directly) much harder.
  if (acknowledged !== true) {
    throw new Error(
      'Refused to start purge: operator confirmation required. The UI must POST acknowledged=true after the device preview is shown.'
    );
  }

  // Pull the rows up-front so the modal can show a phone label per
  // row even before we attempt the first RPC.
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
    interSessionDelayMs:
      Number.isFinite(interSessionDelayMs) && interSessionDelayMs >= 0
        ? Number(interSessionDelayMs)
        : DEFAULT_INTER_SESSION_DELAY_MS,
    interDeviceDelayMs:
      Number.isFinite(interDeviceDelayMs) && interDeviceDelayMs >= 0
        ? Number(interDeviceDelayMs)
        : DEFAULT_INTER_DEVICE_DELAY_MS,
    sessions: sessionIds.map((sid) => ({
      sessionId: Number(sid),
      phone: phoneById.get(Number(sid)) || null,
      status: 'queued',
      progress: 0,
      error: null,
      devices: [],
    })),
  };
  jobs.set(jobId, job);

  // Fire-and-forget runner. The controller returns 202 immediately
  // so the frontend can start polling.
  setImmediate(() => {
    runJob(job).catch((err) => {
      logger.error(`sessionBulkAuthPurge: unhandled runner error: ${err && err.message}`);
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
 * Operator-initiated cancel. Rows that are already attempting an RPC
 * will still complete (we don't interrupt mid-RPC), but anything
 * queued is marked cancelled and the runner exits at the next checkpoint.
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

/**
 * Read-only "what would happen if I purged these now" preview.
 * Runs listAuthorizations against each selected session and returns
 * the device list plus the per-session safety verdict (eligible /
 * abort reason). The frontend uses this to show the operator EXACTLY
 * which devices will be killed and which row will be kept BEFORE
 * they confirm Start. No RPC with side effects is invoked here.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {Array<number|string>} params.sessionIds
 */
async function previewPurge(params) {
  const { userId, sessionIds } = params || {};
  if (!userId) throw new Error('userId required');
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new Error('sessionIds required (non-empty array)');
  }
  if (sessionIds.length > MAX_SESSIONS_PER_JOB) {
    throw new Error(`At most ${MAX_SESSIONS_PER_JOB} sessions per preview`);
  }

  const idList = sessionIds.map((id) => Number(id));
  const rows = await pool.query(
    `SELECT id, phone, tg_panel_auth_hash
       FROM sessions
      WHERE user_id = $1
        AND platform = 'telegram'
        AND id = ANY($2::int[])`,
    [userId, idList]
  );
  const meta = new Map();
  for (const r of rows.rows) {
    meta.set(Number(r.id), {
      phone: r.phone || null,
      storedHash: r.tg_panel_auth_hash ? String(r.tg_panel_auth_hash) : null,
    });
  }

  const out = [];
  for (const sid of idList) {
    const m = meta.get(sid);
    if (!m) {
      out.push({
        sessionId: sid,
        phone: null,
        eligible: false,
        abortReason: 'Session not found (deleted or wrong owner).',
        devices: [],
        panelHash: null,
        panelHashStored: null,
      });
      continue;
    }

    let authList;
    try {
      const res = await telegramClientService.listAuthorizations(sid, userId);
      authList = res && Array.isArray(res.authorizations) ? res.authorizations : [];
    } catch (err) {
      out.push({
        sessionId: sid,
        phone: m.phone,
        eligible: false,
        abortReason: `listAuthorizations: ${err && err.message ? err.message : String(err)}`,
        devices: [],
        panelHash: null,
        panelHashStored: m.storedHash,
      });
      continue;
    }

    const devices = authList.map((a) => ({
      hash: String(a.hash),
      label: authLabel(a),
      isCurrent: !!a.isCurrent,
      // 'kept' for current; 'would_terminate' for everything else.
      // Skip badge added by the frontend when the device is < 24h
      // (we don't know that here without dateCreated; pass it through).
      plannedStatus: a.isCurrent ? 'kept' : 'would_terminate',
      dateCreated: Number(a.dateCreated) || 0,
    }));

    const currents = devices.filter((d) => d.isCurrent);
    let eligible = true;
    let abortReason = null;
    if (currents.length === 0) {
      eligible = false;
      abortReason =
        "Telegram did not flag any row as the panel's current session. " +
        "Refusing to proceed \u2014 try again later or refresh the session.";
    } else if (currents.length > 1) {
      eligible = false;
      abortReason = `${currents.length} rows are flagged current \u2014 ambiguous, refusing to proceed.`;
    } else if (m.storedHash && m.storedHash !== currents[0].hash) {
      eligible = false;
      abortReason =
        `Live current-row hash ${currents[0].hash} does not match previously observed ` +
        `panel hash ${m.storedHash}. The panel auth_key may have been rotated externally.`;
    }

    out.push({
      sessionId: sid,
      phone: m.phone,
      eligible,
      abortReason,
      panelHash: currents.length === 1 ? currents[0].hash : null,
      panelHashStored: m.storedHash,
      devices,
    });
  }

  return { preview: out };
}

module.exports = {
  startBulkAuthPurgeJob,
  previewPurge,
  getJobStatus,
  cancelJob,
  // Exposed for tests.
  _jobs: jobs,
};
