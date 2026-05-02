/**
 * Instagram scrape subsystem (provider.scrape.*).
 *
 * Targets (target_type column):
 *   - followers   → username's followers
 *   - following   → username's following
 *   - likers      → media's likers (mediaPk in target_ids)
 *
 * Persistence — uses the existing scraping_jobs / scraped_users tables
 * (now platform-aware via the v9 migration). Schema is shared with TG;
 * IG-specific columns include scraped_users.instagram_pk / full_name /
 * is_private / is_verified / thumbnail_url.
 */

const { pool } = require('../../config/database');
const logger = require('../../utils/logger');
const igClient = require('./client');
const systemSettings = require('../../services/systemSettingsService');
const webScraper = require('./webScraper');
const { decrypt } = require('../../utils/crypto');

const PLATFORM = 'instagram';

const VALID_TARGET_TYPES = ['followers', 'following', 'likers', 'commenters', 'tagged'];

/**
 * Sleep with random jitter — used between IG feed pages to stay
 * under the throttle threshold. IG bans aggressive panels fast.
 */
function _jitterSleep(minMs = 1500, maxMs = 3000) {
  const ms = Math.floor(minMs + Math.random() * Math.max(1, maxMs - minMs));
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Map an instagram-private-api error to a clean { statusCode, message }
 * pair so the caller can surface a friendly 4xx to the user instead of
 * a 500. Mirrors the pattern in providers/instagram/create.js.
 */
function _mapIgError(err) {
  if (!err) return { statusCode: 502, message: 'Unknown Instagram error' };
  const ctor = err.constructor && err.constructor.name;
  const msg = err.message || String(err);
  // Authentication / session expiry
  if (ctor === 'IgLoginRequiredError' || /login_required/i.test(msg)) {
    return { statusCode: 401, message: 'Instagram session is no longer logged in. Re-upload a fresh session.' };
  }
  if (ctor === 'IgCheckpointError' || /checkpoint_required/i.test(msg)) {
    return { statusCode: 401, message: 'Instagram is blocking this session with a checkpoint. Solve the checkpoint on a trusted device, then re-upload.' };
  }
  // Rate limit / spam guard
  if (
    ctor === 'IgActionSpamError' ||
    /please wait a few minutes|action_blocked|too many requests|rate.?limit/i.test(msg)
  ) {
    return { statusCode: 429, message: 'Instagram is rate-limiting this session. Slow down and try again in a few minutes.' };
  }
  // User-not-found / target issues
  if (ctor === 'IgUserHasNoFeedError' || /user not found|no feed/i.test(msg)) {
    return { statusCode: 404, message: 'Target Instagram user has no public feed.' };
  }
  if (/getIdByUsername.*not found|not_found|user_not_found/i.test(msg)) {
    return { statusCode: 404, message: 'Target Instagram username not found.' };
  }
  if (/private/i.test(msg) && /account|user/i.test(msg)) {
    return { statusCode: 403, message: 'Target account is private — you must follow it from the session account first.' };
  }
  return { statusCode: 502, message: msg };
}

async function _getPageSize(targetType, fallback = 200) {
  const v = await systemSettings.getSetting(`scrape.instagram.${targetType}_page_size`);
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function _getJobRow(jobId) {
  const r = await pool.query(`SELECT * FROM scraping_jobs WHERE id = $1`, [jobId]);
  return r.rows[0] || null;
}

async function _setStatus(jobId, status, extras = {}) {
  const fields = ['status = $1'];
  const values = [status];
  let p = 2;
  if (extras.error) { fields.push(`error_message = $${p++}`); values.push(extras.error); }
  if (extras.total_found !== undefined) { fields.push(`total_found = $${p++}`); values.push(extras.total_found); }
  if (extras.progress !== undefined) { fields.push(`progress = $${p++}`); values.push(extras.progress); }
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    fields.push(`completed_at = NOW()`);
  }
  values.push(jobId);
  await pool.query(`UPDATE scraping_jobs SET ${fields.join(', ')} WHERE id = $${p}`, values);
}

async function _insertUsersBatch(jobId, rows) {
  if (!rows || rows.length === 0) return 0;
  const placeholders = [];
  const values = [];
  let p = 1;
  for (const r of rows) {
    // scraped_users (post-v9) columns we use:
    //   job_id, telegram_id (NULL for IG), username, first_name, last_name,
    //   platform, instagram_pk, full_name, is_private, is_verified,
    //   thumbnail_url, scraped_at
    placeholders.push(
      `($${p++}, NULL, $${p++}, NULL, NULL, 'instagram', $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, NOW())`
    );
    values.push(
      jobId,
      r.username || null,
      r.pk ? Number(r.pk) : null,
      r.full_name || null,
      r.is_private == null ? null : !!r.is_private,
      r.is_verified == null ? null : !!r.is_verified,
      r.profile_pic_url || null
    );
  }
  await pool.query(
    `INSERT INTO scraped_users
       (job_id, telegram_id, username, first_name, last_name, platform,
        instagram_pk, full_name, is_private, is_verified, thumbnail_url, scraped_at)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT DO NOTHING`,
    values
  );
  return rows.length;
}

/**
 * Public API: createScrapeJob.
 *
 *   await provider.scrape.startMembers({
 *     userId, sessionIds, targetIdentifiers: ['nasa'], targetType: 'followers',
 *     limit: 5000, options: {...}
 *   })
 */
async function createScrapeJob({
  userId,
  sessionIds = [],
  targetType = 'followers',
  targetIdentifiers = [],
  limit = 1000,
  options = {},
}) {
  if (!userId) throw new Error('userId required');
  if (!VALID_TARGET_TYPES.includes(targetType)) {
    throw new Error(`Invalid target_type: ${targetType}. Expected one of ${VALID_TARGET_TYPES.join(', ')}`);
  }
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new Error('At least one sessionId required');
  }

  const r = await pool.query(
    `SELECT id, username FROM sessions
      WHERE user_id = $1 AND platform = 'instagram' AND is_logged_in = TRUE
        AND id = ANY($2::int[])`,
    [userId, sessionIds]
  );
  if (r.rows.length === 0) {
    throw new Error('No usable Instagram sessions for this scrape');
  }

  const targets = (targetIdentifiers || []).map(String);

  const jobInsert = await pool.query(
    `INSERT INTO scraping_jobs
       (user_id, platform, session_id, session_ids, target_type, target_id,
        target_ids, status, options, job_mode, created_at)
     VALUES ($1, 'instagram', $2, $3::int[], $4, $5, $6::text[], 'pending', $7::jsonb,
             CASE WHEN array_length($3::int[], 1) > 1 OR array_length($6::text[], 1) > 1
                  THEN 'multi' ELSE 'single' END,
             NOW())
     RETURNING id, status, created_at, target_type`,
    [
      userId,
      r.rows[0].id,
      r.rows.map((x) => x.id),
      targetType,
      targets[0] || null,
      targets,
      JSON.stringify({ limit, ...options }),
    ]
  );
  const jobRow = jobInsert.rows[0];

  try {
    // eslint-disable-next-line global-require
    const queueManager = require('../../config/queueManager');
    if (queueManager && queueManager.enqueueScrape) {
      await queueManager.enqueueScrape({ jobId: jobRow.id, platform: 'instagram' });
    } else {
      throw new Error('queueManager has no enqueueScrape');
    }
  } catch (err) {
    logger.warn(`IG.scrape: queue enqueue failed (${err.message}); running inline`);
    setImmediate(() => _executeScrapeJob(jobRow.id).catch((e) =>
      logger.error(`IG.scrape inline exec failed: ${e.message}`)
    ));
  }

  return jobRow;
}

