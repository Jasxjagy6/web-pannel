/**
 * Session Duplication / QR-Login-Token Export.
 *
 * Operator workflow:
 *   1. Select N active Telegram sessions.
 *   2. Provide a *destination* `api_id` / `api_hash` (the credentials the
 *      recipient — Devin, a tester, another machine — will use to load
 *      the new auth_keys).
 *   3. For each session, the panel spins up a *new* MTProto client with
 *      the destination credentials, calls `auth.ExportLoginToken` from
 *      that new client, hands the token back to the panel's existing
 *      authorized client which calls `auth.AcceptLoginToken`, then
 *      the new client calls `auth.ImportLoginToken` and receives a
 *      brand-new authorization.
 *   4. We save the new client's `StringSession`, write a Telethon-format
 *      `.session` SQLite file and a JSON envelope, zip them, and let the
 *      operator download the bundle.
 *
 * Why this is safe:
 *   - Telegram's `auth.AcceptLoginToken` is the SAME RPC the official
 *     mobile/desktop clients use when you scan a QR code from another
 *     device. It does NOT log the existing device out and does NOT
 *     touch the panel's auth_key. Both authorizations end up listed in
 *     Telegram's "Active sessions" UI as independent devices.
 *   - The new auth_key is generated during the new client's MTProto
 *     key exchange with the destination `api_id` / `api_hash`. When the
 *     recipient loads the file using the same destination
 *     `api_id` / `api_hash`, Telegram accepts it without
 *     `AUTH_KEY_DUPLICATED` because the auth_key was issued for exactly
 *     that application identifier — it's not a stolen copy.
 *
 * 2FA:
 *   - `auth.ImportLoginToken` raises `SESSION_PASSWORD_NEEDED` for
 *     accounts that have 2FA enabled. The service exposes a per-clone
 *     `awaitingPassword` state; the controller asks the operator for
 *     the password, the service resumes via `submitPassword`, and the
 *     new client calls `auth.CheckPassword` to finalize.
 *
 * DC migration:
 *   - `auth.ExportLoginToken` can return `auth.LoginTokenMigrateTo`
 *     when the destination DC differs from the new client's current
 *     DC. GramJS handles the redirect via `_switchDC`, then we retry
 *     the export.
 */

'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const telegramService = require('./telegramService');
const telegramConfig = require('../config/telegram');
const { writeTelethonSessionFile } = require('../utils/gramjsToTelethon');

// In-memory job registry. One panel process is sufficient for V1 — the
// operator workflow is interactive and a job lives at most a few
// minutes. If we later need cross-process state we can swap to Redis
// without changing the public API.
const jobs = new Map();

// Disk root for staged .session / .json / .zip artifacts. Kept under
// the existing uploads dir so it shares the same persistence
// guarantees the rest of the panel relies on (Telethon session
// downloads already live here).
const uploadsRoot = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
const stageRoot = path.join(uploadsRoot, '_clone_export');

const DEFAULT_INTER_SESSION_DELAY_MS = 800;
const PASSWORD_WAIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const JOB_TTL_MS = 30 * 60 * 1000; // 30 min after completion
// Bound the new (destination) client's connect step. Without a
// timeout, a misbehaving DC or blocked egress can leave the clone
// hung in `connecting_destination` forever, which is what the
// operator saw as "sessions were 100% active but export failed\" —
// the row never moved past 15% and never produced a real error.
const NEW_CLIENT_CONNECT_TIMEOUT_MS = parseInt(
  process.env.CLONE_EXPORT_CONNECT_TIMEOUT_MS || '20000',
  10
);
// Same bound for the per-RPC calls on the new client. Telegram's
// QR-login RPCs normally return in <1s; if any one of them stalls,
// we want a clear timeout error instead of an unbounded wait.
const NEW_CLIENT_INVOKE_TIMEOUT_MS = parseInt(
  process.env.CLONE_EXPORT_INVOKE_TIMEOUT_MS || '15000',
  10
);

/**
 * Race a promise against a timeout. Used to bound the destination
 * client's connect/invoke calls so a stalled DC doesn't leave a clone
 * hung in `connecting_destination` forever.
 *
 * @param {Promise<T>} p
 * @param {number} ms
 * @param {string} tag  short label for the timeout error
 * @returns {Promise<T>}
 * @template T
 */
