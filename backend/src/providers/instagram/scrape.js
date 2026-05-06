/**
 * Instagram scrape subsystem (provider.scrape.*).
 *
 * Targets (target_type column):
 *   - followers   → username's followers      (target_ids: [username])
 *   - following   → username's following      (target_ids: [username])
 *   - likers      → media's likers            (target_ids: [shortcode|url|pk])
 *   - commenters  → media's commenters        (target_ids: [shortcode|url|pk])
 *   - tagged      → posts tagging a user      (target_ids: [username])
 *
 * All five target types are routed through the cookie-based web
 * scraper (`webScraper.js` → `igFetch`) when the session was
 * uploaded as browser cookies (api_mode='web'). Followers/following
 * additionally have a mobile-API fallback for sessions created via
 * the panel's interactive login flow (api_mode='mobile').
 *
 * Persistence — uses the existing scraping_jobs / scraped_users tables
 * (now platform-aware via the v9 migration). Schema is shared with
 * Telegram; IG-specific columns include scraped_users.instagram_pk /
 * full_name / is_private / is_verified / thumbnail_url.
 */

const { pool } = require('../../config/database');
const logger = require('../../utils/logger');
const igClient = require('./client');
const sessionLimiter = require('./sessionLimiter');
const coldStart = require('./coldStart');
const activeHours = require('./activeHours');
const riskScore = require('./riskScore');
const systemSettings = require('../../services/systemSettingsService');
const webScraper = require('./webScraper');
const scrapeQuota = require('./scrapeQuota');
const { decrypt } = require('../../utils/crypto');

const PLATFORM = 'instagram';

const VALID_TARGET_TYPES = ['followers', 'following', 'likers', 'commenters', 'tagged'];