async function _executeScrapeJob(jobId) {
  const job = await _getJobRow(jobId);
  if (!job) throw new Error(`Scrape job ${jobId} not found`);
  if (job.platform !== 'instagram') return; // not ours

  await _setStatus(jobId, 'running');

  const sessionIds = job.session_ids || [];
  const targets = job.target_ids || [];
  const limit = Number(job.options?.limit || job.options?.scrape_limit || 1000);

  const sessRows = await pool.query(
    `SELECT id, user_id, username, proxy_url, session_data, platform_state,
            warmup_state
       FROM sessions
      WHERE id = ANY($1::int[]) AND platform = 'instagram'
        AND is_logged_in = TRUE
        AND COALESCE(warmup_state->>'state', 'active')
            NOT IN ('needs_attention', 'dead')`,
    [sessionIds]
  );
  if (sessRows.rows.length === 0) {
    // Distinguish "no sessions at all" from "all flagged" so the
    // operator gets a clearer error in the job row.
    const flaggedRows = await pool.query(
      `SELECT id, warmup_state->>'state' AS state
         FROM sessions
        WHERE id = ANY($1::int[]) AND platform = 'instagram'`,
      [sessionIds]
    );
    const hasFlagged = flaggedRows.rows.some((r) =>
      ['needs_attention', 'dead'].includes(r.state || '')
    );
    await _setStatus(jobId, 'failed', {
      error: hasFlagged
        ? 'All selected IG sessions are currently flagged by Instagram (checkpoint or expired). Re-upload a fresh session and retry.'
        : 'No usable IG sessions',
    });
    return;
  }

  const session = sessRows.rows[0];
  // Browser-cookie sessions (uploaded via the cookieAdapter path) can't
  // talk to the mobile API from a panel host without tripping
  // checkpoint_required, but they CAN talk to the public web endpoints
  // under www.instagram.com — so we route them through the web scraper.
  const isCookieSession =
    session.platform_state && session.platform_state.source === 'browser_cookies';

  let totalScraped = 0;
  try {
    if (isCookieSession) {
      await _runWebScrape({ jobId, job, session, targets, limit });
    } else {
      totalScraped = await _runMobileScrape({ jobId, job, session, targets, limit });
    }

    // _runWebScrape / _runMobileScrape both update job rows incrementally.
    // Read the final total off the job row so the completed-progress
    // check uses the value the inserts actually committed.
    const finalRow = await _getJobRow(jobId);
    await _setStatus(jobId, 'completed', {
      total_found: finalRow?.total_found || totalScraped,
      progress: 100,
    });
  } catch (err) {
    const mapped = _mapIgError(err);
    logger.error(`IG.scrape job ${jobId} failed (status=${mapped.statusCode}): ${mapped.message}`);
    const finalRow = await _getJobRow(jobId);
    await _setStatus(jobId, 'failed', {
      error: mapped.message,
      total_found: finalRow?.total_found || totalScraped,
    });
    // Cross-cutting health update: if the failure was caused by IG
    // flagging the session (checkpoint / login_required / action
    // blocked), flip the session row to `needs_attention` so the
    // warm-up worker stops touching it and the operator sees the
    // state in the UI. We pull `kind` off the underlying error so
    // the classifier in igFetch is the single source of truth.
    try {
      const kind = err && (err.kind || (err.cause && err.cause.kind));
      if (kind === 'checkpoint' || kind === 'login_required' || kind === 'action_blocked') {
        // eslint-disable-next-line global-require
        const { pool } = require('../../config/database');
        const newState = kind === 'login_required' ? 'dead' : 'needs_attention';
        const newStatus = kind === 'login_required' ? 'expired' : 'checkpoint';
        await pool.query(
          `UPDATE sessions
              SET warmup_state = COALESCE(warmup_state, '{}'::jsonb)
                                 || jsonb_build_object(
                                      'state', $2::text,
                                      'last_error', $3::text,
                                      'last_error_kind', $4::text,
                                      'last_failed_at', NOW()::text),
                  status = $5,
                  is_logged_in = CASE WHEN $4::text = 'login_required'
                                      THEN FALSE ELSE is_logged_in END,
                  updated_at = NOW()
            WHERE id = $1`,
          [session.id, newState, mapped.message, kind, newStatus]
        );
        logger.warn(
          `IG.scrape: flipped session ${session.id} → ${newState} (${kind})`
        );
      }
    } catch (flipErr) {
      logger.warn(
        `IG.scrape: failed to flip session ${session.id} health state: ${flipErr.message}`
      );
    }
  }
}

