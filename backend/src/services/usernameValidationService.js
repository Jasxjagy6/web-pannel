'use strict';

const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');
const logger = require('../utils/logger');
const telegramService = require('./telegramService');
const sessionListService = require('./sessionListService');

const MAX_JOB_USERNAMES = parseInt(process.env.MAX_JOB_USERNAMES || '100000', 10);
const TICK_MS = Math.max(1000, parseInt(process.env.USERNAME_VALIDATION_TICK_MS || '3000', 10));
const JOB_CONCURRENCY = Math.max(
  1,
  Math.min(10, parseInt(process.env.USERNAME_VALIDATION_JOB_CONCURRENCY || '3', 10))
);
const STALE_JOB_MINUTES = Math.max(
  2,
  parseInt(process.env.USERNAME_VALIDATION_STALE_JOB_MINUTES || '10', 10)
);
const ITEM_DELAY_MIN_MS = Math.max(0, parseInt(process.env.USERNAME_VALIDATION_DELAY_MIN_MS || '350', 10));
const ITEM_DELAY_MAX_MS = Math.max(
  ITEM_DELAY_MIN_MS,
  parseInt(process.env.USERNAME_VALIDATION_DELAY_MAX_MS || '900', 10)
);
const TERMINAL_STATUSES = new Set(['completed', 'exhausted', 'cancelled', 'failed']);
const MAX_SESSION_LISTS_PER_JOB = 50;

let timer = null;
let running = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function itemDelay() {
  if (ITEM_DELAY_MAX_MS <= ITEM_DELAY_MIN_MS) return ITEM_DELAY_MIN_MS;
  return Math.floor(
    ITEM_DELAY_MIN_MS + Math.random() * (ITEM_DELAY_MAX_MS - ITEM_DELAY_MIN_MS + 1)
  );
}