// Target types that take a media reference (shortcode/url/pk) instead
// of a username. Anything not in this set is treated as a username.
const _MEDIA_TARGET_TYPES = new Set(['likers', 'commenters']);

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
  // Errors thrown by igFetch already carry .kind / .statusCode — pass
  // them through unchanged so the per-target loop can decide whether
  // to retry, pivot to another session, or hard-fail.
  if (err.kind && err.statusCode) {
    return { statusCode: err.statusCode, message: err.message || String(err), kind: err.kind };
  }
  const ctor = err.constructor && err.constructor.name;
  const msg = err.message || String(err);
  // Authentication / session expiry
  if (ctor === 'IgLoginRequiredError' || /login_required/i.test(msg)) {
    return { statusCode: 401, message: 'Instagram session is no longer logged in. Re-upload a fresh session.', kind: 'login_required' };
  }
  if (ctor === 'IgCheckpointError' || /checkpoint_required/i.test(msg)) {
    return { statusCode: 401, message: 'Instagram is blocking this session with a checkpoint. Solve the checkpoint on a trusted device, then re-upload.', kind: 'checkpoint' };
  }
  // Rate limit / spam guard
  if (
    ctor === 'IgActionSpamError' ||
    /please wait a few minutes|action_blocked|too many requests|rate.?limit/i.test(msg)
  ) {
    return { statusCode: 429, message: 'Instagram is rate-limiting this session. Slow down and try again in a few minutes.', kind: 'rate_limited' };
  }
  // User-not-found / target issues
  if (ctor === 'IgUserHasNoFeedError' || /user not found|no feed/i.test(msg)) {
    return { statusCode: 404, message: 'Target Instagram user has no public feed.', kind: 'not_found' };
  }
  if (/getIdByUsername.*not found|not_found|user_not_found/i.test(msg)) {
    return { statusCode: 404, message: 'Target Instagram username not found.', kind: 'not_found' };
  }
  if (/private/i.test(msg) && /account|user/i.test(msg)) {
    return { statusCode: 403, message: 'Target account is private — you must follow it from the session account first.', kind: 'forbidden' };
  }
  return { statusCode: 502, message: msg, kind: 'network' };
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
  // Per-row column count must match the column list in the INSERT and
  // the value-pushes inside the loop. v19 widened the row from 7 IG
  // payload fields to 16 so we capture as much as IG's friend-list
  // and likers responses give us without extra HTTP round-trips.
  const COLS_PER_ROW = 17;
  const placeholders = [];
  const values = [];
  let p = 1;
  for (const r of rows) {
    const pks = [];
    for (let i = 0; i < COLS_PER_ROW; i += 1) pks.push(`$${p++}`);
    placeholders.push(`(${pks.join(', ')}, NOW())`);
    values.push(
      jobId,                                                                 // job_id
      r.username || null,                                                    // username
      r.pk ? Number(r.pk) : null,                                            // instagram_pk
      r.full_name || null,                                                   // full_name
      r.is_private == null ? null : !!r.is_private,                          // is_private
      r.is_verified == null ? null : !!r.is_verified,                        // is_verified
      r.profile_pic_url || null,                                             // thumbnail_url
      r.profile_pic_id ? String(r.profile_pic_id) : null,                    // profile_pic_id
      r.has_anonymous_profile_picture == null ? null : !!r.has_anonymous_profile_picture, // has_anonymous_profile_picture
      r.is_business == null ? null : !!r.is_business,                        // is_business
      r.account_type == null ? null : Number(r.account_type),                // account_type
      r.latest_reel_media == null ? null : Number(r.latest_reel_media),      // latest_reel_media
      r.has_chaining == null ? null : !!r.has_chaining,                      // has_chaining
      r.social_context || null,                                              // social_context
      r.biography || r.bio || null,                                          // bio (rare on list endpoints, but free if present)
      r.profile_pic_url ? true : (r.has_anonymous_profile_picture === false), // has_profile_photo
      'instagram',                                                           // platform
    );
  }
  await pool.query(
    `INSERT INTO scraped_users
       (job_id, username, instagram_pk, full_name, is_private, is_verified,
        thumbnail_url, profile_pic_id, has_anonymous_profile_picture,
        is_business, account_type, latest_reel_media, has_chaining,
        social_context, bio, has_profile_photo, platform, scraped_at)
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

  // Phase 3.B16 — refuse to enqueue scrape jobs against any session
  // whose risk score exceeds the deny threshold. Filter the requested
  // sessions down to "safe" rows; if none remain, throw 403 so the
  // operator gets a clear error in the UI.
  const safeSessionRows = [];
  const blockedSessions = [];
  for (const row of r.rows) {
    try {
      await riskScore.gateOnRisk({ id: row.id });
      safeSessionRows.push(row);
    } catch (gateErr) {
      if (gateErr && gateErr.code === 'RISK_TOO_HIGH') {
        blockedSessions.push({ id: row.id, username: row.username, error: gateErr.message });
        logger.warn(`IG.scrape: refused session ${row.id} (${row.username}) — ${gateErr.message}`);
        continue;
      }
      throw gateErr;
    }
  }
  if (safeSessionRows.length === 0) {
    const e = new Error(
      `All requested Instagram sessions are above the risk-score deny threshold. ` +
      `Resolve checkpoints / feedback errors and retry, or override via ` +
      `risk.instagram.deny_threshold. Blocked: ${blockedSessions.map((b) => `#${b.id}`).join(', ')}`
    );
    e.statusCode = 403;
    e.code = 'RISK_TOO_HIGH';
    e.details = { blocked: blockedSessions };
    throw e;
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
      safeSessionRows[0].id,
      safeSessionRows.map((x) => x.id),
      targetType,
      targets[0] || null,
      targets,
      JSON.stringify({ limit, ...options, _blocked_sessions: blockedSessions }),
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
  // Per-job proxy override. Default true (use the bound proxy);
  // when the operator unticked "Use proxy" on the form the job
  // runs from the panel IP. We mark each session row clone with
  // _bypassProxy so igClient/igFetch skip the require_proxy gate
  // for this execution only.
  const bypassProxy = job.options?.use_proxy === false;

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
  if (bypassProxy) {
    for (const row of sessRows.rows) {
      row._bypassProxy = true;
    }
    logger.info(
      `IG.scrape job ${jobId}: proxy bypass enabled — running from panel IP ` +
      `(operator unticked "Use proxy" on the form).`
    );
  }
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

  // Active-hours window. Scrape jobs are operator-initiated (the
  // human clicked "Run scrape") so we DO NOT silently postpone the
  // job back to `pending` when the configured wake window has not
  // started yet — there's no scheduler to resume it later, so the job
  // would just hang forever which is exactly the "stuck on pending"
  // bug operators were reporting. We still log when the request
  // arrives outside-of-window so the active-hours info is visible in
  // ops logs, and the warm-up scheduler keeps honouring the window
  // for its own (autonomous) traffic.
  const allOutOfWindow = sessRows.rows.every((s) => !activeHours.gate(s).allowed);
  if (allOutOfWindow) {
    logger.info(
      `IG.scrape job ${jobId}: all sessions outside their active-hours window; ` +
      `executing anyway because the scrape was operator-initiated.`
    );
  }

  let totalScraped = 0;
  let lastSessionUsed = sessRows.rows[0];
  try {
    // Phase 1.B8 — cold-start simulation. First job after a process
    // restart runs a small natural-feeling sequence of feed/inbox
    // reads before the real work begins, so IG sees the session
    // "open the app" first.
    await coldStart.runIfCold(sessRows.rows[0]);

    totalScraped = await _runScrape({
      jobId,
      job,
      sessions: sessRows.rows,
      targets,
      limit,
      onSessionPick: (s) => { lastSessionUsed = s; },
    });

    // _runScrape updates job rows incrementally. Read the final total
    // off the job row so the completed-progress check uses the value
    // the inserts actually committed.
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
    // state in the UI.
    try {
      const kind = mapped.kind || (err && (err.kind || (err.cause && err.cause.kind)));
      if (kind === 'checkpoint' || kind === 'login_required' || kind === 'action_blocked') {
        // eslint-disable-next-line global-require
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
          [lastSessionUsed.id, newState, mapped.message, kind, newStatus]
        );
        logger.warn(
          `IG.scrape: flipped session ${lastSessionUsed.id} → ${newState} (${kind})`
        );
        // Phase 3.B15 — record the detection event so the admin
        // dashboard surfaces "IG flagged this session during a real
        // scrape" with the kind that caused the flip.
        try {
          // eslint-disable-next-line global-require
          const detectionEvents = require('./detectionEvents');
          detectionEvents.record({
            sessionId: lastSessionUsed.id,
            userId: lastSessionUsed.user_id || null,
            eventKind: kind,
            apiPath: 'scrape._executeScrapeJob',
            httpStatus: mapped.statusCode || null,
            responseBody: mapped.message,
            requestFingerprint: {
              action_class: 'read',
              api_mode:
                (lastSessionUsed.platform_state && lastSessionUsed.platform_state.api_mode) ||
                'mobile',
              target_type: job && job.target_type,
            },
          }).catch(() => {});
        } catch (_recErr) { /* swallow */ }
      }
    } catch (flipErr) {
      logger.warn(
        `IG.scrape: failed to flip session ${lastSessionUsed.id} health state: ${flipErr.message}`
      );
    }
  }
}

// ---------------------------------------------------------------------
// Core scrape executor — handles all 5 target types, with multi-session
// round-robin and per-target backoff/pivot on rate_limited errors.
// ---------------------------------------------------------------------

/**
 * Run one scrape job end-to-end. Returns the total number of users
 * inserted across all targets.
 *
 * Behaviour:
 *   - For each target, picks the next session in round-robin order,
 *     skipping any session that is in a feedback cooldown, has
 *     breached its daily quota, or is outside active-hours.
 *   - On `rate_limited` / `action_blocked` from a session, that
 *     session is parked for the rest of the job and the next session
 *     in the rotation is tried. If no sessions remain, the error is
 *     re-thrown so `_executeScrapeJob` can record the flip.
 *   - For followers/following the cookie-uploaded (web) and
 *     interactive (mobile) sessions both work; for likers/commenters/
 *     tagged we use the web path (cookie session) regardless of
 *     api_mode because the mobile API doesn't expose a stable likers
 *     pagination cursor and the web endpoints accept the same
 *     sessionid cookie.
 */
async function _runScrape({ jobId, job, sessions, targets, limit, onSessionPick }) {
  const targetType = job.target_type;
  let totalScraped = 0;
  let cursor = 0; // round-robin pointer

  // Pre-compute the canonical referer for each target type so each
  // request matches the page a real user would have open.
  for (const targetRaw of targets) {
    if (totalScraped >= limit) break;

    const remaining = limit - totalScraped;
    const sessionPool = sessions.slice(); // mutable copy so we can park failed sessions

    let parkedReasons = [];
    let producedThisTarget = 0;
    let lastError = null;

    while (sessionPool.length && producedThisTarget < remaining) {
      const session = sessionPool[cursor % sessionPool.length];
      if (typeof onSessionPick === 'function') onSessionPick(session);

      // Skip sessions that are capped. We deliberately DO NOT park
      // sessions for active-hours here either — the outer
      // _executeScrapeJob bypass already let the operator-initiated
      // job through, so per-session gating would re-introduce the
      // same "stuck pending" bug for jobs whose only session is
      // outside its window.
      try {
        await scrapeQuota.assertWithinCap(session.id, 1);
      } catch (quotaErr) {
        parkedReasons.push(`session ${session.id}: ${quotaErr.message}`);
        sessionPool.splice(cursor % sessionPool.length, 1);
        continue;
      }

      try {
        const inserted = await _scrapeTargetWithSession({
          jobId,
          job,
          session,
          targetRaw,
          targetType,
          limit: remaining - producedThisTarget,
          onProgress: (delta) => {
            totalScraped += delta;
            producedThisTarget += delta;
          },
        });
        // _scrapeTargetWithSession returns the count it actually
        // committed; we already updated totalScraped via onProgress.
        // Advance the round-robin pointer so the next target prefers
        // a different session, smoothing load across the pool.
        cursor = (cursor + 1) % Math.max(1, sessionPool.length);
        // We're done with this target.
        break;
      } catch (err) {
        const mapped = _mapIgError(err);
        lastError = mapped;

        // Partial-success signal raised by paginateFriendList after
        // exhausting its retries mid-pagination. The rows we already
        // streamed are committed via onProgress(); finish this target
        // cleanly with a warning instead of failing the job.
        if (err && err.partial && producedThisTarget > 0) {
          logger.warn(
            `IG.scrape job ${jobId}: session ${session.id} returned partial result ` +
            `for target=${targetRaw} (${producedThisTarget} rows) — accepting and moving on.`
          );
          await _setStatus(jobId, 'running', {
            total_found: totalScraped,
            error: `Partial: target=${targetRaw} stopped after ${producedThisTarget} rows (${err.kind || 'rate_limited'}).`,
          });
          cursor = (cursor + 1) % Math.max(1, sessionPool.length);
          break;
        }

        const isPivotable =
          mapped.kind === 'rate_limited' ||
          mapped.kind === 'action_blocked' ||
          mapped.kind === 'forbidden';
        if (isPivotable && sessionPool.length > 1) {
          logger.warn(
            `IG.scrape job ${jobId}: session ${session.id} hit ${mapped.kind} on target=${targetRaw}; ` +
            `pivoting to next session.`
          );
          parkedReasons.push(`session ${session.id}: ${mapped.kind}`);
          sessionPool.splice(cursor % sessionPool.length, 1);
          continue;
        }

        // Single-session pool that ran out of retries on a transient
        // throttle: keep whatever we already produced (partial success)
        // rather than failing the whole job and discarding 36 rows.
        if (isPivotable && producedThisTarget > 0) {
          logger.warn(
            `IG.scrape job ${jobId}: session ${session.id} hit ${mapped.kind} on target=${targetRaw} ` +
            `with no other sessions to pivot to (already scraped ${producedThisTarget}). Accepting partial.`
          );
          await _setStatus(jobId, 'running', {
            total_found: totalScraped,
            error: `Partial: target=${targetRaw} stopped after ${producedThisTarget} rows (${mapped.kind}).`,
          });
          cursor = (cursor + 1) % Math.max(1, sessionPool.length);
          break;
        }

        // Non-pivotable error (login_required / checkpoint / 404 /
        // network) — propagate so the outer handler records it and
        // flips the session state if appropriate.
        throw err;
      }
    }
    if (parkedReasons.length) {
      logger.info(
        `IG.scrape job ${jobId}: target=${targetRaw} sessions parked → ${parkedReasons.join('; ')}`
      );
    }
    if (producedThisTarget === 0 && lastError) {
      // We couldn't get anything from any session for this target —
      // skip but don't fail the whole job. The job record's
      // error_message will reflect the last failure if every target
      // hits this branch.
      await _setStatus(jobId, 'running', {
        total_found: totalScraped,
        error: `Skipped target ${targetRaw}: ${lastError.message}`,
      });
    }
  }

  return totalScraped;
}

/**
 * Run a single (session, target) pair. Splits on api_mode (web vs
 * mobile) and target_type. Returns the count of users actually
 * inserted (post-dedupe by ON CONFLICT).
 */
async function _scrapeTargetWithSession({
  jobId,
  job,
  session,
  targetRaw,
  targetType,
  limit,
  onProgress,
}) {
  const apiMode =
    (session.platform_state && session.platform_state.api_mode) ||
    ((session.platform_state && session.platform_state.source === 'browser_cookies')
      ? 'web' : 'mobile');

  // Cookie-uploaded (web) sessions support all five target types.
  // Mobile-API sessions support followers/following natively; for the
  // other three we transparently reuse the web surface because the
  // mobile endpoints either don't expose a stable cursor (likers) or
  // are gated behind device-binding checks that fail from the panel
  // host (commenters, usertags). A mobile-mode session that lacks
  // browser cookies will fail-fast inside webScraper with a clean
  // 401 — caller catches and pivots.
  if (apiMode === 'web' || _MEDIA_TARGET_TYPES.has(targetType) || targetType === 'tagged') {
    return _runWebScrapeTarget({ jobId, job, session, targetRaw, targetType, limit, onProgress });
  }
  return _runMobileScrapeTarget({ jobId, job, session, targetRaw, targetType, limit, onProgress });
}

// ---------------------------------------------------------------------
// Web scrape executor (per-target)
// ---------------------------------------------------------------------

async function _runWebScrapeTarget({ jobId, job, session, targetRaw, targetType, limit, onProgress }) {
  // Decrypt session_data — webScraper's _resolveCtx will redo this
  // via igFetch.sessionContext; we just need to fail fast if the blob
  // is missing so the per-target loop can pivot.
  if (session.session_data) {
    try {
      const decrypted = decrypt(session.session_data);
      JSON.parse(decrypted);
    } catch (err) {
      const e = new Error(`Failed to decrypt session blob: ${err.message}`);
      e.statusCode = 500;
      e.kind = 'network';
      throw e;
    }
  } else {
    const e = new Error('Session has no decrypted blob — cookie-based scrape requires an uploaded cookies session.');
    e.statusCode = 401;
    e.kind = 'login_required';
    throw e;
  }

  if (targetType === 'followers' || targetType === 'following') {
    return _scrapeWebFriendList({ jobId, session, targetRaw, kind: targetType, limit, onProgress });
  }
  if (targetType === 'likers') {
    return _scrapeWebLikers({ jobId, session, targetRaw, limit, onProgress });
  }
  if (targetType === 'commenters') {
    return _scrapeWebCommenters({ jobId, session, targetRaw, limit, onProgress });
  }
  if (targetType === 'tagged') {
    return _scrapeWebTagged({ jobId, session, targetRaw, limit, onProgress });
  }
  const e = new Error(`Unsupported target_type='${targetType}' for web scrape`);
  e.statusCode = 400;
  throw e;
}

async function _streamUsers(generator, { jobId, session, limit, onProgress, batchSize = 10 }) {
  // batchSize=10 (was 25): commit partial pages to scraped_users every
  // 10 yields rather than every 25. With IG's web friend-list endpoint
  // returning ~25 users/page, this guarantees the rows from page 1
  // are durably committed before page 2 has a chance to throttle.
  // The previous 25 default meant a mid-page throttle at user 36
  // could discard rows 26-36 on rollback.
  let inserted = 0;
  const buffer = [];
  for await (const u of generator) {
    if (!u) continue;
    buffer.push(u);
    if (buffer.length >= batchSize) {
      const slice = buffer.splice(0, buffer.length);
      const allowed = await scrapeQuota.consume(session.id, slice.length);
      const finalSlice = allowed >= slice.length ? slice : slice.slice(0, allowed);
      const n = await _insertUsersBatch(jobId, finalSlice);
      inserted += n;
      if (onProgress) onProgress(n);
      await _setStatus(jobId, 'running', { total_found: await _readTotalFound(jobId) });
      if (allowed < slice.length) {
        const e = new Error(`Daily scrape cap reached for session ${session.id}; partial insert.`);
        e.kind = 'daily_cap';
        e.statusCode = 429;
        throw e;
      }
      if (inserted >= limit) return inserted;
    }
  }
  if (buffer.length) {
    const allowed = await scrapeQuota.consume(session.id, buffer.length);
    const finalSlice = allowed >= buffer.length ? buffer : buffer.slice(0, allowed);
    const n = await _insertUsersBatch(jobId, finalSlice);
    inserted += n;
    if (onProgress) onProgress(n);
    await _setStatus(jobId, 'running', { total_found: await _readTotalFound(jobId) });
  }
  return inserted;
}

async function _readTotalFound(jobId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scraped_users WHERE job_id = $1`,
    [jobId]
  );
  return r.rows[0]?.n || 0;
}