function withCloneTimeout(p, ms, tag) {
  let timer = null;
  return Promise.race([
    Promise.resolve(p).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`[CLONE_TIMEOUT] ${tag} did not complete within ${ms}ms`);
        e.isTimeout = true;
        reject(e);
      }, ms);
      if (timer.unref) timer.unref();
    }),
  ]);
}

function newJobId() {
  return `clone-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function sanitizeFilename(s) {
  return String(s || '').replace(/[^A-Za-z0-9+_.-]/g, '_').slice(0, 80) || 'session';
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
    downloadReady: job.status === 'completed' && !!job.zipPath,
    sessions: job.sessions.map((s) => ({
      sessionId: s.sessionId,
      phone: s.phone,
      status: s.status,
      progress: s.progress,
      error: s.error || null,
      awaitingPassword: s.status === 'awaiting_password',
      passwordHint: s.passwordHint || null,
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
    const job = jobs.get(jobId);
    if (!job) return;
    if (job.stageDir) {
      fs.remove(job.stageDir).catch(() => {});
    }
    jobs.delete(jobId);
  }, JOB_TTL_MS).unref?.();
}

/**
 * Wait for a 2FA password to be submitted via `submitPassword`. If the
 * job carries a `sharedPassword` (operator ticked "same password for
 * all sessions" up-front) we use that and skip the wait entirely.
 * Otherwise the per-session prompt is exposed and the worker blocks
 * until `submitPassword` resolves it or the timeout fires.
 *
 * @param {object} sessionState
 * @param {object} job
 */
function waitForPassword(sessionState, job) {
  if (job && typeof job.sharedPassword === 'string' && job.sharedPassword.length > 0) {
    return Promise.resolve(job.sharedPassword);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sessionState._passwordResolver = null;
      sessionState._passwordRejecter = null;
      reject(new Error('Timed out waiting for 2FA password (5 minutes)'));
    }, PASSWORD_WAIT_TIMEOUT_MS);
    timer.unref?.();
    sessionState._passwordResolver = (pw) => {
      clearTimeout(timer);
      sessionState._passwordResolver = null;
      sessionState._passwordRejecter = null;
      resolve(pw);
    };
    sessionState._passwordRejecter = (err) => {
      clearTimeout(timer);
      sessionState._passwordResolver = null;
      sessionState._passwordRejecter = null;
      reject(err);
    };
  });
}

/**
 * Clone one session via the QR-login-token RPCs. Returns the saved
 * GramJS string session for the new authorization, plus the new
 * client's `dc_id`. Throws on permanent failure.
 *
 * @param {object} ctx                     job-scope context
 * @param {object} sessionRow              { id, phone, api_id, api_hash, account_info }
 * @param {object} sessionState            mutable progress slot
 * @param {number} destApiId
 * @param {string} destApiHash
 */
async function cloneOne(ctx, sessionRow, sessionState, destApiId, destApiHash) {
  const sourceId = String(sessionRow.id);

  // 1. Ensure the panel's authorized client for this session is alive.
  sessionState.status = 'connecting_source';
  sessionState.progress = 5;
  await telegramService._ensureConnected(sourceId);
  const sourceEntry = telegramService._getClient(sourceId);
  if (!sourceEntry || !sourceEntry.client) {
    throw new Error(`Panel client for session ${sourceId} is not connected`);
  }
  const sourceClient = sourceEntry.client;

  // 2. Build a fresh new client with destination credentials. Empty
  //    StringSession → MTProto key exchange happens during connect,
  //    yielding a *new* auth_key that will become the cloned
  //    authorization.
  sessionState.status = 'connecting_destination';
  sessionState.progress = 15;
  const newSession = new StringSession('');
  const newClient = new TelegramClient(newSession, destApiId, destApiHash, {
    connectionRetries: telegramConfig.connectionRetries,
    timeout: telegramConfig.timeout,
    deviceModel: telegramConfig.deviceModel,
    systemVersion: telegramConfig.systemVersion,
    appVersion: telegramConfig.appVersion,
    langCode: telegramConfig.langCode,
    systemLangCode: telegramConfig.langCode,
    baseLogger: telegramConfig.baseLogger,
    useWSS: telegramConfig.useWSS,
    autoReconnect: false,
  });
  ctx.toDisconnect.push(newClient);

  // Bound the connect step so a stalled DC / blocked egress never
  // leaves the clone hung at progress=15. The operator's report was
  // "all sessions were 100% active but the export failed" with no
  // per-row error — that's the signature of an unbounded
  // `client.connect()` on the destination DC.
  try {
    await withCloneTimeout(
      newClient.connect(),
      NEW_CLIENT_CONNECT_TIMEOUT_MS,
      `destination client connect (apiId=${destApiId})`
    );
  } catch (connErr) {
    const m = String(connErr && connErr.message || connErr);
    if (connErr && connErr.isTimeout) {
      throw new Error(
        `[DEST_CONNECT_TIMEOUT] Could not reach Telegram with destApiId=${destApiId} within ${NEW_CLIENT_CONNECT_TIMEOUT_MS}ms. ` +
          `Confirm the destApiId/destApiHash are valid (https://my.telegram.org → API development tools) and that the panel host can reach Telegram DCs directly.`
      );
    }
    if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/i.test(m)) {
      throw new Error(
        `[DEST_API_INVALID] Telegram rejected destApiId=${destApiId} (${m}). Re-create a fresh api_id/api_hash pair at https://my.telegram.org and try again.`
      );
    }
    throw new Error(`[DEST_CONNECT_FAILED] ${m}`);
  }

  try {
    // 3. ExportLoginToken on the new (unauthorized) client. We may
    //    receive auth.loginTokenMigrateTo, requiring a DC switch on
    //    the new client; we retry up to 3 times for that.
    sessionState.status = 'exporting_token';
    sessionState.progress = 25;
    let tokenResult = null;
    let migrations = 0;
    while (migrations < 3) {
      tokenResult = await newClient.invoke(
        new Api.auth.ExportLoginToken({
          apiId: destApiId,
          apiHash: destApiHash,
          exceptIds: [],
        })
      );
      if (tokenResult instanceof Api.auth.LoginTokenMigrateTo) {
        migrations++;
        sessionState.progress = 25 + migrations * 2;
        // Switch the new client to the requested DC and retry the
        // export. GramJS exposes this as a private method; in v2 it's
        // `_switchDC`. We call it defensively so a future GramJS rename
        // doesn't crash the entire job.
        if (typeof newClient._switchDC === 'function') {
          await newClient._switchDC(tokenResult.dcId);
        } else if (typeof newClient.session.setDC === 'function') {
          newClient.session.setDC(tokenResult.dcId, null, null);
          await newClient.disconnect();
          await newClient.connect();
        } else {
          throw new Error(
            `Cannot follow auth.loginTokenMigrateTo: GramJS exposes neither _switchDC nor session.setDC`
          );
        }
        // After DC switch we must call ImportLoginToken with the
        // returned bytes, NOT re-export. Telegram docs: the migrate
        // response carries the same token to import on the new DC.
        const imported = await newClient.invoke(
          new Api.auth.ImportLoginToken({ token: tokenResult.token })
        );
        if (imported instanceof Api.auth.LoginTokenSuccess) {
          tokenResult = imported;
          break;
        }
        // Otherwise fall through and retry from the new DC.
        continue;
      }
      break;
    }

    // 4. If we don't already have a LoginTokenSuccess, route the
    //    plain LoginToken through accept on the source + import on
    //    the new client.
    if (!(tokenResult instanceof Api.auth.LoginTokenSuccess)) {
      if (!(tokenResult instanceof Api.auth.LoginToken)) {
        throw new Error(
          `Unexpected auth.ExportLoginToken result type: ${tokenResult && tokenResult.className}`
        );
      }
      const tokenBytes = tokenResult.token;

      sessionState.status = 'accepting_token';
      sessionState.progress = 50;
      // Panel's authorized client tells Telegram "yes, log in the
      // device that exported this token". This is the QR-scan
      // equivalent. AUTH_KEY_UNREGISTERED here means the source
      // session is dead — surface a clear error.
      try {
        await sourceClient.invoke(
          new Api.auth.AcceptLoginToken({ token: tokenBytes })
        );
      } catch (acceptErr) {
        const m = String(acceptErr && acceptErr.message || acceptErr);
        if (m.includes('AUTH_KEY_UNREGISTERED') || m.includes('SESSION_REVOKED')) {
          throw new Error(
            `[SOURCE_SESSION_REVOKED] Source session ${sourceId} was revoked by Telegram — re-login it from the Sessions tab and re-run the export.`
          );
        }
        if (m.includes('FROZEN_METHOD_INVALID')) {
          throw new Error(
            `[SOURCE_FROZEN] Source account is frozen / restricted by Telegram — cannot clone.`
          );
        }
        if (m.includes('AUTH_TOKEN_INVALID') || m.includes('AUTH_TOKEN_INVALIDX')) {
          throw new Error(
            `[INVALID_TOKEN] Telegram rejected the export token during accept. Try again.`
          );
        }
        throw acceptErr;
      }

      // ── Finalize: re-invoke auth.ExportLoginToken on the new
      //    (unauthorized) client. Per Telegram's QR-login protocol
      //    (mirrored in Telethon `qrlogin.py` and TDLib's qr-auth
      //    flow), AFTER the authorized side accepts the token, the
      //    unauthorized side calls ExportLoginToken a second time
      //    and receives `auth.LoginTokenSuccess { authorization }`.
      //
      //    `auth.ImportLoginToken` is ONLY for DC migration (called
      //    with the migrate-DC token after `LoginTokenMigrateTo`).
      //    Passing it the original (now-consumed) token returns
      //    AUTH_TOKEN_EXPIRED — which is exactly what every clone
      //    in the operator's logs failed with before this fix.
      sessionState.status = 'importing_token';
      sessionState.progress = 70;
      let importResult;
      try {
        importResult = await newClient.invoke(
          new Api.auth.ExportLoginToken({
            apiId: destApiId,
            apiHash: destApiHash,
            exceptIds: [],
          })
        );
      } catch (importErr) {
        const msg = String(importErr && importErr.message || importErr);
        if (msg.includes('SESSION_PASSWORD_NEEDED')) {
          // 2FA path. If the operator ticked "same password for all
          // sessions" up-front, waitForPassword resolves immediately
          // with the shared one — otherwise we expose the per-session
          // prompt and block until they submit.
          const hasShared = !!(ctx.job && ctx.job.sharedPassword);
          sessionState.status = hasShared ? 'verifying_password' : 'awaiting_password';
          sessionState.progress = hasShared ? 80 : 75;
          sessionState.passwordHint = hasShared
            ? 'Applying shared 2FA password…'
            : 'This account has 2FA enabled. Provide the cloud password to finish cloning.';
          const password = await waitForPassword(sessionState, ctx.job);
          sessionState.status = 'verifying_password';
          sessionState.progress = 85;
          const pwInfo = await newClient.invoke(new Api.account.GetPassword());
          const check = await computeCheck(pwInfo, password);
          importResult = await newClient.invoke(
            new Api.auth.CheckPassword({ password: check })
          );
        } else {
          throw importErr;
        }
      }
      // Telegram may need a brief moment between AcceptLoginToken on
      // the source and the re-export observing it. If we still see a
      // plain LoginToken (not LoginTokenSuccess yet), poll a few more
      // times before giving up — observed in practice on slower DCs.
      let pollsLeft = 6;
      while (
        pollsLeft > 0 &&
        importResult instanceof Api.auth.LoginToken &&
        !(importResult instanceof Api.auth.LoginTokenSuccess)
      ) {
        await new Promise((r) => setTimeout(r, 500));
        importResult = await newClient.invoke(
          new Api.auth.ExportLoginToken({
            apiId: destApiId,
            apiHash: destApiHash,
            exceptIds: [],
          })
        );
        pollsLeft--;
      }
      if (!(importResult instanceof Api.auth.LoginTokenSuccess) &&
          !(importResult instanceof Api.auth.Authorization)) {
        // Both shapes are valid: LoginTokenSuccess wraps an
        // Authorization; CheckPassword returns Authorization directly.
        throw new Error(
          `Unexpected import result type: ${importResult && importResult.className}`
        );
      }
    }

    // 5. The new client is now authorized. Save its session string.
    sessionState.status = 'saving';
    sessionState.progress = 95;
    const newStringSession = newClient.session.save();
    let dcId = null;
    try {
      dcId = newClient.session.dcId || (newClient.session._dcId) || null;
    } catch (_) { /* best-effort */ }

    let accountUser = null;
    try {
      accountUser = await newClient.invoke(new Api.users.GetFullUser({
        id: new Api.InputUserSelf(),
      }));
    } catch (_) { /* best-effort */ }

    sessionState.status = 'cloned';
    sessionState.progress = 100;

    return { newStringSession, dcId, accountUser };
  } finally {
    try { await newClient.disconnect(); } catch (_) { /* best-effort */ }
  }
}