function normalizeSessionListIds(sessionListId, sessionListIds) {
  const ids = [];
  const seen = new Set();
  const add = (value) => {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  if (Array.isArray(sessionListIds)) sessionListIds.forEach(add);
  add(sessionListId);
  return ids;
}

function normalizeUsernameCandidate(raw) {
  if (raw == null) return null;
  let value = String(raw).trim();
  if (!value) return null;

  const urlMatch = value.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([^/?#]+)(?:[/?#].*)?$/i
  );
  if (urlMatch) value = urlMatch[1];
  value = value.replace(/^@+/, '').trim();
  if (!/^[A-Za-z0-9_]{1,64}$/.test(value)) return null;

  return {
    username: value,
    normalized: value.toLowerCase(),
  };
}

function errorText(error) {
  return [error?.errorMessage, error?.code, error?.message]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
}

function classifyResolveError(error) {
  const text = errorText(error);
  if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|USERNAME_PURCHASE_AVAILABLE/.test(text)) {
    const code = text.match(/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|USERNAME_PURCHASE_AVAILABLE/)?.[0];
    return { kind: 'invalid_username', code: code || 'USERNAME_INVALID' };
  }

  const floodSeconds = text.match(/A WAIT OF (\d+) SECONDS|FLOOD[ _-]?WAIT[ _-]?(\d+)?/);
  if (floodSeconds) {
    const seconds = floodSeconds[1] || floodSeconds[2];
    return {
      kind: 'session_failure',
      code: seconds ? `FLOOD_WAIT_${seconds}` : 'FLOOD_WAIT',
      retryAfterSeconds: seconds ? Number(seconds) : null,
    };
  }

  const knownCode = text.match(
    /PEER_FLOOD|FLOOD_WAIT(?:_\d+)?|AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|SESSION_FROZEN|SESSION_NOT_FOUND|SESSION_NOT_LOGGED_IN|USER_DEACTIVATED|CLIENT_UNAVAILABLE|SESSION_LOCKED_BY_OTHER_WORKER|RPC_CALL_FAIL|TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|SOCKET_CLOSED|CONNECTION_(?:FAILED|CLOSED)|NETWORK_ERROR/
  )?.[0];
  if (!knownCode) {
    return {
      kind: 'item_failure',
      code: String(error?.code || error?.errorMessage || 'RESOLVE_FAILED').slice(0, 80),
    };
  }
  return {
    kind: 'session_failure',
    code: knownCode,
  };
}

function terminalJobView(row, recentItems = []) {
  const total = Number(row.total_count || 0);
  const processed = Number(row.processed_count || 0);
  const skipped = Number(row.skipped_count || 0);
  const handled = Math.min(total, processed + skipped);
  const method = row.validation_method || 'session';
  const passProcessed = Number(row.pass_processed_count || 0);
  const passTotal = Number(row.pass_total_count || 0);
  return {
    id: Number(row.id),
    status: row.status,
    validationMethod: method,
    sourceListId: row.source_list_id != null ? Number(row.source_list_id) : null,
    sourceListName: row.source_list_name,
    sessionListId: row.session_list_id != null ? Number(row.session_list_id) : null,
    sessionListName: row.session_list_name,
    sessionListIds: Array.isArray(row.session_list_ids)
      ? row.session_list_ids.map(Number).filter(Number.isFinite)
      : (row.session_list_id != null ? [Number(row.session_list_id)] : []),
    sessionListNames: Array.isArray(row.session_list_names)
      ? row.session_list_names
      : (row.session_list_name ? [row.session_list_name] : []),
    resultListId: row.result_list_id != null ? Number(row.result_list_id) : null,
    resultListName: row.result_list_name,
    sourceItemsCount: Number(row.source_items_count || 0),
    totalCount: total,
    processedCount: processed,
    validCount: Number(row.valid_count || 0),
    invalidCount: Number(row.invalid_count || 0),
    failedCount: Number(row.failed_count || 0),
    skippedCount: skipped,
    ignoredCount: Number(row.ignored_count || 0),
    duplicateCount: Number(row.duplicate_count || 0),
    handledCount: handled,
    progressPct: total > 0 ? Math.round((handled / total) * 100) : 100,
    currentPass: Number(row.current_pass || 0),
    maxPasses: Number(row.max_passes || 1),
    passProcessedCount: passProcessed,
    passTotalCount: passTotal,
    passProgressPct: passTotal > 0 ? Math.round((passProcessed / passTotal) * 100) : 0,
    totalRequests: Number(row.total_requests || 0),
    timedOut: !!row.timed_out,
    selectedSessions: Array.isArray(row.selected_sessions) ? row.selected_sessions : [],
    retiredSessions: Array.isArray(row.retired_sessions) ? row.retired_sessions : [],
    currentUsername: row.current_username || null,
    currentSessionId: row.current_session_id != null ? Number(row.current_session_id) : null,
    cancelRequested: !!row.cancel_requested,
    retryAfterFloodWait: !!row.retry_after_flood_wait,
    retryPassUsed: !!row.retry_pass_used,
    retryAt: row.retry_at || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastProgressAt: row.last_progress_at,
    recentItems: recentItems.map((item) => ({
      id: Number(item.id),
      username: item.username,
      resolvedUsername: item.resolved_username || null,
      telegramId: item.resolved_telegram_id != null ? String(item.resolved_telegram_id) : null,
      status: item.status,
      sessionId: item.session_id != null ? Number(item.session_id) : null,
      attempts: Number(item.attempts || 0),
      errorCode: item.error_code || null,
      errorMessage: item.error_message || null,
      finishedAt: item.finished_at,
    })),
  };
}

async function startJob({
  userId,
  sourceListId,
  sessionListId,
  sessionListIds,
  resultListName,
  retryAfterFloodWait = false,
}) {
  const sourceId = Number(sourceListId);
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new AppError('A valid sourceListId is required', 400, 'INVALID_SOURCE_LIST_ID');
  }

  const requestedSessionListIds = normalizeSessionListIds(sessionListId, sessionListIds);
  if (requestedSessionListIds.length === 0) {
    throw new AppError('At least one valid session list is required', 400, 'INVALID_SESSION_LIST_IDS');
  }
  if (requestedSessionListIds.length > MAX_SESSION_LISTS_PER_JOB) {
    throw new AppError(
      `Select at most ${MAX_SESSION_LISTS_PER_JOB} session lists per job`,
      400,
      'TOO_MANY_SESSION_LISTS'
    );
  }

  const { rows: sourceRows } = await pool.query(
    `SELECT id, name, type, platform, items_count
       FROM lists
      WHERE id = $1 AND user_id = $2 AND platform = 'telegram'`,
    [sourceId, userId]
  );
  const source = sourceRows[0];
  if (!source) throw new AppError('Source user list not found', 404, 'SOURCE_LIST_NOT_FOUND');
  if (source.type === 'profile') {
    throw new AppError('Profile lists cannot be username-validated', 400, 'INVALID_SOURCE_LIST_TYPE');
  }

  const selectedSessionLists = [];
  const sessionRows = [];
  const seenSessions = new Set();
  for (const listId of requestedSessionListIds) {
    // eslint-disable-next-line no-await-in-loop
    const sessionList = await sessionListService.getList({ userId, listId });
    if (sessionList.platform !== 'telegram') {
      throw new AppError(
        `Session list ${listId} must contain Telegram sessions`,
        400,
        'INVALID_SESSION_LIST_PLATFORM'
      );
    }
    selectedSessionLists.push(sessionList);
    // eslint-disable-next-line no-await-in-loop
    const rows = await sessionListService.getListSessions({
      userId,
      listId,
      includeAll: false,
      includeFrozen: false,
    });
    for (const row of rows) {
      const id = Number(row.id);
      if (!seenSessions.has(id)) {
        seenSessions.add(id);
        sessionRows.push(row);
      }
    }
  }
  if (sessionRows.length === 0) {
    throw new AppError('The selected session lists have no active non-frozen sessions', 400, 'EMPTY_SESSION_LISTS');
  }

  const { rows: sourceItems } = await pool.query(
    `SELECT id, username
       FROM list_items
      WHERE list_id = $1
      ORDER BY id ASC`,
    [sourceId]
  );
  if (sourceItems.length > MAX_JOB_USERNAMES) {
    throw new AppError(
      `Username validation supports at most ${MAX_JOB_USERNAMES} source rows per job`,
      400,
      'SOURCE_LIST_TOO_LARGE'
    );
  }

  const candidates = [];
  const seen = new Set();
  let ignoredCount = 0;
  let duplicateCount = 0;
  for (const item of sourceItems) {
    const parsed = normalizeUsernameCandidate(item.username);
    if (!parsed) {
      ignoredCount++;
      continue;
    }
    if (seen.has(parsed.normalized)) {
      duplicateCount++;
      continue;
    }
    seen.add(parsed.normalized);
    candidates.push({ sourceItemId: Number(item.id), ...parsed });
  }
  if (candidates.length === 0) {
    throw new AppError('The source list contains no usable usernames', 400, 'NO_USERNAMES');
  }

  const requestedName = String(resultListName || '').trim();
  const outputName = (requestedName || `${source.name} - Valid Usernames`).slice(0, 255);
  const selectedSessions = sessionRows.map((row) => ({
    id: Number(row.id),
    phone: row.phone || null,
    username: row.username || null,
    spamStatus: row.spam_status || 'unknown',
    spamLimitUntil: row.spam_limit_until || null,
  }));
  const sessionListNames = selectedSessionLists.map((list) => list.name);
  const sessionListLabel = sessionListNames.join(' + ').slice(0, 255);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultList = await client.query(
      `INSERT INTO lists (user_id, name, type, items_count, source, platform, created_at)
       VALUES ($1, $2, 'users', 0, 'username_validation', 'telegram', NOW())
       RETURNING id, name`,
      [userId, outputName]
    );
    const output = resultList.rows[0];
    const jobResult = await client.query(
      `INSERT INTO username_validation_jobs (
         user_id, source_list_id, session_list_id, result_list_id,
         source_list_name, session_list_name, result_list_name,
         source_items_count, total_count, ignored_count, duplicate_count,
         selected_sessions, session_list_ids, session_list_names,
         retry_after_flood_wait, status, created_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,'pending',NOW()
       )
       RETURNING *`,
      [
        userId,
        sourceId,
        requestedSessionListIds[0],
        output.id,
        source.name,
        sessionListLabel,
        output.name,
        sourceItems.length,
        candidates.length,
        ignoredCount,
        duplicateCount,
        JSON.stringify(selectedSessions),
        JSON.stringify(requestedSessionListIds),
        JSON.stringify(sessionListNames),
        retryAfterFloodWait === true,
      ]
    );
    const job = jobResult.rows[0];

    for (let offset = 0; offset < candidates.length; offset += 1000) {
      const batch = candidates.slice(offset, offset + 1000);
      await client.query(
        `INSERT INTO username_validation_items (
           job_id, source_list_item_id, username, normalized_username
         )
         SELECT $1, item_id, username, normalized
           FROM UNNEST($2::int[], $3::text[], $4::text[])
                AS input(item_id, username, normalized)`,
        [
          job.id,
          batch.map((item) => item.sourceItemId),
          batch.map((item) => item.username),
          batch.map((item) => item.normalized),
        ]
      );
    }

    await client.query('COMMIT');
    setImmediate(() => runSweepOnce().catch(() => {}));
    return terminalJobView(job);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === '23505') {
      throw new AppError(
        'A username validation job is already running for this account',
        409,
        'USERNAME_VALIDATION_ALREADY_RUNNING'
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getJob(userId, jobId) {
  const { rows } = await pool.query(
    `SELECT * FROM username_validation_jobs WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );
  if (!rows[0]) throw new AppError('Username validation job not found', 404, 'JOB_NOT_FOUND');
  const { rows: recent } = await pool.query(
    `SELECT id, username, resolved_username, resolved_telegram_id, status,
            session_id, attempts, error_code, error_message, finished_at
       FROM username_validation_items
      WHERE job_id = $1 AND status <> 'pending'
      ORDER BY COALESCE(finished_at, started_at, created_at) DESC, id DESC
      LIMIT 30`,
    [jobId]
  );
  return terminalJobView(rows[0], recent);
}

async function listJobs(userId, { limit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const { rows } = await pool.query(
    `SELECT * FROM username_validation_jobs
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [userId, safeLimit]
  );
  return rows.map((row) => terminalJobView(row));
}

async function cancelJob(userId, jobId) {
  const { rows } = await pool.query(
    `UPDATE username_validation_jobs
        SET cancel_requested = TRUE,
            last_progress_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'running', 'waiting')
      RETURNING *`,
    [jobId, userId]
  );
  if (!rows[0]) {
    const existing = await getJob(userId, jobId);
    return existing;
  }
  if (rows[0].status === 'pending' || rows[0].status === 'waiting') {
    await markRemainingSkipped(jobId, 'CANCELLED', 'Job cancelled by operator');
    await finalizeJob(jobId, 'cancelled');
    return getJob(userId, jobId);
  }
  return terminalJobView(rows[0]);
}

async function claimNextJob() {
  const { rows } = await pool.query(
    `WITH next AS (
       SELECT id, status AS previous_status FROM username_validation_jobs
         WHERE validation_method = 'session'
           AND cancel_requested = FALSE
          AND (
            status = 'pending'
            OR (status = 'waiting' AND retry_at <= NOW())
          )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE username_validation_jobs job
        SET status = 'running',
            started_at = COALESCE(started_at, NOW()),
            retry_pass_used = CASE
              WHEN next.previous_status = 'waiting' THEN TRUE
              ELSE job.retry_pass_used
            END,
            retired_sessions = CASE
              WHEN next.previous_status = 'waiting' THEN '[]'::jsonb
              ELSE job.retired_sessions
            END,
            retry_at = CASE
              WHEN next.previous_status = 'waiting' THEN NULL
              ELSE job.retry_at
            END,
            last_progress_at = NOW()
       FROM next
      WHERE job.id = next.id
      RETURNING job.*`
  );
  return rows[0] || null;
}

async function isCancelled(jobId) {
  const { rows } = await pool.query(
    'SELECT cancel_requested FROM username_validation_jobs WHERE id = $1',
    [jobId]
  );
  return !!rows[0]?.cancel_requested;
}

async function nextPendingItem(jobId) {
  const { rows } = await pool.query(
    `SELECT id, username, normalized_username
       FROM username_validation_items
      WHERE job_id = $1 AND status = 'pending'
      ORDER BY id ASC
      LIMIT 1`,
    [jobId]
  );
  return rows[0] || null;
}

function sessionIdsOf(job) {
  return (Array.isArray(job.selected_sessions) ? job.selected_sessions : [])
    .map((session) => Number(typeof session === 'object' ? session.id : session))
    .filter((id) => Number.isFinite(id) && id > 0);
}

function retiredIdsOf(job) {
  return new Set(
    (Array.isArray(job.retired_sessions) ? job.retired_sessions : [])
      .map((session) => Number(typeof session === 'object' ? session.id : session))
      .filter(Number.isFinite)
  );
}

async function markRemainingSkipped(jobId, code, message) {
  const { rowCount } = await pool.query(
    `UPDATE username_validation_items
        SET status = 'skipped', error_code = $2, error_message = $3,
            finished_at = NOW()
      WHERE job_id = $1 AND status IN ('pending', 'running')`,
    [jobId, code, String(message || '').slice(0, 500)]
  );
  if (rowCount > 0) {
    await pool.query(
      `UPDATE username_validation_jobs
          SET skipped_count = skipped_count + $2, last_progress_at = NOW()
        WHERE id = $1`,
      [jobId, rowCount]
    );
  }
  return rowCount;
}

async function finalizeJob(jobId, status, errorMessage = null) {
  await pool.query(
    `UPDATE username_validation_jobs
        SET status = $2, error_message = $3, current_username = NULL,
            current_session_id = NULL, finished_at = NOW(), last_progress_at = NOW()
      WHERE id = $1`,
    [jobId, status, errorMessage ? String(errorMessage).slice(0, 1000) : null]
  );
}

async function retireSession(job, sessionId, classification, error, username) {
  const retired = Array.isArray(job.retired_sessions) ? [...job.retired_sessions] : [];
  if (!retired.some((entry) => Number(entry?.id ?? entry) === Number(sessionId))) {
    retired.push({
      id: Number(sessionId),
      code: classification.code,
      message: String(error?.message || error || '').slice(0, 300),
      username,
      retiredAt: new Date().toISOString(),
      retryAt: Number.isFinite(classification.retryAfterSeconds)
        ? new Date(Date.now() + classification.retryAfterSeconds * 1000).toISOString()
        : null,
    });
  }
  job.retired_sessions = retired;
  await pool.query(
    `UPDATE username_validation_jobs
        SET retired_sessions = $2::jsonb, current_username = NULL,
            current_session_id = NULL, last_progress_at = NOW()
      WHERE id = $1`,
    [job.id, JSON.stringify(retired)]
  );
  await pool.query(
    `UPDATE username_validation_items
        SET status = 'pending', error_code = $2, error_message = $3,
            started_at = NULL
      WHERE id = $1`,
    [job.currentItemId, classification.code, String(error?.message || error || '').slice(0, 500)]
  );

  try {
    await require('./sessionService').maybeFlagRevoked(
      sessionId,
      error,
      'usernameValidationService'
    );
  } catch { /* best effort */ }
}

async function persistInvalid(job, item, sessionId, classification, error) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE username_validation_items
          SET status = 'invalid', session_id = $2, error_code = $3,
              error_message = $4, finished_at = NOW()
        WHERE id = $1`,
      [item.id, sessionId, classification.code, String(error?.message || error || '').slice(0, 500)]
    );
    await client.query(
      `UPDATE username_validation_jobs
          SET processed_count = processed_count + 1,
              invalid_count = invalid_count + 1,
              current_username = NULL, current_session_id = NULL,
              last_progress_at = NOW()
        WHERE id = $1`,
      [job.id]
    );
    await client.query('COMMIT');
  } catch (error_) {
    await client.query('ROLLBACK').catch(() => {});
    throw error_;
  } finally {
    client.release();
  }
}

async function persistFailed(job, item, sessionId, classification, error) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE username_validation_items
          SET status = 'failed', session_id = $2, error_code = $3,
              error_message = $4, finished_at = NOW()
        WHERE id = $1`,
      [item.id, sessionId, classification.code, String(error?.message || error || '').slice(0, 500)]
    );
    await client.query(
      `UPDATE username_validation_jobs
          SET processed_count = processed_count + 1,
              failed_count = failed_count + 1,
              current_username = NULL, current_session_id = NULL,
              last_progress_at = NOW()
        WHERE id = $1`,
      [job.id]
    );
    await client.query('COMMIT');
  } catch (error_) {
    await client.query('ROLLBACK').catch(() => {});
    throw error_;
  } finally {
    client.release();
  }
}

