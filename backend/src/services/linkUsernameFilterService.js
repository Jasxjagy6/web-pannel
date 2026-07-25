'use strict';

/**
 * Link-based username filter — sessionless, accuracy-first.
 *
 * Checks the PUBLIC web preview at https://t.me/<username>. Telegram renders a
 * distinct HTML page for a real public username vs a free/invalid one:
 *
 *   VALID    -> the page has a `tgme_page_title` block (the profile scaffold).
 *   INVALID  -> og:title is "Telegram: Contact @<username>" with no page-title
 *               block (the "this username is available" shell).
 *   GENERIC  -> reserved / too-short names render the plain landing page.
 *
 * THROTTLE REALITY (measured against the live 24k list from this VPS):
 *   Telegram throttles by IP over a sliding request-budget. When you exceed it,
 *   t.me serves a STRIPPED page in which a *valid* user is INDISTINGUISHABLE
 *   from an invalid one (same "Telegram: Contact @user" title, no page-title).
 *   There is no HTML marker that separates "throttled valid" from "really
 *   invalid". The only correct strategy is therefore:
 *
 *     1. Pace requests (bounded concurrency + inter-request delay) to stay
 *        under the budget so the throttle never trips in the first place.
 *     2. Detect a throttle event (a long run of consecutive "not found" on a
 *        list that isn't actually all-invalid) and PAUSE to let the budget
 *        refill (circuit breaker).
 *     3. Re-verify every "not found" username in additional passes with a
 *        cooldown between passes. A genuinely-valid user that only looked
 *        invalid because of a transient throttle RECOVERS on a later pass; a
 *        genuinely-free username stays "not found" across all passes.
 *
 * This trades speed for correctness (a 24k list may take several minutes) but
 * yields a valid set that matches the authoritative session-resolve result.
 * No Telegram sessions are used.
 */

const { request, ProxyAgent } = require('undici');
const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');
const logger = require('../utils/logger');
const { __internal: uv } = require('./usernameValidationService');
const { getFreeProxies } = require('./freeProxyService');

const normalizeUsernameCandidate = uv.normalizeUsernameCandidate;

const MAX_ITEMS = Math.max(1, parseInt(process.env.LINK_FILTER_MAX_ITEMS || '100000', 10));
// Deliberately conservative: measured steady-state safe rate is ~20-40 req/s
// from a single IP. concurrency*(1000/gap) approximates requests/sec.
const CONCURRENCY = Math.max(1, Math.min(64, parseInt(process.env.LINK_FILTER_CONCURRENCY || '10', 10)));
const REQUEST_GAP_MS = Math.max(0, parseInt(process.env.LINK_FILTER_GAP_MS || '110', 10));
const REQ_TIMEOUT_MS = Math.max(1000, parseInt(process.env.LINK_FILTER_TIMEOUT_MS || '8000', 10));
const HTTP_RETRIES = Math.max(0, parseInt(process.env.LINK_FILTER_RETRIES || '2', 10));
// Multi-pass re-verification of the not-found set.
const MAX_PASSES = Math.max(1, parseInt(process.env.LINK_FILTER_MAX_PASSES || '6', 10));
// Number of free proxies to fetch per job (0 = VPS IP only)
const PROXY_COUNT = Math.max(0, parseInt(process.env.LINK_FILTER_PROXY_COUNT || '3', 10));
const PASS_COOLDOWN_MS = Math.max(0, parseInt(process.env.LINK_FILTER_PASS_COOLDOWN_MS || '20000', 10));
// Circuit breaker: N consecutive not-found in a single pass is treated as a
// throttle event -> pause to let the IP budget refill, then continue. Set high
// enough that a genuinely invalid-heavy stretch of a real list doesn't keep
// tripping it (measured: valid users cluster, but invalid runs of 30-60 are
// normal on scraped lists).
const BREAKER_CONSEC = Math.max(10, parseInt(process.env.LINK_FILTER_BREAKER_CONSEC || '120', 10));
const BREAKER_PAUSE_MS = Math.max(1000, parseInt(process.env.LINK_FILTER_BREAKER_PAUSE_MS || '20000', 10));
// Hard wall-clock guard so a job can't run forever.
const MAX_TOTAL_MS = Math.max(60000, parseInt(process.env.LINK_FILTER_MAX_TOTAL_MS || '1500000', 10)); // 25 min
const TICK_MS = Math.max(1000, parseInt(process.env.LINK_FILTER_JOB_TICK_MS || '3000', 10));
const STALE_JOB_MINUTES = Math.max(2, parseInt(process.env.LINK_FILTER_STALE_JOB_MINUTES || '30', 10));