/**
 * Cookie-uploaded session path — uses the public web endpoints under
 * www.instagram.com, which only need the sessionid cookie and don't
 * trigger the mobile API's "new device" checkpoint wall.
 */
async function _runWebScrape({ jobId, job, session, targets, limit }) {
  if (!['followers', 'following'].includes(job.target_type)) {
    await _setStatus(jobId, 'failed', {
      error: `Target type ${job.target_type} is not yet implemented for cookie-uploaded sessions`,
    });
    return 0;
  }

  // Decrypt session_data into the canonical { cookies, ... } blob the
  // web scraper can read.
  let blob = null;
  if (session.session_data) {
    try {
      const decrypted = decrypt(session.session_data);
      blob = JSON.parse(decrypted);
    } catch (err) {
      const e = new Error(`Failed to decrypt session blob: ${err.message}`);
      e.statusCode = 500;
      throw e;
    }
  }
  if (!blob) {
    const e = new Error('Session has no decrypted blob');
    e.statusCode = 500;
    throw e;
  }

  let totalScraped = 0;
  for (const target of targets) {
    if (totalScraped >= limit) break;
    const targetUsername = String(target).replace(/^@/, '').toLowerCase();
    // Pass the full session row (not the bare blob) so the web scraper
    // routes the request through the per-session proxy + browser-grade
    // headers via igFetch.
    const profile = await webScraper.getUserIdByUsername(session, targetUsername);

    let received = 0;
    const buffer = [];
    for await (const u of webScraper.paginateFriendList(session, profile.pk, job.target_type, {
      limit: limit - totalScraped,
      pageSize: 50,
      targetUsername,
    })) {
      buffer.push(u);
      received += 1;
      if (buffer.length >= 25) {
        const inserted = await _insertUsersBatch(jobId, buffer.splice(0, buffer.length));
        totalScraped += inserted;
        await _setStatus(jobId, 'running', { total_found: totalScraped });
      }
      if (totalScraped + buffer.length >= limit) break;
    }
    if (buffer.length) {
      const inserted = await _insertUsersBatch(jobId, buffer);
      totalScraped += inserted;
      await _setStatus(jobId, 'running', { total_found: totalScraped });
    }
    logger.info(`IG.webScrape job ${jobId}: target=${targetUsername} kind=${job.target_type} fetched=${received} inserted_total=${totalScraped}`);
  }
  return totalScraped;
}