async function persistValid(job, item, sessionId, resolved) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO list_items (
         list_id, telegram_id, username, first_name, last_name, phone,
         access_hash, is_bot, is_premium, platform, added_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'telegram',NOW())
       RETURNING id`,
      [
        job.result_list_id,
        resolved.telegramId,
        String(resolved.username || item.username).replace(/^@+/, '').slice(0, 100),
        resolved.firstName ? String(resolved.firstName).slice(0, 100) : null,
        resolved.lastName ? String(resolved.lastName).slice(0, 100) : null,
        resolved.phone ? String(resolved.phone).slice(0, 30) : null,
        resolved.accessHash || null,
        !!resolved.isBot,
        !!resolved.isPremium,
      ]
    );
    const resultItemId = inserted.rows[0].id;
    await client.query(
      `UPDATE username_validation_items
          SET status = 'valid', result_list_item_id = $2, session_id = $3,
              resolved_telegram_id = $4, resolved_access_hash = $5,
              resolved_username = $6, resolved_first_name = $7,
              resolved_last_name = $8, resolved_phone = $9,
              error_code = NULL, error_message = NULL, finished_at = NOW()
        WHERE id = $1`,
      [
        item.id,
        resultItemId,
        sessionId,
        resolved.telegramId,
        resolved.accessHash || null,
        resolved.username || item.username,
        resolved.firstName || null,
        resolved.lastName || null,
        resolved.phone || null,
      ]
    );
    await client.query(
      'UPDATE lists SET items_count = items_count + 1 WHERE id = $1',
      [job.result_list_id]
    );
    await client.query(
      `UPDATE username_validation_jobs
          SET processed_count = processed_count + 1,
              valid_count = valid_count + 1,
              current_username = NULL, current_session_id = NULL,
              last_progress_at = NOW()
        WHERE id = $1`,
      [job.id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function processJob(job) {
  logger.info(`usernameValidation: starting job ${job.id}`, {
    userId: job.user_id,
    total: job.total_count,
    sessions: sessionIdsOf(job).length,
  });

  try {
    while (true) {
      if (await isCancelled(job.id)) {
        await markRemainingSkipped(job.id, 'CANCELLED', 'Job cancelled by operator');
        await finalizeJob(job.id, 'cancelled');
        return;
      }

      const item = await nextPendingItem(job.id);
      if (!item) {
        await finalizeJob(job.id, 'completed');
        return;
      }

      const retiredIds = retiredIdsOf(job);
      const sessionId = sessionIdsOf(job).find((id) => !retiredIds.has(id));
      if (!sessionId) {
        if (job.retry_after_flood_wait && !job.retry_pass_used) {
          const retryTimes = (Array.isArray(job.retired_sessions) ? job.retired_sessions : [])
            .map((entry) => entry?.retryAt ? new Date(entry.retryAt).getTime() : NaN)
            .filter(Number.isFinite);
          if (retryTimes.length > 0) {
            const retryAt = new Date(Math.max(Date.now(), Math.min(...retryTimes)));
            await pool.query(
              `UPDATE username_validation_jobs
                  SET status = 'waiting', retry_at = $2,
                      current_username = NULL, current_session_id = NULL,
                      error_message = NULL, last_progress_at = NOW()
                WHERE id = $1`,
              [job.id, retryAt]
            );
            logger.info(`usernameValidation: job ${job.id} waiting for one-time retry`, {
              retryAt: retryAt.toISOString(),
            });
            return;
          }
        }
        await markRemainingSkipped(
          job.id,
          'ALL_SESSIONS_EXHAUSTED',
          'All selected sessions were rate-limited, peer-flooded, disconnected, or revoked'
        );
        await finalizeJob(
          job.id,
          'exhausted',
          job.retry_after_flood_wait && job.retry_pass_used
            ? 'All selected sessions were exhausted again after the one-time retry'
            : 'All selected sessions were exhausted before every username could be checked'
        );
        return;
      }

      job.currentItemId = item.id;
      await pool.query(
        `UPDATE username_validation_items
            SET status = 'running', session_id = $2, attempts = attempts + 1,
                started_at = NOW(), error_code = NULL, error_message = NULL
          WHERE id = $1`,
        [item.id, sessionId]
      );
      await pool.query(
        `UPDATE username_validation_jobs
            SET current_username = $2, current_session_id = $3,
                last_progress_at = NOW()
          WHERE id = $1`,
        [job.id, item.username, sessionId]
      );

      let resolved;
      try {
        resolved = await telegramService.resolveUsernameLive(sessionId, item.username);
      } catch (error) {
        const classification = classifyResolveError(error);
        if (classification.kind === 'invalid_username') {
          await persistInvalid(job, item, sessionId, classification, error);
          const delay = itemDelay();
          if (delay > 0) await sleep(delay);
        } else if (classification.kind === 'session_failure') {
          logger.warn(`usernameValidation: retiring session ${sessionId}`, {
            jobId: job.id,
            username: item.username,
            code: classification.code,
            error: error?.message,
          });
          await retireSession(job, sessionId, classification, error, item.username);
        } else {
          // An unclassified RPC failure is attached to this username only.
          // It must not burn a healthy session or be mislabeled as a fake
          // username because Telegram did not return an authoritative answer.
          await persistFailed(job, item, sessionId, classification, error);
          const delay = itemDelay();
          if (delay > 0) await sleep(delay);
        }
        continue;
      }

      // Persistence failures are infrastructure/job failures, not evidence
      // that the Telegram session is unhealthy. Let the outer guard fail the
      // job while leaving every previously committed result intact.
      await persistValid(job, item, sessionId, resolved);
      const delay = itemDelay();
      if (delay > 0) await sleep(delay);
    }
  } catch (error) {
    logger.error(`usernameValidation: job ${job.id} failed`, { error: error?.message });
    if (job.currentItemId) {
      await pool.query(
        `UPDATE username_validation_items
            SET status = 'pending', started_at = NULL
          WHERE id = $1 AND status = 'running'`,
        [job.currentItemId]
      ).catch(() => {});
    }
    await finalizeJob(job.id, 'failed', error?.message || String(error)).catch(() => {});
  }
}

async function runSweepOnce() {
  if (running) return;
  running = true;
  try {
    const workerLoop = async () => {
      while (true) {
        const job = await claimNextJob();
        if (!job) return;
        await processJob(job);
      }
    };
    await Promise.all(Array.from({ length: JOB_CONCURRENCY }, () => workerLoop()));
  } finally {
    running = false;
  }
}

async function recoverOrphanedJobs() {
  const staleInterval = `${STALE_JOB_MINUTES} minutes`;
  await pool.query(
    `UPDATE username_validation_items
        SET status = 'pending', started_at = NULL
       WHERE status = 'running'
         AND job_id IN (SELECT id FROM username_validation_jobs WHERE validation_method = 'session')
         AND job_id IN (
          SELECT id FROM username_validation_jobs
            WHERE validation_method = 'session'
              AND status = 'running'
             AND COALESCE(last_progress_at, started_at, created_at) < NOW() - $1::interval
        )`,
    [staleInterval]
  );
  const { rows: cancelled } = await pool.query(
    `SELECT id FROM username_validation_jobs
      WHERE validation_method = 'session'
        AND cancel_requested = TRUE
        AND (
          status IN ('pending', 'waiting')
          OR (
            status = 'running'
            AND COALESCE(last_progress_at, started_at, created_at) < NOW() - $1::interval
          )
        )`,
    [staleInterval]
  );
  await pool.query(
    `UPDATE username_validation_jobs
        SET status = 'pending', current_username = NULL,
            current_session_id = NULL, started_at = NULL
      WHERE validation_method = 'session'
        AND status = 'running'
        AND cancel_requested = FALSE
        AND COALESCE(last_progress_at, started_at, created_at) < NOW() - $1::interval`,
    [staleInterval]
  );
  for (const job of cancelled) {
    await markRemainingSkipped(job.id, 'CANCELLED', 'Job cancelled by operator');
    await finalizeJob(job.id, 'cancelled');
  }
}

function startWorker() {
  if (timer) return;
  const tick = () => recoverOrphanedJobs()
    .then(() => runSweepOnce())
    .catch((error) => logger.error('usernameValidation boot recovery failed', { error: error.message }));
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  logger.info(
    `usernameValidation worker started (tick=${TICK_MS}ms, jobs=${JOB_CONCURRENCY}, ` +
    `itemDelay=${ITEM_DELAY_MIN_MS}-${ITEM_DELAY_MAX_MS}ms)`
  );
}

function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  startJob,
  getJob,
  listJobs,
  cancelJob,
  startWorker,
  stopWorker,
  runSweepOnce,
  _processJob: processJob,
  __internal: {
    normalizeUsernameCandidate,
    normalizeSessionListIds,
    classifyResolveError,
    terminalJobView,
    TERMINAL_STATUSES,
  },
};