async function _scrapeWebFriendList({ jobId, session, targetRaw, kind, limit, onProgress }) {
  const targetUsername = String(targetRaw).replace(/^@/, '').toLowerCase();
  // Pre-warm: a quick "view profile" request before paginating the
  // friends list mirrors what a real human does (open the profile,
  // tap Followers). The igFetch limiter will make sure this counts
  // against the per-session bucket.
  const profile = await webScraper.getUserIdByUsername(session, targetUsername);
  const gen = webScraper.paginateFriendList(session, profile.pk, kind, {
    limit,
    pageSize: 50,
    targetUsername,
  });
  return _streamUsers(gen, { jobId, session, limit, onProgress });
}

async function _scrapeWebLikers({ jobId, session, targetRaw, limit, onProgress }) {
  const info = await webScraper.getMediaInfo(session, targetRaw);
  const gen = webScraper.paginateMediaLikers(session, info.pk, {
    limit,
    urlPath: info.urlPath,
  });
  return _streamUsers(gen, { jobId, session, limit, onProgress });
}

async function _scrapeWebCommenters({ jobId, session, targetRaw, limit, onProgress }) {
  const info = await webScraper.getMediaInfo(session, targetRaw);
  const gen = webScraper.paginateMediaCommenters(session, info.pk, {
    limit,
    urlPath: info.urlPath,
  });
  return _streamUsers(gen, { jobId, session, limit, onProgress });
}