/**
 * Mobile-API session path (instagram-private-api). Used when the
 * session was created by the panel's own login flow, not via cookie
 * upload.
 */
async function _runMobileScrape({ jobId, job, session, targets, limit }) {
  const client = await igClient.getClient(session);
  const pageSize = Math.min(limit, await _getPageSize(job.target_type, 200));
  let totalScraped = 0;

  for (const target of targets) {
    if (totalScraped >= limit) break;

    const targetUsername = String(target).replace(/^@/, '').toLowerCase();
    const targetUserId = await client.user.getIdByUsername(targetUsername);

    const feed = job.target_type === 'followers'
      ? client.feed.accountFollowers(targetUserId)
      : job.target_type === 'following'
        ? client.feed.accountFollowing(targetUserId)
        : null;

    if (!feed) {
      await _setStatus(jobId, 'failed', { error: `Target type ${job.target_type} not yet implemented for IG` });
      return totalScraped;
    }

    let receivedFromTarget = 0;
    let firstPage = true;
    do {
      if (!firstPage) {
        // Jittered backoff between feed pages to avoid IG's spam guard.
        // Empirically 1.5-3s keeps a single session under the per-account
        // throttle for followers/following endpoints.
        await _jitterSleep(1500, 3000);
      }
      firstPage = false;
      const items = await feed.items();
      const slice = items.slice(0, Math.max(0, limit - totalScraped));
      const inserted = await _insertUsersBatch(jobId, slice);
      totalScraped += inserted;
      receivedFromTarget += slice.length;
      await _setStatus(jobId, 'running', { total_found: totalScraped });
      if (totalScraped >= limit) break;
    } while (feed.isMoreAvailable() && receivedFromTarget < pageSize * 10);
  }
  return totalScraped;
}