/**
 * Build the on-disk artifacts (.session, .json) for one successful
 * clone and return their absolute paths.
 *
 * @param {object} sessionRow  { id, phone }
 * @param {string} stageDir
 * @param {object} clone       { newStringSession, dcId, accountUser }
 * @param {object} ctx         { destApiId, destApiHash }
 */
function writeArtifacts(sessionRow, stageDir, clone, ctx) {
  const safe = sanitizeFilename(sessionRow.phone || `session-${sessionRow.id}`);
  const sessionPath = path.join(stageDir, `${safe}.session`);
  const jsonPath = path.join(stageDir, `${safe}.json`);

  // .session (Telethon SQLite)
  writeTelethonSessionFile(clone.newStringSession, sessionPath);

  // .json (GramJS-compatible envelope, plain text by design — the
  // bundle is consumed off-panel by a different operator, so we don't
  // encrypt with the panel's key)
  const json = {
    platform: 'telegram',
    sourceSessionId: sessionRow.id,
    sourcePhone: sessionRow.phone || null,
    apiId: ctx.destApiId,
    apiHash: ctx.destApiHash,
    stringSession: clone.newStringSession,
    dcId: clone.dcId || null,
    exportedAt: new Date().toISOString(),
    exportedBy: 'web-pannel session-duplication',
  };
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));

  return { sessionPath, jsonPath, safe };
}