const USER_AGENT =
  process.env.LINK_FILTER_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let workerTimer = null;
let workerRunning = false;

function extractMeta(html, prop) {
  const re = new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
  const m = html.match(re);
  if (m) return m[1];
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:${prop}["']`, 'i');
  const m2 = html.match(re2);
  return m2 ? m2[1] : '';
}

function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Classify a t.me HTML body. Pure — unit tested.
 *
 * IMPORTANT: a throttled page for a VALID user looks exactly like an INVALID
 * page, so `valid:false` here means "not-found ON THIS FETCH" (could be either
 * genuinely free OR a transient throttle). The multi-pass driver disambiguates.
 *
 * @returns {{ valid:boolean, displayName:string|null, reason:string,
 *             kind:'user'|'not_found'|'generic' }}
 */
function classifyTmeHtml(html, username) {
  const body = String(html || '');
  const title = decodeEntities(extractMeta(body, 'title') || '').trim();
  const desc = decodeEntities(extractMeta(body, 'description') || '').trim();

  const contactMarker = /^Telegram:\s*Contact\s*@/i.test(title);
  const generic =
    /^Telegram\s*[–-]\s*a new era of messaging/i.test(title) ||
    title === 'Telegram' ||
    /^Telegram Messenger/i.test(title);
  const hasPageTitle = /tgme_page_title/.test(body);

  if (hasPageTitle && title && !contactMarker) {
    return { valid: true, displayName: title, description: desc || null, reason: 'RESOLVED', kind: 'user' };
  }
  if (generic && !hasPageTitle) {
    return { valid: false, displayName: null, reason: 'GENERIC_PAGE', kind: 'generic' };
  }
  // Contact shell OR stripped/throttled page — not resolvable on this fetch.
  return { valid: false, displayName: null, reason: 'NOT_FOUND', kind: 'not_found' };
}

async function fetchOne(username, dispatcher = null) {
  if (module.exports.__fetchOverride) {
    return module.exports.__fetchOverride(username);
  }
  const url = `https://t.me/${encodeURIComponent(username)}`;
  let lastErr = null;
  for (let attempt = 0; attempt <= HTTP_RETRIES; attempt++) {
    try {
      const opts = {
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
        maxRedirections: 2,
        bodyTimeout: REQ_TIMEOUT_MS,
        headersTimeout: REQ_TIMEOUT_MS,
      };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await request(url, opts);
      const body = await res.body.text();
      if (res.statusCode === 429 || res.statusCode >= 500) {
        lastErr = new Error(`HTTP ${res.statusCode}`);
        await sleep(300 * (attempt + 1));
        continue;
      }
      return { ok: true, ...classifyTmeHtml(body, username) };
    } catch (err) {
      lastErr = err;
      await sleep(200 * (attempt + 1));
    }
  }
  return { ok: false, valid: false, displayName: null, reason: 'CHECK_FAILED', kind: 'error', error: lastErr && lastErr.message };
}

/**
 * Run one paced pass over `usernames`. Bounded concurrency, per-request gap,
 * and a consecutive-miss circuit breaker that pauses on a suspected throttle.
 *
 * @returns {Promise<Map<string, {valid:boolean, displayName?:string}>>}
 *          Map keyed by username with the outcome of THIS pass.
 */
/**
 * Run one paced pass over `usernames`. Each worker is assigned a proxy
 * dispatcher from the pool in round-robin order. When a worker's
 * consecutive-miss breaker fires it rotates to the next dispatcher
 * (including null = VPS IP as the final fallback) and pauses before
 * continuing — spreading throttle pressure across multiple IPs.
 *
 * @param {string[]} usernames
 * @param {{ deadline, onTick, shouldStop, dispatchers? }} opts
 *   dispatchers: array of ProxyAgent instances (may be empty → VPS only)
 */
async function runPass(usernames, { deadline, onTick, shouldStop, dispatchers = [] }) {
  const outcome = new Map();
  let idx = 0;

  // Build dispatcher pool: proxies first, VPS IP (null) as last-resort fallback
  const dispPool = dispatchers.length > 0 ? [...dispatchers, null] : [null];

  const worker = async (workerIdx) => {
    // Each worker starts on a different proxy slot
    let slotIdx = workerIdx % dispPool.length;
    let consecutiveMiss = 0;
    let rotations = 0;

    while (idx < usernames.length) {
      if (Date.now() > deadline || shouldStop?.()) return;
      const u = usernames[idx++];
      const r = await fetchOne(u, dispPool[slotIdx]);
      outcome.set(u, r);

      if (r.valid) {
        consecutiveMiss = 0;
      } else if (r.kind === 'not_found') {
        consecutiveMiss++;
        if (consecutiveMiss >= BREAKER_CONSEC) {
          consecutiveMiss = 0;
          rotations++;
          // Rotate to next slot in pool
          slotIdx = (slotIdx + 1) % dispPool.length;
          const label = dispPool[slotIdx] ? `proxy[${slotIdx}]` : 'VPS-IP';
          logger.warn(
            `linkFilter: worker ${workerIdx} throttled (${BREAKER_CONSEC} misses) ` +
            `— rotating to ${label}, pausing ${BREAKER_PAUSE_MS}ms`
          );
          await sleep(BREAKER_PAUSE_MS);
        }
      }

      if (onTick) await onTick(u, r);
      if (REQUEST_GAP_MS > 0) await sleep(REQUEST_GAP_MS);
    }
  };

  const workerCount = Math.min(CONCURRENCY, usernames.length || 1);
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
  return { outcome };
}

/**
 * Multi-pass driver: check all usernames, then re-verify the not-found set in
 * additional passes (with a cooldown between) until it stops shrinking or the
 * pass/time budget is exhausted. Returns the final valid map + stats.
 */
async function resolveUsernames(candidates, {
  deadline,
  onPassStart,
  onPassComplete,
  onTick,
  shouldStop,
  dispatchers = [],
} = {}) {
  const validMap = new Map(); // username -> displayName|null
  let pending = candidates.map((c) => c.username);
  const displayByUser = new Map();
  let genericCount = 0;
  let erroredCount = 0;
  let passes = 0;
  let totalRequests = 0;

  for (let pass = 0; pass < MAX_PASSES && pending.length > 0; pass++) {
    if (Date.now() > deadline || shouldStop?.()) break;
    passes++;
    if (pass > 0) {
      logger.info(`linkFilter: pass ${pass + 1}/${MAX_PASSES} re-checking ${pending.length} not-found`);
      await sleep(Math.min(PASS_COOLDOWN_MS, Math.max(0, deadline - Date.now())));
      if (Date.now() > deadline || shouldStop?.()) break;
    }

    if (onPassStart) await onPassStart({ pass: pass + 1, total: pending.length });

    const { outcome } = await runPass(pending, {
      deadline,
      shouldStop,
      dispatchers,
      onTick: async (username, result) => {
        totalRequests++;
        if (onTick) await onTick({ pass: pass + 1, username, result, totalRequests });
      },
    });

    const stillPending = [];
    for (const u of pending) {
      const r = outcome.get(u);
      if (!r) { stillPending.push(u); continue; } // deadline cut this pass short
      if (r.valid) {
        validMap.set(u, r.displayName || null);
        if (r.displayName) displayByUser.set(u, r.displayName);
      } else if (r.kind === 'generic') {
        genericCount++; // stable invalid — don't re-check
      } else if (r.kind === 'error') {
        stillPending.push(u); // retry network errors next pass
      } else {
        stillPending.push(u); // not_found — could be throttle; re-check
      }
    }

    const converged = pass > 0 && stillPending.length === pending.length;
    if (onPassComplete) {
      await onPassComplete({
        pass: pass + 1,
        outcome,
        checked: outcome.size,
        pendingBefore: pending.length,
        stillPending,
        converged,
        totalRequests,
      });
    }

    // Stop early if a re-check pass recovered nothing new (converged).
    if (converged) {
      pending = stillPending;
      break;
    }
    pending = stillPending;
  }

  // Anything still pending after the final pass is treated as invalid
  // (genuinely free), minus persistent network errors which we surface.
  const invalidCount = pending.length;
  return {
    validMap,
    displayByUser,
    genericCount,
    erroredCount,
    invalidCount,
    passes,
    totalRequests,
    unresolved: pending,
    stopped: !!shouldStop?.(),
    timedOut: Date.now() > deadline,
  };
}

async function loadSource({ userId, sourceListId, resultListName }) {
  const sourceId = Number(sourceListId);
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new AppError('A valid sourceListId is required', 400, 'INVALID_SOURCE_LIST_ID');
  }

  const { rows: sourceRows } = await pool.query(
    `SELECT id, name, type, platform FROM lists
      WHERE id = $1 AND user_id = $2 AND platform = 'telegram'`,
    [sourceId, userId]
  );
  const source = sourceRows[0];
  if (!source) throw new AppError('Source user list not found', 404, 'SOURCE_LIST_NOT_FOUND');
  if (source.type === 'profile') {
    throw new AppError('Profile lists cannot be link-filtered', 400, 'INVALID_SOURCE_LIST_TYPE');
  }

  const { rows: sourceItems } = await pool.query(
    `SELECT id, username FROM list_items WHERE list_id = $1 ORDER BY id ASC`,
    [sourceId]
  );
  if (sourceItems.length > MAX_ITEMS) {
    throw new AppError(
      `Link filter supports at most ${MAX_ITEMS} source rows per run`,
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
    if (!parsed) { ignoredCount++; continue; }
    if (seen.has(parsed.normalized)) { duplicateCount++; continue; }
    seen.add(parsed.normalized);
    candidates.push({ sourceItemId: Number(item.id), ...parsed });
  }
  if (candidates.length === 0) {
    throw new AppError('The source list contains no usable usernames', 400, 'NO_USERNAMES');
  }

  const requestedName = String(resultListName || '').trim();
  const outputName = (requestedName || `${source.name} - Valid Usernames (Link)`).slice(0, 255);
  return { sourceId, source, sourceItems, candidates, ignoredCount, duplicateCount, outputName };
}

async function startJob({ userId, sourceListId, resultListName }) {
  const prepared = await loadSource({ userId, sourceListId, resultListName });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultList = await client.query(
      `INSERT INTO lists (user_id, name, type, items_count, source, platform, created_at)
       VALUES ($1, $2, 'users', 0, 'link_filter', 'telegram', NOW())
       RETURNING id, name`,
      [userId, prepared.outputName]
    );
    const jobResult = await client.query(
      `INSERT INTO username_validation_jobs (
         user_id, source_list_id, result_list_id,
         source_list_name, session_list_name, result_list_name,
         source_items_count, total_count, ignored_count, duplicate_count,
         validation_method, max_passes, status, created_at
       ) VALUES ($1,$2,$3,$4,'No sessions (public t.me)',$5,$6,$7,$8,$9,'link',$10,'pending',NOW())
       RETURNING *`,
      [
        userId,
        prepared.sourceId,
        resultList.rows[0].id,
        prepared.source.name,
        resultList.rows[0].name,
        prepared.sourceItems.length,
        prepared.candidates.length,
        prepared.ignoredCount,
        prepared.duplicateCount,
        MAX_PASSES,
      ]
    );
    const job = jobResult.rows[0];

    for (let offset = 0; offset < prepared.candidates.length; offset += 1000) {
      const batch = prepared.candidates.slice(offset, offset + 1000);
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
    return require('./usernameValidationService').__internal.terminalJobView(job);
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

async function claimNextJob() {
  const { rows } = await pool.query(
    `WITH next AS (
       SELECT id FROM username_validation_jobs
        WHERE validation_method = 'link' AND status = 'pending' AND cancel_requested = FALSE
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE username_validation_jobs job
        SET status = 'running', started_at = COALESCE(started_at, NOW()),
            last_progress_at = NOW(), error_message = NULL
       FROM next
      WHERE job.id = next.id
      RETURNING job.*`
  );
  return rows[0] || null;
}

async function persistPassResults(job, outcome, final = false) {
  const valid = [];
  const invalid = [];
  for (const [username, result] of outcome.entries()) {
    if (result.valid) valid.push({ username, displayName: result.displayName || null });
    else if (result.kind === 'generic' || final) invalid.push({ username, code: result.reason || 'NOT_FOUND' });
  }
  if (valid.length === 0 && invalid.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (valid.length > 0) {
      await client.query(
        `INSERT INTO list_items (list_id, username, first_name, platform, added_at)
         SELECT $1, input.username, input.display_name, 'telegram', NOW()
           FROM UNNEST($2::text[], $3::text[]) AS input(username, display_name)`,
        [job.result_list_id, valid.map((item) => item.username), valid.map((item) => item.displayName)]
      );
      await client.query(
        `UPDATE username_validation_items item
            SET status = 'valid', resolved_username = input.username,
                resolved_first_name = input.display_name, attempts = attempts + 1,
                error_code = NULL, error_message = NULL, finished_at = NOW()
           FROM UNNEST($2::text[], $3::text[]) AS input(username, display_name)
          WHERE item.job_id = $1 AND item.username = input.username AND item.status = 'pending'`,
        [job.id, valid.map((item) => item.username), valid.map((item) => item.displayName)]
      );
    }
    if (invalid.length > 0) {
      await client.query(
        `UPDATE username_validation_items item
            SET status = 'invalid', attempts = attempts + 1,
                error_code = input.code, finished_at = NOW()
           FROM UNNEST($2::text[], $3::text[]) AS input(username, code)
          WHERE item.job_id = $1 AND item.username = input.username AND item.status = 'pending'`,
        [job.id, invalid.map((item) => item.username), invalid.map((item) => item.code)]
      );
    }
    await client.query(
      `UPDATE lists
          SET items_count = (SELECT COUNT(*) FROM list_items WHERE list_id = $1)
        WHERE id = $1`,
      [job.result_list_id]
    );
    await client.query(
      `UPDATE username_validation_jobs
          SET processed_count = counts.valid_count + counts.invalid_count + counts.failed_count,
              valid_count = counts.valid_count,
              invalid_count = counts.invalid_count,
              failed_count = counts.failed_count,
              last_progress_at = NOW()
         FROM (
           SELECT COUNT(*) FILTER (WHERE status = 'valid')::int AS valid_count,
                  COUNT(*) FILTER (WHERE status = 'invalid')::int AS invalid_count,
                  COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count
             FROM username_validation_items WHERE job_id = $1
         ) counts
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

async function finishRemaining(jobId, status, code, message, extra = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE username_validation_items
          SET status = 'skipped', error_code = $2, error_message = $3, finished_at = NOW()
        WHERE job_id = $1 AND status = 'pending'`,
      [jobId, code, message]
    );
    await client.query(
      `UPDATE username_validation_jobs job
          SET status = $2,
              skipped_count = counts.skipped_count,
              processed_count = counts.processed_count,
              valid_count = counts.valid_count,
              invalid_count = counts.invalid_count,
              current_username = NULL,
              pass_processed_count = CASE WHEN $3::boolean THEN pass_processed_count ELSE pass_total_count END,
              timed_out = $3,
              error_message = $4,
              finished_at = NOW(), last_progress_at = NOW()
         FROM (
           SELECT COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped_count,
                  COUNT(*) FILTER (WHERE status IN ('valid','invalid','failed'))::int AS processed_count,
                  COUNT(*) FILTER (WHERE status = 'valid')::int AS valid_count,
                  COUNT(*) FILTER (WHERE status = 'invalid')::int AS invalid_count
             FROM username_validation_items WHERE job_id = $1
         ) counts
        WHERE job.id = $1`,
      [jobId, status, !!extra.timedOut, message || null]
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
  const startedAt = Date.now();
  const deadline = startedAt + MAX_TOTAL_MS;
  let cancelled = false;
  let ticksSinceCancelCheck = 0;
  let lastProgressWrite = 0;
  let passProcessed = 0;
  const requestBase = Number(job.total_requests || 0);

  const { rows } = await pool.query(
    `SELECT username, normalized_username FROM username_validation_items
      WHERE job_id = $1 AND status = 'pending' ORDER BY id ASC`,
    [job.id]
  );
  const candidates = rows.map((row) => ({ username: row.username, normalized: row.normalized_username }));
  if (candidates.length === 0) {
    await finishRemaining(job.id, 'completed', null, null);
    return;
  }

  // Fetch free proxies for this job (fall back to VPS-only if none found)
  let dispatchers = [];
  if (PROXY_COUNT > 0) {
    try {
      const proxyUrls = await getFreeProxies(PROXY_COUNT);
      dispatchers = proxyUrls.map((url) => {
        try { return new ProxyAgent(url); } catch { return null; }
      }).filter(Boolean);
      if (dispatchers.length > 0) {
        logger.info(`linkFilter: job=${job.id} using ${dispatchers.length} proxy dispatchers + VPS fallback`);
      } else {
        logger.warn(`linkFilter: job=${job.id} no working proxies found — using VPS IP only`);
      }
    } catch (err) {
      logger.warn(`linkFilter: job=${job.id} proxy fetch failed (${err.message}) — using VPS IP only`);
    }
  }

  logger.info(`linkFilter: starting job=${job.id} user=${job.user_id} source=${job.source_list_id} unique=${candidates.length}`);
  try {
    const resolved = await resolveUsernames(candidates, {
      deadline,
      shouldStop: () => cancelled,
      dispatchers,
      onPassStart: async ({ pass, total }) => {
        passProcessed = 0;
        await pool.query(
          `UPDATE username_validation_jobs
              SET current_pass = $2, pass_processed_count = 0, pass_total_count = $3,
                  current_username = NULL, last_progress_at = NOW()
            WHERE id = $1`,
          [job.id, pass, total]
        );
      },
      onTick: async ({ username, totalRequests }) => {
        passProcessed++;
        ticksSinceCancelCheck++;
        const now = Date.now();
        if (ticksSinceCancelCheck >= 20) {
          ticksSinceCancelCheck = 0;
          const cancelResult = await pool.query(
            'SELECT cancel_requested FROM username_validation_jobs WHERE id = $1',
            [job.id]
          );
          cancelled = !!cancelResult.rows[0]?.cancel_requested;
        }
        if (now - lastProgressWrite >= 500 || cancelled) {
          lastProgressWrite = now;
          await pool.query(
            `UPDATE username_validation_jobs
                SET pass_processed_count = GREATEST(pass_processed_count, $2),
                    total_requests = GREATEST(total_requests, $3),
                    current_username = $4, last_progress_at = NOW()
              WHERE id = $1`,
            [job.id, passProcessed, requestBase + totalRequests, username]
          );
        }
      },
      onPassComplete: async ({ outcome, checked, totalRequests }) => {
        await persistPassResults(job, outcome, false);
        await pool.query(
          `UPDATE username_validation_jobs
              SET pass_processed_count = GREATEST(pass_processed_count, $2),
                  total_requests = GREATEST(total_requests, $3),
                  current_username = NULL, last_progress_at = NOW()
            WHERE id = $1`,
          [job.id, checked, requestBase + totalRequests]
        );
      },
    });

    if (cancelled) {
      await finishRemaining(job.id, 'cancelled', 'CANCELLED', 'Job cancelled by operator');
      return;
    }

    if (resolved.timedOut) {
      await finishRemaining(
        job.id,
        'completed',
        'TIME_BUDGET_EXCEEDED',
        'Stopped at the link-check time budget; confirmed valid results were preserved',
        { timedOut: true }
      );
      return;
    }

    if (resolved.unresolved.length > 0) {
      const finalOutcome = new Map(
        resolved.unresolved.map((username) => [username, {
          valid: false,
          kind: 'not_found',
          reason: 'NOT_FOUND_AFTER_RECHECKS',
        }])
      );
      await persistPassResults(job, finalOutcome, true);
    }
    await finishRemaining(job.id, 'completed', null, null);
    logger.info(`linkFilter: completed job=${job.id} requests=${resolved.totalRequests} passes=${resolved.passes}`);
  } catch (error) {
    logger.error(`linkFilter: job ${job.id} failed`, { error: error.message });
    await finishRemaining(job.id, 'failed', 'JOB_FAILED', error.message || String(error)).catch(() => {});
  } finally {
    // Clean up proxy dispatcher connections
    for (const d of dispatchers) {
      d.close().catch(() => {});
    }
  }
}

async function runSweepOnce() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const job = await claimNextJob();
    if (job) await processJob(job);
  } finally {
    workerRunning = false;
  }
}

async function recoverOrphanedJobs() {
  const staleInterval = `${STALE_JOB_MINUTES} minutes`;
  const { rows: cancelled } = await pool.query(
    `SELECT id FROM username_validation_jobs
      WHERE validation_method = 'link' AND status = 'running' AND cancel_requested = TRUE
        AND COALESCE(last_progress_at, started_at, created_at) < NOW() - $1::interval`,
    [staleInterval]
  );
  await pool.query(
    `UPDATE username_validation_jobs
        SET status = 'pending',
            current_username = NULL, current_pass = 0,
            pass_processed_count = 0, pass_total_count = 0,
            started_at = NULL, finished_at = NULL,
            last_progress_at = NOW()
      WHERE validation_method = 'link' AND status = 'running' AND cancel_requested = FALSE
        AND COALESCE(last_progress_at, started_at, created_at) < NOW() - $1::interval`,
    [staleInterval]
  );
  for (const row of cancelled) {
    await finishRemaining(row.id, 'cancelled', 'CANCELLED', 'Job cancelled by operator');
  }
}

function startWorker() {
  if (workerTimer) return;
  const tick = () => recoverOrphanedJobs()
    .then(() => runSweepOnce())
    .catch((error) => logger.error('linkFilter worker tick failed', { error: error.message }));
  tick();
  workerTimer = setInterval(tick, TICK_MS);
  workerTimer.unref?.();
  logger.info(`linkFilter worker started (tick=${TICK_MS}ms, maxPasses=${MAX_PASSES})`);
}

function stopWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

async function runLinkFilter({ userId, sourceListId, resultListName }) {
  const prepared = await loadSource({ userId, sourceListId, resultListName });
  const { sourceId, source, sourceItems, candidates, ignoredCount, duplicateCount, outputName } = prepared;

  const startedAt = Date.now();
  const deadline = startedAt + MAX_TOTAL_MS;
  logger.info(
    `linkFilter: starting user=${userId} source=${sourceId} unique=${candidates.length} ` +
    `conc=${CONCURRENCY} gap=${REQUEST_GAP_MS}ms passes<=${MAX_PASSES}`
  );

  const resolved = await resolveUsernames(candidates, { deadline });

  const validUsers = candidates.filter((c) => resolved.validMap.has(c.username));

  const client = await pool.connect();
  let resultListId = null;
  try {
    await client.query('BEGIN');
    const listRes = await client.query(
      `INSERT INTO lists (user_id, name, type, items_count, source, platform, created_at)
       VALUES ($1, $2, 'users', 0, 'link_filter', 'telegram', NOW())
       RETURNING id`,
      [userId, outputName]
    );
    resultListId = Number(listRes.rows[0].id);

    for (let offset = 0; offset < validUsers.length; offset += 1000) {
      const batch = validUsers.slice(offset, offset + 1000);
      await client.query(
        `INSERT INTO list_items (list_id, username, first_name, platform, added_at)
         SELECT $1, u, f, 'telegram', NOW()
           FROM UNNEST($2::text[], $3::text[]) AS input(u, f)`,
        [
          resultListId,
          batch.map((b) => b.username.slice(0, 100)),
          batch.map((b) => {
            const dn = resolved.displayByUser.get(b.username);
            return dn ? String(dn).slice(0, 100) : null;
          }),
        ]
      );
    }
    await client.query('UPDATE lists SET items_count = $2 WHERE id = $1', [resultListId, validUsers.length]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const elapsedMs = Date.now() - startedAt;
  const timedOut = Date.now() > deadline;
  logger.info(
    `linkFilter: done user=${userId} source=${sourceId} valid=${validUsers.length} ` +
    `invalid=${resolved.invalidCount} generic=${resolved.genericCount} passes=${resolved.passes} ` +
    `reqs=${resolved.totalRequests} in ${elapsedMs}ms${timedOut ? ' (hit time budget)' : ''} -> list ${resultListId}`
  );

  return {
    sourceListId: sourceId,
    sourceListName: source.name,
    resultListId,
    resultListName: outputName,
    sourceItemsCount: sourceItems.length,
    totalChecked: candidates.length,
    validCount: validUsers.length,
    invalidCount: resolved.invalidCount + resolved.genericCount,
    ignoredCount,
    duplicateCount,
    passes: resolved.passes,
    totalRequests: resolved.totalRequests,
    timedOut,
    elapsedMs,
    sample: validUsers.slice(0, 20).map((v) => ({
      username: v.username,
      displayName: resolved.displayByUser.get(v.username) || null,
    })),
  };
}

module.exports = {
  startJob,
  startWorker,
  stopWorker,
  runSweepOnce,
  _processJob: processJob,
  runLinkFilter,
  __internal: {
    classifyTmeHtml,
    extractMeta,
    decodeEntities,
    runPass,
    resolveUsernames,
  },
};