async function listJobs(userId, opts = {}) {
  const { page = 1, limit = 20, sort = 'created_at', order = 'DESC', filter = {} } = opts;
  const allowedSort = new Set(['id', 'created_at', 'completed_at', 'status']);
  const sortCol = allowedSort.has(sort) ? sort : 'created_at';
  const sortDir = order && order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const where = ['user_id = $1', "platform = 'instagram'"];
  const params = [userId];
  let p = 2;
  if (filter.status) { where.push(`status = $${p++}`); params.push(filter.status); }
  if (filter.target_type) { where.push(`target_type = $${p++}`); params.push(filter.target_type); }

  const offset = Math.max(0, (page - 1) * limit);
  params.push(limit, offset);
  const rows = await pool.query(
    `SELECT * FROM scraping_jobs
      WHERE ${where.join(' AND ')}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${p++} OFFSET $${p++}`,
    params
  );
  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scraping_jobs WHERE ${where.join(' AND ')}`,
    params.slice(0, params.length - 2)
  );
  return { jobs: rows.rows, total: count.rows[0].n, page, limit };
}

async function getJob(jobId, userId) {
  const r = await pool.query(
    `SELECT * FROM scraping_jobs
      WHERE id = $1 AND user_id = $2 AND platform = 'instagram'`,
    [jobId, userId]
  );
  return r.rows[0] || null;
}

async function getStats(userId) {
  const r = await pool.query(
    `SELECT
        COUNT(*)::int AS total_jobs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int AS completed_jobs,
        SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END)::int AS failed_jobs,
        SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END)::int AS active_jobs,
        COALESCE(SUM(total_found), 0)::int AS total_users_scraped
       FROM scraping_jobs
      WHERE user_id = $1 AND platform = 'instagram'`,
    [userId]
  );
  const byType = await pool.query(
    `SELECT target_type, COUNT(*)::int AS count
       FROM scraping_jobs
      WHERE user_id = $1 AND platform = 'instagram'
      GROUP BY target_type`,
    [userId]
  );
  const stats = r.rows[0] || {};
  stats.by_target_type = {};
  for (const row of byType.rows) {
    stats.by_target_type[row.target_type] = row.count;
  }
  return stats;
}

async function getProgress(jobId, userId) {
  const job = await getJob(jobId, userId);
  if (!job) {
    const e = new Error('Job not found');
    e.statusCode = 404;
    throw e;
  }
  const limit = Number(job.options?.limit || 1000);
  const totalFound = job.total_found || 0;
  return {
    jobId: job.id,
    status: job.status,
    totalFound,
    limit,
    progress: job.progress != null ? Number(job.progress) : (
      limit > 0 ? Math.min(100, Math.floor((totalFound / limit) * 100)) : 0
    ),
    error: job.error_message || null,
    startedAt: job.created_at,
    completedAt: job.completed_at,
  };
}

async function cancelJob(jobId, userId) {
  const job = await getJob(jobId, userId);
  if (!job) {
    const e = new Error('Job not found');
    e.statusCode = 404;
    throw e;
  }
  if (['completed', 'failed', 'cancelled'].includes(job.status)) {
    return { id: job.id, status: job.status };
  }
  await _setStatus(jobId, 'cancelled');
  return { id: jobId, status: 'cancelled' };
}

module.exports = {
  PLATFORM,
  VALID_TARGET_TYPES,
  startMembersScrape: createScrapeJob,
  startMessagesScrape: () => { throw new Error('Recent messages scrape is TG-only'); },
  createScrapeJob,
  createJob: createScrapeJob,
  _executeScrapeJob,
  listJobs,
  list: listJobs,
  get: getJob,
  getJob,
  cancelJob,
  cancel: cancelJob,
  getStats,
  stats: getStats,
  getProgress,
};