/**
 * Build the final ZIP bundle. Returns its absolute path.
 *
 * @param {object} job
 */
function buildZip(job) {
  const zip = new AdmZip();
  const manifest = {
    panelExport: 'telegram-session-clone',
    exportedAt: new Date().toISOString(),
    destApiId: job.destApiId,
    sessions: [],
  };
  for (const s of job.sessions) {
    if (s.status !== 'cloned' || !s.artifactPaths) continue;
    zip.addLocalFile(s.artifactPaths.sessionPath);
    zip.addLocalFile(s.artifactPaths.jsonPath);
    manifest.sessions.push({
      sourceSessionId: s.sessionId,
      phone: s.phone,
      sessionFile: path.basename(s.artifactPaths.sessionPath),
      jsonFile: path.basename(s.artifactPaths.jsonPath),
      dcId: s.dcId || null,
    });
  }
  zip.addFile(
    'manifest.json',
    Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  );
  const zipPath = path.join(job.stageDir, `clone-export-${job.id}.zip`);
  zip.writeZip(zipPath);
  return zipPath;
}

/**
 * Drive the entire job: load each row, clone, write artifacts, then
 * package the ZIP. Runs as a fire-and-forget after `startCloneJob`.
 *
 * @param {object} job
 */
async function runJob(job) {
  const ctx = {
    destApiId: job.destApiId,
    destApiHash: job.destApiHash,
    toDisconnect: [],
    job,
  };
  try {
    for (const sessionState of job.sessions) {
      if (job.status === 'cancelled') break;
      const sourceId = sessionState.sessionId;
      try {
        // Re-fetch the latest row so a session that was just revoked
        // is caught before we even try.
        const r = await pool.query(
          `SELECT id, phone, api_id, api_hash, status, is_logged_in
             FROM sessions
            WHERE id = $1 AND user_id = $2 AND platform = 'telegram'`,
          [sourceId, job.userId]
        );
        const row = r.rows[0];
        if (!row) {
          throw new Error('Session not found (deleted or wrong user)');
        }
        if (row.status === 'revoked' || row.is_logged_in === false) {
          throw new Error(
            `Session is not active (status=${row.status}, is_logged_in=${row.is_logged_in}). ` +
            `Only active, logged-in sessions can be cloned.`
          );
        }
        sessionState.phone = row.phone || null;

        const clone = await cloneOne(ctx, row, sessionState, job.destApiId, job.destApiHash);
        const artifactPaths = writeArtifacts(row, job.stageDir, clone, ctx);
        sessionState.artifactPaths = artifactPaths;
        sessionState.dcId = clone.dcId;

        await new Promise((res) => setTimeout(res, job.interSessionDelayMs));
      } catch (err) {
        sessionState.status = 'failed';
        sessionState.error = err && err.message ? err.message : String(err);
        logger.warn(
          `sessionDuplication: clone failed for session ${sourceId}: ${sessionState.error}`,
          { jobId: job.id }
        );
      }
    }

    if (job.status !== 'cancelled') {
      job.zipPath = buildZip(job);
      job.status = 'completed';
    }
  } catch (err) {
    job.status = 'failed';
    job.error = err && err.message ? err.message : String(err);
    logger.error(`sessionDuplication: job ${job.id} crashed: ${job.error}`);
  } finally {
    job.finishedAt = new Date().toISOString();
    // Disconnect every ephemeral client we created, including those
    // for sessions that failed partway through.
    for (const c of ctx.toDisconnect) {
      try { await c.disconnect(); } catch (_) { /* best-effort */ }
    }
    scheduleCleanup(job.id);
  }
}