async function _scrapeWebTagged({ jobId, session, targetRaw, limit, onProgress }) {
  const targetUsername = String(targetRaw).replace(/^@/, '').toLowerCase();
  const profile = await webScraper.getUserIdByUsername(session, targetUsername);
  const gen = webScraper.paginateUserTags(session, profile.pk, {
    limit,
    targetUsername,
  });
  return _streamUsers(gen, { jobId, session, limit, onProgress });
}

// ---------------------------------------------------------------------
// Mobile-API scrape executor (per-target, followers/following only)
// ---------------------------------------------------------------------

async function _runMobileScrapeTarget({ jobId, job, session, targetRaw, targetType, limit, onProgress }) {
  if (targetType !== 'followers' && targetType !== 'following') {
    // The dispatcher in _scrapeTargetWithSession already rerouted the
    // other types to web, but defend against future changes.
    const e = new Error(`Mobile scrape only supports followers/following, got '${targetType}'`);
    e.statusCode = 400;
    throw e;
  }
  const client = await igClient.getClient(session);
  const pageSize = Math.min(limit, await _getPageSize(targetType, 200));

  const targetUsername = String(targetRaw).replace(/^@/, '').toLowerCase();
  await sessionLimiter.acquire(session.id, { class: 'read' });
  const targetUserId = await client.user.getIdByUsername(targetUsername);

  const feed = targetType === 'followers'
    ? client.feed.accountFollowers(targetUserId)
    : client.feed.accountFollowing(targetUserId);

  let received = 0;
  let firstPage = true;
  let inserted = 0;
  do {
    await sessionLimiter.acquire(session.id, { class: 'read' });
    if (!firstPage) await _jitterSleep(500, 1500);
    firstPage = false;
    const items = await feed.items();
    const slice = items.slice(0, Math.max(0, limit - received));
    const allowed = await scrapeQuota.consume(session.id, slice.length);
    const finalSlice = allowed >= slice.length ? slice : slice.slice(0, allowed);
    const n = await _insertUsersBatch(jobId, finalSlice);
    inserted += n;
    received += finalSlice.length;
    if (onProgress) onProgress(n);
    await _setStatus(jobId, 'running', { total_found: await _readTotalFound(jobId) });
    if (allowed < slice.length) {
      const e = new Error(`Daily scrape cap reached for session ${session.id}; partial insert.`);
      e.kind = 'daily_cap';
      e.statusCode = 429;
      throw e;
    }
    if (received >= limit) break;
  } while (feed.isMoreAvailable() && received < pageSize * 10);
  return inserted;
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