/**
 * Kick off a new session-duplication job. Returns the job id
 * immediately; the heavy work happens in the background.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {Array<number|string>} params.sessionIds   panel session IDs to clone
 * @param {number} params.destApiId
 * @param {string} params.destApiHash
 * @param {number} [params.interSessionDelayMs]
 */
async function startCloneJob(params) {
  const { userId, sessionIds, destApiId, destApiHash, sharedPassword } = params;
  if (!userId) throw new Error('userId required');
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new Error('sessionIds required (non-empty array)');
  }
  if (!destApiId || !destApiHash) {
    throw new Error('destApiId and destApiHash are required');
  }
  const parsedApiId = Number(destApiId);
  if (!Number.isFinite(parsedApiId) || parsedApiId <= 0) {
    throw new Error('destApiId must be a positive integer');
  }
  if (typeof destApiHash !== 'string' || destApiHash.length < 16) {
    throw new Error('destApiHash looks invalid (expected 32-hex-char string)');
  }

  await fs.ensureDir(stageRoot);
  const jobId = newJobId();
  const stageDir = path.join(stageRoot, jobId);
  await fs.ensureDir(stageDir);

  const job = {
    id: jobId,
    userId,
    destApiId: parsedApiId,
    destApiHash,
    // Optional "same 2FA password for every session" — operator ticks
    // this when all accounts in the batch share a cloud password.
    // When set, sessions that hit SESSION_PASSWORD_NEEDED don't pause
    // to ask; the runner uses this password directly.
    sharedPassword: typeof sharedPassword === 'string' && sharedPassword.length > 0
      ? sharedPassword
      : null,
    interSessionDelayMs: Number.isFinite(params.interSessionDelayMs)
      ? Math.max(0, params.interSessionDelayMs)
      : DEFAULT_INTER_SESSION_DELAY_MS,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stageDir,
    zipPath: null,
    error: null,
    sessions: sessionIds.map((sid) => ({
      sessionId: Number(sid),
      phone: null,
      status: 'queued',
      progress: 0,
      error: null,
      artifactPaths: null,
      dcId: null,
      passwordHint: null,
      _passwordResolver: null,
      _passwordRejecter: null,
    })),
  };
  jobs.set(jobId, job);

  // Fire-and-forget. Errors inside `runJob` are captured into `job`.
  runJob(job).catch((err) => {
    logger.error(`sessionDuplication: unhandled runJob error: ${err.message}`);
  });

  return { jobId };
}

/**
 * Fetch a job (validating ownership) and return the public view.
 *
 * @param {string} jobId
 * @param {number} userId
 */
function getJobStatus(jobId, userId) {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) {
    return null;
  }
  return publicJobView(job);
}

/**
 * Resolve a 2FA password prompt for a specific session inside a job.
 *
 * @param {string} jobId
 * @param {number} userId
 * @param {number} sessionId
 * @param {string} password
 */
function submitPassword(jobId, userId, sessionId, password) {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) return false;
  const s = job.sessions.find((x) => Number(x.sessionId) === Number(sessionId));
  if (!s || !s._passwordResolver) return false;
  s._passwordResolver(password);
  return true;
}

/**
 * Cancel a running job. In-flight clones see `job.status === 'cancelled'`
 * at the next loop boundary; password waiters are rejected.
 *
 * @param {string} jobId
 * @param {number} userId
 */
function cancelJob(jobId, userId) {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) return false;
  job.status = 'cancelled';
  for (const s of job.sessions) {
    if (s._passwordRejecter) s._passwordRejecter(new Error('Job cancelled'));
  }
  return true;
}

/**
 * Locate the zip path for a completed job (for the download endpoint).
 *
 * @param {string} jobId
 * @param {number} userId
 */
function getJobZipPath(jobId, userId) {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) return null;
  if (job.status !== 'completed' || !job.zipPath) return null;
  return job.zipPath;
}

module.exports = {
  startCloneJob,
  getJobStatus,
  submitPassword,
  cancelJob,
  getJobZipPath,
  // Exposed for tests; not part of the controller surface.
  _internal: { jobs, cloneOne, writeArtifacts, buildZip, runJob },
};
