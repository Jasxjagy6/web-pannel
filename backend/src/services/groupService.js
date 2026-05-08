const { pool } = require('../config/database');
const telegramService = require('./telegramService');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const { redisClient } = require('../config/redis');
const {
  normalizeTelegramTarget,
  collectTelegramTargetCandidates,
} = require('../utils/telegramTargetNormalizer');
const distributionPlanner = require('./distributionPlanner');
const audienceFilter = require('./audienceFilterService');
const sessionCooldown = require('./sessionCooldown');

/**
 * Default delay in milliseconds between batch operations.
 */
const DEFAULT_DELAY_MS = 3000;

/**
 * Default batch size for adding members.
 */
const DEFAULT_BATCH_SIZE = 10;

/**
 * Maximum number of flood retries before giving up on a single user.
 */
const MAX_FLOOD_RETRIES = 5;

/**
 * TTL in seconds for Redis progress keys (1 hour).
 */
const PROGRESS_TTL = 3600;

/**
 * TTL in seconds for Redis cancel tokens (1 hour).
 */
const CANCEL_TTL = 3600;

/**
 * Utility to extract flood wait seconds from a Telegram error message.
 */
function extractFloodSeconds(errorMessage) {
  if (!errorMessage) return 30;
  const match = errorMessage.match(/FLOOD_WAIT_(\d+)/i) || errorMessage.match(/wait of (\d+) seconds/i);
  if (match) return parseInt(match[1], 10);
  const simpleMatch = errorMessage.match(/(\d+) seconds/i);
  if (simpleMatch) return parseInt(simpleMatch[1], 10);
  return 30;
}

/**
 * Utility to sleep for a given number of milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check whether an operation has been cancelled via Redis.
 */
async function isCancelled(opId) {
  try {
    if (!redisClient.isReady) return false;
    const val = await redisClient.get(`group:cancel:${opId}`);
    return val === '1';
  } catch {
    return false;
  }
}

/**
 * Update the progress record in Redis for an operation.
 */
async function updateProgress(opId, progressData) {
  try {
    if (!redisClient.isReady) return;
    const key = `group:add_progress:${opId}`;
    await redisClient.set(key, JSON.stringify(progressData), { EX: PROGRESS_TTL });
  } catch (err) {
    logger.error(`Failed to update Redis progress for op ${opId}`, { error: err.message });
  }
}

/**
 * Validate that the given sessions belong to the specified user.
 *
 * By default, sessions whose `cooldown_until` is in the future are
 * filtered out of the returned rows (they're held in flood/peer-flood
 * lockout from `_withFloodRetry`). The dropped sessions are attached
 * to the returned array as a non-enumerable `cooldownSkipped` property
 * so callers can include them in the operation result for UX
 * surfacing without changing the function signature.
 *
 * If every requested session is on cooldown, throws
 * `ALL_SESSIONS_ON_COOLDOWN` (409). Callers that legitimately need to
 * operate on a cooldown session (e.g. privacy / 2FA / login menus)
 * should pass `{ filterCooldown: false }` — but those flows live in
 * sessionController, not here, so the default-on behaviour is what we
 * want for every caller in this file.
 *
 * @param {Array<string|number>} sessionIds
 * @param {number|string} userId
 * @param {{ filterCooldown?: boolean }} [opts]
 */
async function validateSessionsOwnership(sessionIds, userId, opts = {}) {
  const { filterCooldown = true } = opts;
  if (!sessionIds || sessionIds.length === 0) {
    throw new AppError('At least one session ID is required', 400, 'NO_SESSIONS');
  }

  const placeholders = sessionIds.map((_, i) => `$${i + 2}`).join(',');
  // SELECT cooldown_* alongside the legacy columns. On a deploy that
  // hasn't run migration v24 yet the columns won't exist and the
  // query throws — fall back to the legacy column set in that case
  // so an upgrading deploy never breaks job submission.
  let result;
  try {
    result = await pool.query(
      `SELECT id, user_id, status, is_logged_in, phone,
              cooldown_until, cooldown_reason, cooldown_seconds, cooldown_set_at
         FROM sessions
        WHERE id IN (${placeholders})
          AND user_id = $1`,
      [userId, ...sessionIds]
    );
  } catch (selErr) {
    logger.warn(
      `validateSessionsOwnership: cooldown columns missing, falling back: ${selErr.message}`
    );
    result = await pool.query(
      `SELECT id, user_id, status, is_logged_in, phone
         FROM sessions
        WHERE id IN (${placeholders})
          AND user_id = $1`,
      [userId, ...sessionIds]
    );
  }

  if (result.rows.length === 0) {
    throw new AppError('No valid sessions found for this user', 404, 'SESSION_NOT_FOUND');
  }

  const notFound = sessionIds.filter(sid => !result.rows.find(r => r.id === sid));
  if (notFound.length > 0) {
    logger.warn(`Some sessions not found for user ${userId}`, { notFound });
  }

  if (!filterCooldown) {
    return result.rows;
  }

  // Filter rows whose cooldown_until is still in the future. Best-
  // effort — when the column is absent (legacy deploy) every row
  // passes through unchanged.
  const now = Date.now();
  const eligible = [];
  const skipped = [];
  for (const row of result.rows) {
    const cdAt = row.cooldown_until ? new Date(row.cooldown_until).getTime() : 0;
    if (cdAt > now) {
      skipped.push({
        id: row.id,
        cooldown_until: row.cooldown_until,
        remaining_seconds: Math.max(0, Math.ceil((cdAt - now) / 1000)),
        reason: row.cooldown_reason || null,
      });
    } else {
      eligible.push(row);
    }
  }

  if (eligible.length === 0 && skipped.length > 0) {
    const err = new AppError(
      `All ${skipped.length} requested session(s) are on cooldown`,
      409,
      'ALL_SESSIONS_ON_COOLDOWN'
    );
    err.cooldownSkipped = skipped;
    throw err;
  }

  if (skipped.length > 0) {
    logger.warn(
      `validateSessionsOwnership: ${skipped.length} session(s) skipped due to cooldown`,
      { userId, skipped }
    );
    Object.defineProperty(eligible, 'cooldownSkipped', {
      value: skipped,
      enumerable: false,
    });
  }

  return eligible;
}

class GroupService {
  // =========================================================================
  // Add Members to Groups/Channels (Multi-Session, Multi-Target)
  // =========================================================================

  /**
   * Add scraped members to target groups/channels using multiple sessions.
   *
   * Features:
   * - Multi-session round-robin distribution
   * - Multi-group/channel targeting
   * - Session membership verification
   * - Privacy settings handling (skip users who can't be added)
   * - Flood wait handling with retries
   * - Cancellation support
   *
   * @param {object} params
   * @param {number[]} params.sessionIds - Array of session IDs to use
   * @param {string[]} params.targetIds - Array of target group/channel IDs
   * @param {string} params.targetType - 'group' or 'channel'
   * @param {Array} params.userList - Users to add (with telegram_id, username, etc.)
   * @param {number} params.delayMin - Min delay between batches (seconds)
   * @param {number} params.delayMax - Max delay between batches (seconds)
   * @param {number} params.batchSize - Users per session per batch
   * @param {number} userId - User who owns the sessions
   * @returns {Promise<{opId, total, added, failed, skipped, results}>}
   */
  async addMembersToGroups(params, userId) {
    const {
      sessionIds,
      targetIds,
      targetType = 'group',
      delayMin = 30,
      delayMax = 60,
      batchSize = 5,
      // New rotation/cooldown distribution knobs (Auto/Manual mode).
      // When unset the planner picks safe defaults that match the
      // legacy behaviour for small lists and add proper cooldowns
      // for large ones.
      mode = 'auto',
      perSessionBurst,
      cooldownSecMin,
      cooldownSecMax,
      itemDelayMsMin,
      itemDelayMsMax,
      // Optional source list id — when set the audience filter
      // persists status back into list_items and purges NOT_FOUND
      // rows from the list.
      listId = null,
      // Optional pre-created group_operations row id. The async/queued
      // controller path inserts the row before queuing so the UI can
      // start tracking the job immediately; the worker then passes the
      // same opId through here so progress/results land on that row
      // instead of creating a second one.
      opId: existingOpId = null,
    } = params;
    let userList = params.userList;

    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!userList || userList.length === 0) {
      throw new AppError('No users provided for adding', 400, 'EMPTY_USER_LIST');
    }

    if (!targetIds || targetIds.length === 0) {
      throw new AppError('At least one target group/channel is required', 400, 'NO_TARGETS');
    }

    // ─── Pre-job audience filter ────────────────────────────────────
    // Dedupe + classify (cache + session-less t.me probe) the input
    // userList BEFORE we burn any session quota. We hard-drop NOT_FOUND
    // entries (and purge them from the list_items rows when listId is
    // given), and skip PRIVACY_RESTRICTED entries here because they
    // can't be added to a group anyway — those rows stay in the list
    // tagged `dm_only` for the bulk-DM path.
    //
    // Failing open is non-negotiable: if Redis/HTTP/DB is degraded we
    // still want add-members to run on the unfiltered list rather than
    // hard-failing.
    let audienceStats = null;
    let audienceDmOnly = [];
    let audienceDropped = [];
    try {
      const audienceResult = await audienceFilter.filterUserList({
        userList,
        listId,
        userId,
        context: 'add-members',
        options: {
          // Group-add jobs explicitly skip privacy-restricted users —
          // the API will refuse to add them anyway.
          includePrivacyRestricted: false,
          purgeNotFound: true,
        },
      });
      audienceStats = audienceResult.stats;
      audienceDmOnly = audienceResult.dmOnly || [];
      audienceDropped = audienceResult.dropped || [];
      if (Array.isArray(audienceResult.eligible) && audienceResult.eligible.length > 0) {
        userList = audienceResult.eligible.map((info) => info.raw);
      }
      logger.info('addMembersToGroups: audience filter applied', {
        userId,
        listId,
        stats: audienceStats,
        dmOnly: audienceDmOnly.length,
        dropped: audienceDropped.length,
        eligible: userList.length,
      });
    } catch (filterErr) {
      logger.warn('addMembersToGroups: audience filter failed; proceeding with raw userList', {
        error: filterErr.message,
        userId,
        listId,
      });
    }

    if (!userList || userList.length === 0) {
      // Filter dropped every entry. Don't throw — instead persist a
      // completed-with-zero-eligible op row so the UI sees what
      // happened.
      throw new AppError(
        'All audience entries were filtered out (not_found or privacy-restricted).',
        400,
        'NO_ELIGIBLE_USERS'
      );
    }

    // Normalize each user-list entry into the full candidate chain
    // (numeric id → @username → +phone) and skip unaddressable rows
    // up-front. We keep ALL candidates because scraped numeric ids
    // typically can't be resolved without a cached access_hash, while
    // a sibling @username on the same row often resolves cleanly via
    // contacts.ResolveUsername — so falling through is a real win.
    const preparedUsers = [];
    const unaddressable = [];
    for (const entry of userList) {
      const candidates = collectTelegramTargetCandidates(entry);
      if (candidates.length > 0) {
        preparedUsers.push({ entry, identifier: candidates[0], candidates });
      } else {
        unaddressable.push(entry);
      }
    }

    if (preparedUsers.length === 0) {
      throw new AppError(
        'No usable identifiers found in userList (every row was empty, a UUID placeholder, or otherwise unaddressable).',
        400,
        'NO_VALID_USERS'
      );
    }

    if (unaddressable.length > 0) {
      logger.warn(
        `addMembersToGroups: dropping ${unaddressable.length} unaddressable userList entries`,
        { sample: unaddressable.slice(0, 3) }
      );
    }

    // Verify session ownership
    const verifiedSessions = await validateSessionsOwnership(sessionIds, userId);
    if (verifiedSessions.length === 0) {
      throw new AppError('No valid sessions found', 404, 'NO_VALID_SESSIONS');
    }

    // Build the rotation plan that the runner will follow. In auto
    // mode the planner picks `perSessionBurst`, cooldown and per-item
    // delay based on totalItems / sessionCount. In manual mode the
    // operator's knobs are clamped to safe ranges and used as-is.
    //
    // For backward compatibility, when the caller still passes the
    // legacy `batchSize`/`delayMin`/`delayMax` triplet without the new
    // knobs we map them through so existing flows behave the same as
    // before (auto-mode picks a burst that matches `batchSize` for
    // small jobs anyway).
    const planParams = {
      totalItems: preparedUsers.length,
      sessionIds: verifiedSessions.map((s) => s.id),
      workType: 'group_add',
      mode,
      perSessionBurst: perSessionBurst != null
        ? perSessionBurst
        : (mode === 'manual' ? batchSize : undefined),
      cooldownSecMin,
      cooldownSecMax,
      itemDelayMsMin: itemDelayMsMin != null
        ? itemDelayMsMin
        : (mode === 'manual' && delayMin != null ? delayMin * 1000 : undefined),
      itemDelayMsMax: itemDelayMsMax != null
        ? itemDelayMsMax
        : (mode === 'manual' && delayMax != null ? delayMax * 1000 : undefined),
    };
    const plan = distributionPlanner.plan(planParams);

    logger.info(
      `Starting add members operation: ${userList.length} users to ${targetIds.length} target(s) using ${verifiedSessions.length} session(s)`,
      {
        userId,
        sessionCount: verifiedSessions.length,
        targetCount: targetIds.length,
        userListSize: userList.length,
        plan: {
          mode: plan.mode,
          perSessionBurst: plan.perSessionBurst,
          rounds: plan.rounds,
          cooldownSec: [plan.cooldownSecMin, plan.cooldownSecMax],
          itemDelayMs: [plan.itemDelayMsMin, plan.itemDelayMsMax],
        },
      }
    );

    // Create the operation record (or reuse the row that the
    // controller pre-created for the async/queued path).
    let opId;
    if (existingOpId) {
      opId = existingOpId;
      // Flip the row to running and refresh the stored counts/options
      // now that we know the post-filter total. This also stores the
      // first 100 users for the operation-detail panel.
      await pool.query(
        `UPDATE group_operations
            SET status = 'running',
                total_count = $2,
                total_users = $2,
                user_list   = $3,
                options     = $4
          WHERE id = $1`,
        [
          opId,
          userList.length,
          JSON.stringify(userList.slice(0, 100)),
          JSON.stringify({
            sessionIds: verifiedSessions.map((s) => s.id),
            targetIds,
            targetType,
            delayMin,
            delayMax,
            batchSize,
            plan,
            audience: audienceStats,
            dmOnly: audienceDmOnly.length,
            dropped: audienceDropped.length,
          }),
        ]
      );
    } else {
      const opResult = await pool.query(
        `INSERT INTO group_operations (
          user_id, session_id, target_group_id, operation, operation_type,
          total_count, total_users, status, user_list, options, created_at
        ) VALUES ($1, $2, $3, 'add_members', 'add_members', $4, $5, 'running', $6, $7, NOW())
        RETURNING id`,
        [
          userId,
          verifiedSessions[0].id, // primary session
          targetIds[0], // primary target
          userList.length,
          userList.length,
          JSON.stringify(userList.slice(0, 100)), // store first 100 for reference
          JSON.stringify({
            sessionIds: verifiedSessions.map(s => s.id),
            targetIds,
            targetType,
            delayMin,
            delayMax,
            batchSize,
            plan,
            audience: audienceStats,
            dmOnly: audienceDmOnly.length,
            dropped: audienceDropped.length,
          }),
        ]
      );
      opId = opResult.rows[0].id;
    }

    // Initialise Redis progress
    await updateProgress(opId, {
      operation_id: opId,
      progress: 0,
      added: 0,
      failed: 0,
      skipped: 0,
      total: userList.length,
      status: 'running',
    });

    const results = [];
    let addedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    // Surface the dropped rows in the response so the UI can show why
    // the count is lower than the input list size.
    for (const dropped of unaddressable) {
      const idForLog = dropped && typeof dropped === 'object'
        ? (dropped.telegram_id ?? dropped.id ?? dropped.username ?? 'unknown')
        : String(dropped);
      for (const targetId of targetIds) {
        results.push({
          userId: String(idForLog),
          targetId,
          success: false,
          error: 'Unaddressable list entry (no usable telegram_id, username, or phone)',
          skipped: true,
        });
        skippedCount++;
      }
    }

    const tgService = telegramService;

    try {
      // Step 1: Verify session membership in targets
      // For each target, check if at least one session is a member
      const sessionMemberships = {}; // sessionId -> {targetId: isMember}
      
      for (const targetId of targetIds) {
        for (const session of verifiedSessions) {
          const key = `${session.id}:${targetId}`;
          try {
            const entity = await tgService._resolveEntity(session.id, targetId);
            sessionMemberships[key] = !!entity;
            logger.info(`Session ${session.id} ${entity ? 'IS' : 'is NOT'} member of ${targetId}`, { sessionId: session.id, targetId });
          } catch (err) {
            sessionMemberships[key] = false;
            logger.warn(`Session ${session.id} cannot access ${targetId}: ${err.message}`);
          }
        }

        // Check if at least one session is a member of this target
        const anyMember = verifiedSessions.some(s => sessionMemberships[`${s.id}:${targetId}`]);
        if (!anyMember) {
          logger.warn(`No session is a member of ${targetId}. Attempting to add sessions first.`);
          // Note: We can't programmatically add sessions to groups without admin rights
          // The user must ensure at least one session is in the target
        }
      }

      // Step 2/3/4 — rotation runner.
      //
      // For each target group/channel:
      //   1. Filter to sessions that can actually access the target.
      //   2. Build a per-session work queue using the planner's
      //      round-robin layout (size = perSessionBurst per round).
      //   3. Execute the rotation:
      //        round 0: each session does its first burst,
      //        sleep cooldownSec, round 1: same, ...
      //      Per-item delay is sampled from
      //      [itemDelayMsMin..itemDelayMsMax] each step. PEER_FLOOD
      //      disables the offending session for the rest of the run
      //      (subsequent rounds just skip it).
      const peerFloodSessions = new Set(); // session.id values that hit PEER_FLOOD

      for (let tIdx = 0; tIdx < targetIds.length; tIdx++) {
        const targetId = targetIds[tIdx];

        const availableSessions = verifiedSessions.filter(
          (s) => sessionMemberships[`${s.id}:${targetId}`]
        );

        if (availableSessions.length === 0) {
          logger.error(`No available sessions for target ${targetId}, skipping`);
          for (const prepared of preparedUsers) {
            results.push({
              userId: prepared.identifier,
              targetId,
              success: false,
              error: 'No session is a member of this target',
              skipped: true,
            });
            skippedCount++;
          }
          continue;
        }

        const burst = plan.perSessionBurst;
        const sessionsForRotation = availableSessions.map((s) => s.id);

        // Total rounds for THIS target (depends on # available sessions).
        const itemsPerRound = sessionsForRotation.length * burst;
        const targetRounds = Math.max(1, Math.ceil(preparedUsers.length / itemsPerRound));

        for (let round = 0; round < targetRounds; round++) {
          for (let sIdx = 0; sIdx < availableSessions.length; sIdx++) {
            const session = availableSessions[sIdx];
            if (peerFloodSessions.has(session.id)) continue; // skip dead sessions

            const start = round * itemsPerRound + sIdx * burst;
            const usersChunk = preparedUsers.slice(start, start + burst);
            if (usersChunk.length === 0) continue;

            // Check cancellation at the top of every (round, session)
            // burst so we abort promptly even mid-rotation.
            if (await isCancelled(opId)) {
              logger.info(
                `Operation ${opId} cancelled at target ${targetId}, session ${session.id}, round ${round + 1}`
              );
              await updateProgress(opId, { status: 'cancelled' });
              await this._finalizeOperation(opId, 'cancelled', addedCount, failedCount, skippedCount, results);
              return { opId, total: userList.length, added: addedCount, failed: failedCount, skipped: skippedCount, results };
            }

          {
            let burstHitPeerFlood = false;
            for (let chunkIdx = 0; chunkIdx < usersChunk.length; chunkIdx++) {
              const prepared = usersChunk[chunkIdx];
              const candidates = prepared.candidates && prepared.candidates.length > 0
                ? prepared.candidates
                : [prepared.identifier];
              const userResult = {
                userId: prepared.identifier,
                targetId,
                sessionId: session.id,
                success: false,
              };

              // Some Telegram errors mean "this identifier won't work,
              // try the next one" rather than "this user is unreachable".
              // Examples: scraped numeric id with no cached access_hash
              // (PEER_ID_INVALID / "Could not find the input entity"),
              // or a username that no longer exists. We move on to the
              // next candidate in those cases.
              const isResolutionError = (msg) => {
                if (!msg) return false;
                const m = String(msg);
                return (
                  m.includes('Could not resolve user') ||
                  m.includes('Could not find the input entity') ||
                  m.includes('PEER_ID_INVALID') ||
                  m.includes('USERNAME_NOT_OCCUPIED') ||
                  m.includes('USERNAME_INVALID') ||
                  m.includes('USER_ID_INVALID')
                );
              };

              let addErr = null;
              let resolvedIdent = null;
              for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
                const userTelegramId = candidates[cIdx];
                try {
                  await tgService.addMemberToGroup(session.id, targetId, userTelegramId);
                  userResult.success = true;
                  resolvedIdent = userTelegramId;
                  addErr = null;
                  break;
                } catch (e) {
                  addErr = e;
                  if (cIdx + 1 < candidates.length && isResolutionError(e && e.message)) {
                    continue; // try next identifier
                  }
                  break; // real failure or last candidate
                }
              }

              if (userResult.success) {
                if (resolvedIdent && resolvedIdent !== userResult.userId) {
                  userResult.userId = resolvedIdent;
                }
                addedCount++;
              } else if (addErr) {
                const e2 = { message: (addErr && addErr.message) || String(addErr) };
                addErr = e2;
              }
              if (!userResult.success && addErr) {
                const errMsg = addErr.message || String(addErr);

                // PEER_FLOOD is account-level: once Telegram has decided
                // this session is spamming, every subsequent invite from
                // the same session will fail too. Abort the operation
                // for this session/target instead of grinding through
                // hundreds of guaranteed failures, and surface a clear
                // reason to the UI.
                const isPeerFlood =
                  errMsg.includes('PEER_FLOOD') ||
                  errMsg.includes('Too many actions performed');
                if (isPeerFlood) {
                  logger.error(
                    `PEER_FLOOD: session ${session.id} is rate-limited by Telegram, disabling for the rest of run on target ${targetId}`,
                    { opId }
                  );
                  userResult.error =
                    'Telegram rate limit (PEER_FLOOD) — session has been flagged for spam. Wait a few hours, use a warmed-up session, or reduce batch size / increase delay.';
                  failedCount++;
                  results.push(userResult);
                  // Mark every remaining user in this burst as skipped
                  // (the rotation loop will skip this session in future
                  // rounds via peerFloodSessions).
                  for (let r = chunkIdx + 1; r < usersChunk.length; r++) {
                    results.push({
                      userId: usersChunk[r].identifier,
                      targetId,
                      sessionId: session.id,
                      success: false,
                      skipped: true,
                      error: 'Skipped: session hit PEER_FLOOD earlier in this burst',
                    });
                    skippedCount++;
                  }
                  peerFloodSessions.add(session.id);
                  burstHitPeerFlood = true;
                  break;
                }

                // Handle FLOOD_WAIT (numeric, transient)
                if (errMsg.includes('FLOOD_WAIT')) {
                  const floodSeconds = extractFloodSeconds(errMsg);
                  logger.warn(`FLOOD_WAIT: waiting ${floodSeconds}s`, { opId, sessionId: session.id });
                  await sleep(floodSeconds * 1000);

                  // Retry once after flood wait. Use the candidate that
                  // most recently produced a non-resolution error (most
                  // likely the original numeric id).
                  const retryIdent = candidates[candidates.length - 1];
                  let retrySuccess = false;
                  let retryAttempts = 0;
                  while (!retrySuccess && retryAttempts < MAX_FLOOD_RETRIES) {
                    try {
                      await tgService.addMemberToGroup(session.id, targetId, retryIdent);
                      retrySuccess = true;
                      userResult.success = true;
                      addedCount++;
                    } catch (retryErr) {
                      retryAttempts++;
                      const retryMsg = retryErr.message || String(retryErr);
                      if (retryMsg.includes('FLOOD_WAIT')) {
                        await sleep(extractFloodSeconds(retryMsg) * 1000);
                      } else {
                        userResult.error = retryMsg;
                        break;
                      }
                    }
                  }
                  if (!retrySuccess && !userResult.success) {
                    userResult.error = userResult.error || 'Failed after flood wait retries';
                  }
                }
                // Handle privacy restrictions - SKIP these users
                else if (
                  errMsg.includes('USER_PRIVACY_RESTRICT') ||
                  errMsg.includes('PRIVACY_RESTRICTED') ||
                  errMsg.includes('USER_NOT_MUTUAL_CONTACT') ||
                  errMsg.includes('USER_CHANNELS_TOO_MUCH')
                ) {
                  userResult.error = 'Privacy settings prevent adding';
                  userResult.skipped = true;
                  skippedCount++;
                  // Tag this entry as `dm_only` in the audience cache
                  // so the next group-add skips it but bulk-DM picks
                  // it up. Best-effort — never block the loop.
                  audienceFilter
                    .recordObservedFromEntry(prepared.entry, 'privacy_restricted', errMsg, 'observed-add')
                    .catch((rErr) =>
                      logger.warn(`audienceFilter.recordObserved (privacy) failed: ${rErr.message}`)
                    );
                }
                // Handle user already in group
                else if (
                  errMsg.includes('USER_ALREADY_PARTICIPANT') ||
                  errMsg.includes('USERS_TOO_MUCH')
                ) {
                  userResult.error = 'User already in target';
                  userResult.skipped = true;
                  skippedCount++;
                }
                // Handle admin required
                // Handle admin required or write forbidden
                else if (
                  errMsg.includes('CHAT_ADMIN_REQUIRED') ||
                  errMsg.includes('CHAT_WRITE_FORBIDDEN') ||
                  errMsg.includes('CHAT_ADMIN_REQUIRED')
                ) {
                  userResult.error = 'Session needs admin rights with "Add Members" permission in this target';
                  failedCount++;
                }
                // Handle user banned or restricted
                else if (errMsg.includes('USER_BANNED_IN_CHANNEL') || errMsg.includes('USER_RESTRICTED')) {
                  userResult.error = 'User is banned or restricted';
                  failedCount++;
                }
                // Handle user not found / deactivated → cache as
                // not_found so the next job skips them and the list
                // is purged on the next filter pass.
                else if (
                  errMsg.includes('USER_DEACTIVATED') ||
                  errMsg.includes('INPUT_USER_DEACTIVATED') ||
                  errMsg.includes('USER_NOT_FOUND') ||
                  errMsg.includes('USERNAME_NOT_OCCUPIED') ||
                  errMsg.includes('USER_ID_INVALID')
                ) {
                  userResult.error = errMsg;
                  failedCount++;
                  audienceFilter
                    .recordObservedFromEntry(prepared.entry, 'not_found', errMsg, 'observed-add')
                    .catch((rErr) =>
                      logger.warn(`audienceFilter.recordObserved (not_found) failed: ${rErr.message}`)
                    );
                }
                // Generic failure
                else {
                  userResult.error = errMsg;
                  failedCount++;
                }
              }

              // Cache successful adds as 'live' so the next filter
              // pass doesn't waste an HTTP probe on them. Done here
              // (after all the error/retry handling) so the success
              // case from a FLOOD_WAIT retry is captured too.
              if (userResult.success) {
                audienceFilter
                  .recordObservedFromEntry(prepared.entry, 'live', null, 'observed-add')
                  .catch((rErr) =>
                    logger.warn(`audienceFilter.recordObserved (live) failed: ${rErr.message}`)
                  );
              }

              results.push(userResult);
              if (burstHitPeerFlood) break;

              // Per-item delay so we don't hammer Telegram from the
              // same session within a burst. Skip the trailing sleep
              // (after the last item) — the cooldown logic below will
              // pause between rounds anyway.
              if (chunkIdx < usersChunk.length - 1 && plan.itemDelayMsMax > 0) {
                const delayMs =
                  plan.itemDelayMsMin +
                  Math.random() * (plan.itemDelayMsMax - plan.itemDelayMsMin);
                await sleep(delayMs);
              }
            }

            // Update progress
            const processed = addedCount + failedCount + skippedCount;
            await updateProgress(opId, {
              progress: processed,
              added: addedCount,
              failed: failedCount,
              skipped: skippedCount,
              total: userList.length * targetIds.length,
              status: 'running',
              currentTarget: targetId,
              currentSession: session.id,
              currentRound: round + 1,
              totalRounds: targetRounds,
            });
          }
          } // end (round, session) block

          // Cooldown between rotations (skip after the last round and
          // when no cooldown was configured).
          const liveSessions = availableSessions.filter((s) => !peerFloodSessions.has(s.id));
          if (
            round < targetRounds - 1 &&
            liveSessions.length > 0 &&
            plan.cooldownSecMax > 0
          ) {
            if (await isCancelled(opId)) {
              await updateProgress(opId, { status: 'cancelled' });
              await this._finalizeOperation(opId, 'cancelled', addedCount, failedCount, skippedCount, results);
              return { opId, total: userList.length, added: addedCount, failed: failedCount, skipped: skippedCount, results };
            }
            const cooldownSec =
              plan.cooldownSecMin + Math.random() * (plan.cooldownSecMax - plan.cooldownSecMin);
            logger.info(
              `Cooldown between rotations: ${cooldownSec.toFixed(0)}s (target=${targetId}, round=${round + 1}/${targetRounds})`,
              { opId }
            );
            await updateProgress(opId, {
              progress: addedCount + failedCount + skippedCount,
              added: addedCount,
              failed: failedCount,
              skipped: skippedCount,
              total: userList.length * targetIds.length,
              status: 'cooldown',
              currentTarget: targetId,
              currentRound: round + 1,
              totalRounds: targetRounds,
              cooldownSec: Math.round(cooldownSec),
            });
            await sleep(cooldownSec * 1000);
          }
        }
      }

      // Finalise
      const finalStatus = await isCancelled(opId) ? 'cancelled' : 'completed';
      await this._finalizeOperation(opId, finalStatus, addedCount, failedCount, skippedCount, results);

      logger.info(`Add members operation ${opId} finished: ${addedCount} added, ${failedCount} failed, ${skippedCount} skipped`, { opId });

      return {
        opId,
        total: userList.length,
        added: addedCount,
        failed: failedCount,
        skipped: skippedCount,
        results,
        audience: {
          stats: audienceStats,
          dmOnly: audienceDmOnly.length,
          dropped: audienceDropped.length,
        },
        cooldownSkipped: verifiedSessions.cooldownSkipped || [],
      };
    } catch (outerErr) {
      logger.error(`Fatal error in add members operation ${opId}`, { error: outerErr.message });
      await this._finalizeOperation(opId, 'failed', addedCount, failedCount, skippedCount, results);
      throw new AppError(`Operation failed: ${outerErr.message}`, 500, 'OPERATION_FAILED');
    }
  }

  // =========================================================================
  // Configure Group Spam / Settings
  // =========================================================================

  async configureGroupSpam(sessionId, groupId, settings, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!settings || Object.keys(settings).length === 0) {
      throw new AppError('No settings provided for configuration', 400, 'EMPTY_SETTINGS');
    }

    const sessions = await validateSessionsOwnership([sessionId], userId);

    const tgService = telegramService;

    try {
      const entity = await tgService._resolveEntity(sessionId, groupId);
      if (!entity) {
        throw new AppError(`Could not resolve group: ${groupId}`, 400, 'GROUP_NOT_FOUND');
      }

      const updates = [];

      if (
        settings.slowmode_seconds !== undefined ||
        settings.signatures !== undefined ||
        settings.scam !== undefined ||
        settings.fake !== undefined ||
        settings.forum !== undefined
      ) {
        const inputPeer = this._getInputPeer(entity);

        await tgService._withFloodRetry(sessionId, async () => {
          const { Api } = require('telegram/tl');
          return await tgService.clients.get(sessionId).client.invoke(
            new Api.channels.EditCreator({
              channel: inputPeer,
              slowmode: settings.slowmode_seconds !== undefined ? settings.slowmode_seconds : 0,
            })
          );
        });

        updates.push('slowmode');
      }

      if (settings.permissions) {
        const perm = settings.permissions;
        const rights = {};

        if (perm.sendMessages === false) rights.sendMessages = true;
        if (perm.sendMedia === false) rights.sendMedia = true;
        if (perm.sendStickers === false) rights.sendStickers = true;
        if (perm.sendGifs === false) rights.sendGifs = true;
        if (perm.sendGames === false) rights.sendGames = true;
        if (perm.sendInline === false) rights.sendInline = true;
        if (perm.embedLinks === false) rights.embedLinks = true;
        if (perm.sendPolls === false) rights.sendPolls = true;
        if (perm.changeInfo === false) rights.changeInfo = true;
        if (perm.inviteUsers === false) rights.inviteUsers = true;
        if (perm.pinMessages === false) rights.pinMessages = true;

        const { Api } = require('telegram/tl');

        const bannedRights = new Api.ChatBannedRights({
          untilDate: 0,
          viewMessages: false,
          sendMessages: rights.sendMessages || false,
          sendMedia: rights.sendMedia || false,
          sendStickers: rights.sendStickers || false,
          sendGifs: rights.sendGifs || false,
          sendGames: rights.sendGames || false,
          sendInline: rights.sendInline || false,
          embedLinks: rights.embedLinks || false,
          sendPolls: rights.sendPolls || false,
          changeInfo: rights.changeInfo || false,
          inviteUsers: rights.inviteUsers || false,
          pinMessages: rights.pinMessages || false,
        });

        const inputPeer = this._getInputPeer(entity);

        await tgService._withFloodRetry(sessionId, async () => {
          return await tgService.clients.get(sessionId).client.invoke(
            new Api.messages.EditChatDefaultBannedRights({
              peer: inputPeer,
              bannedRights: bannedRights,
            })
          );
        });

        updates.push('permissions');
      }

      if (settings.about !== undefined) {
        const { Api } = require('telegram/tl');
        const inputPeer = this._getInputPeer(entity);

        if (entity.className === 'Channel') {
          await tgService._withFloodRetry(sessionId, async () => {
            return await tgService.clients.get(sessionId).client.invoke(
              new Api.channels.EditAbout({
                channel: inputPeer,
                about: settings.about,
              })
            );
          });
        }

        updates.push('about');
      }

      logger.info(`Group ${groupId} configured by user ${userId}: ${updates.join(', ')}`, { sessionId });

      return { success: true, groupId: String(groupId), settings, appliedUpdates: updates };
    } catch (error) {
      logger.error(`Failed to configure group ${groupId}`, { sessionId, userId, error: error.message });
      if (error instanceof AppError) throw error;
      throw new AppError(`Failed to configure group: ${error.message}`, error.statusCode || 500, 'GROUP_CONFIG_FAILED');
    }
  }

  // =========================================================================
  // Auto-Manage Group
  // =========================================================================

  async autoManageGroup(groupId, rules, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!rules || Object.keys(rules).length === 0) {
      throw new AppError('No rules provided for auto-management', 400, 'EMPTY_RULES');
    }

    const sessionResult = await pool.query(
      'SELECT id FROM sessions WHERE user_id = $1 AND is_logged_in = true LIMIT 1',
      [userId]
    );

    if (sessionResult.rows.length === 0) {
      throw new AppError('No active sessions available for group management', 400, 'NO_ACTIVE_SESSION');
    }

    await pool.query(
      `INSERT INTO group_operations (
        user_id, session_id, target_group_id, operation, operation_type, status, options, created_at
      ) VALUES ($1, $2, $3, 'auto_manage', 'auto_manage', 'running', $4, NOW())
      RETURNING id`,
      [userId, sessionResult.rows[0].id, String(groupId), JSON.stringify(rules)]
    );

    logger.info(`Auto-management rules configured for group ${groupId} by user ${userId}`, { rules: Object.keys(rules) });

    return {
      success: true,
      groupId: String(groupId),
      rules,
      message: 'Auto-management rules have been configured',
    };
  }

  // =========================================================================
  // List Groups
  // =========================================================================

  async listGroups(sessionId, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    await validateSessionsOwnership([sessionId], userId);

    const tgService = telegramService;

    try {
      const result = await tgService.getGroups(sessionId);
      logger.info(`Listed ${result.total} groups for session ${sessionId}`, { userId });
      return result;
    } catch (error) {
      logger.error(`Failed to list groups for session ${sessionId}`, { userId, error: error.message });
      if (error instanceof AppError) throw error;
      throw new AppError(`Failed to list groups: ${error.message}`, error.statusCode || 500, 'LIST_GROUPS_FAILED');
    }
  }

  // =========================================================================
  // Get Group Info
  // =========================================================================

  async getGroupInfo(sessionId, groupId, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    await validateSessionsOwnership([sessionId], userId);

    const tgService = telegramService;

    try {
      const info = await tgService.getGroupInfo(sessionId, groupId);
      logger.info(`Retrieved group info for ${groupId}`, { sessionId, userId });
      return info;
    } catch (error) {
      logger.error(`Failed to get group info for ${groupId}`, { sessionId, userId, error: error.message });
      if (error instanceof AppError) throw error;
      throw new AppError(`Failed to get group info: ${error.message}`, error.statusCode || 500, 'GROUP_INFO_FAILED');
    }
  }

  // =========================================================================
  // Create Group
  // =========================================================================

  async createGroup(sessionId, title, members = [], userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      throw new AppError('Group title is required', 400, 'MISSING_TITLE');
    }

    await validateSessionsOwnership([sessionId], userId);

    const tgService = telegramService;

    try {
      const result = await tgService.createGroup(sessionId, title.trim(), members);

      await pool.query(
        `INSERT INTO group_operations (
          user_id, session_id, target_group_id, operation, operation_type, total_count, total_users,
          options, created_at
        ) VALUES ($1, $2, $3, 'create_group', 'create_group', $4, $5, $6, NOW())
        RETURNING id`,
        [userId, sessionId, String(result.id || ''), (members || []).length, (members || []).length, JSON.stringify({ title: title.trim() })]
      );

      logger.info(`Created group "${title}" for user ${userId}`, { sessionId, groupId: result.id });

      return {
        id: result.id,
        title: title.trim(),
        groupId: String(result.id || ''),
        membersAdded: result.membersAdded || 0,
        createdAt: result.createdAt || new Date().toISOString(),
        accessHash: result.accessHash || null,
        username: result.username || null,
      };
    } catch (error) {
      logger.error(`Failed to create group "${title}"`, { sessionId, userId, error: error.message });
      if (error instanceof AppError) throw error;
      throw new AppError(`Failed to create group: ${error.message}`, error.statusCode || 500, 'CREATE_GROUP_FAILED');
    }
  }

  // =========================================================================
  // Get Operation Details
  // =========================================================================

  async getOperationDetails(opId, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    const result = await pool.query(
      `SELECT id, user_id, session_id, target_group_id, operation, operation_type, status,
              total_users, total_count, success_count, failed_count, options, user_list,
              created_at, completed_at
       FROM group_operations
       WHERE id = $1 AND user_id = $2`,
      [opId, userId]
    );

    if (result.rows.length === 0) {
      throw new AppError('Operation not found or access denied', 404, 'OPERATION_NOT_FOUND');
    }

    const row = result.rows[0];

    let redisProgress = null;
    let detailedResults = null;
    try {
      if (redisClient.isReady) {
        const progressKey = `group:add_progress:${opId}`;
        const progressData = await redisClient.get(progressKey);
        if (progressData) {
          redisProgress = JSON.parse(progressData);
        }
        const resultsKey = `group:results:${opId}`;
        const resultsRaw = await redisClient.get(resultsKey);
        if (resultsRaw) {
          try {
            detailedResults = JSON.parse(resultsRaw);
          } catch {
            detailedResults = null;
          }
        }
      }
    } catch {
      // Skip
    }

    let options = null;
    try {
      options = typeof row.options === 'string' ? JSON.parse(row.options) : row.options;
    } catch {
      options = row.options;
    }

    // The Redis blob stores every per-user attempt (both successes and
    // failures). The "View Errors" modal in the UI only renders the failures,
    // so we surface them as `errors`/`failed_users` (the two field names the
    // frontend already reads from). We also expose the raw `results` for any
    // future caller that wants the full picture.
    let errors = [];
    if (Array.isArray(detailedResults)) {
      errors = detailedResults
        .filter((r) => r && r.success === false)
        .map((r) => ({
          userId: r.userId,
          targetId: r.targetId,
          sessionId: r.sessionId,
          error: r.error || 'Unknown error',
        }));
    }

    return {
      id: row.id,
      operationType: row.operation_type || row.operation,
      groupId: row.target_group_id || row.group_id,
      status: row.status,
      totalUsers: row.total_users || row.total_count || 0,
      successCount: row.success_count || 0,
      failedCount: row.failed_count || 0,
      options,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      redisProgress,
      results: Array.isArray(detailedResults) ? detailedResults : [],
      errors,
      failed_users: errors,
    };
  }

  // =========================================================================
  // List Operations
  // =========================================================================

  async listOperations(userId, { page = 1, limit = 20, sort = 'created_at', order = 'DESC', filter } = {}) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    const validSortFields = ['created_at', 'completed_at', 'status', 'operation_type', 'operation', 'id'];
    const sortField = validSortFields.includes(sort) ? sort : 'created_at';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const offset = (page - 1) * limit;

    const queryConditions = ['user_id = $1'];
    const queryParams = [userId];
    let paramIndex = 2;

    if (filter && filter !== 'all') {
      queryConditions.push(`(operation_type = $${paramIndex} OR operation = $${paramIndex})`);
      queryParams.push(filter);
      paramIndex++;
    }

    const whereClause = queryConditions.join(' AND ');

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM group_operations WHERE ${whereClause}`,
      queryParams
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const opsResult = await pool.query(
      `SELECT id, user_id, session_id, target_group_id, operation, operation_type, status,
              total_users, total_count, success_count, failed_count, options,
              created_at, completed_at
       FROM group_operations
       WHERE ${whereClause}
       ORDER BY ${sortField} ${sortOrder}
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...queryParams, limit, offset]
    );

    const operations = opsResult.rows.map((row) => {
      let options = null;
      try {
        options = typeof row.options === 'string' ? JSON.parse(row.options) : row.options;
      } catch {
        options = row.options;
      }

      return {
        id: row.id,
        operationType: row.operation_type || row.operation,
        groupId: row.target_group_id,
        status: row.status,
        totalUsers: row.total_users || row.total_count || 0,
        successCount: row.success_count || 0,
        failedCount: row.failed_count || 0,
        options,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      };
    });

    const pagination = {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    };

    return { operations, pagination };
  }

  // =========================================================================
  // Remove Member
  // =========================================================================

  async removeMember(sessionId, groupId, userIdTarget, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    if (!userIdTarget) {
      throw new AppError('Target user ID is required', 400, 'MISSING_TARGET_USER_ID');
    }

    await validateSessionsOwnership([sessionId], userId);

    const tgService = telegramService;

    try {
      const result = await tgService.removeMember(sessionId, groupId, userIdTarget);

      await pool.query(
        `INSERT INTO group_operations (
          user_id, session_id, target_group_id, operation, operation_type, total_count, total_users,
          success_count, failed_count, options, created_at, completed_at
        ) VALUES ($1, $2, $3, 'remove_member', 'remove_member', 1, 1, 1, 0, $4, NOW(), NOW())
        RETURNING id`,
        [userId, sessionId, String(groupId), JSON.stringify({ targetUserId: String(userIdTarget) })]
      );

      logger.info(`Removed user ${userIdTarget} from group ${groupId}`, { sessionId, userId });
      return result;
    } catch (error) {
      logger.error(`Failed to remove user ${userIdTarget} from group ${groupId}`, { sessionId, userId, error: error.message });

      try {
        await pool.query(
          `INSERT INTO group_operations (
            user_id, session_id, target_group_id, operation, operation_type, total_count, total_users,
            success_count, failed_count, options, created_at, completed_at
          ) VALUES ($1, $2, $3, 'remove_member', 'remove_member', 1, 1, 0, 1, $4, NOW(), NOW())
          RETURNING id`,
          [userId, sessionId, String(groupId), JSON.stringify({ targetUserId: String(userIdTarget), error: error.message })]
        );
      } catch {
        // Ignore DB logging failure
      }

      if (error instanceof AppError) throw error;
      throw new AppError(`Failed to remove member: ${error.message}`, error.statusCode || 500, 'REMOVE_MEMBER_FAILED');
    }
  }

  // =========================================================================
  // Cancel Operation
  // =========================================================================

  async cancelOperation(opId, userId) {
    if (!userId) {
      throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    }

    const opResult = await pool.query(
      'SELECT id FROM group_operations WHERE id = $1 AND user_id = $2',
      [opId, userId]
    );

    if (opResult.rows.length === 0) {
      throw new AppError('Operation not found or access denied', 404, 'OPERATION_NOT_FOUND');
    }

    try {
      if (redisClient.isReady) {
        await redisClient.set(`group:cancel:${opId}`, '1', { EX: CANCEL_TTL });
      }
    } catch (err) {
      logger.error(`Failed to set cancel token for op ${opId}`, { error: err.message });
    }

    logger.info(`Cancel requested for operation ${opId} by user ${userId}`);

    return { success: true, opId: String(opId) };
  }

  // =========================================================================
  // Bulk Join / Leave Channels (Multi-Session, Multi-Target)
  // =========================================================================
  //
  // Both helpers run sessions in parallel with a small concurrency cap.
  // Each session contacts Telegram independently, so we don't need the
  // original 1s-per-pair sleep; the only throttle that matters is
  // *within* a single session when it touches multiple targets in
  // sequence. That's why we sleep between targets of the same session
  // (and only there).
  //
  // The caller (controller / queue worker) is responsible for creating
  // the `group_operations` row and passing `opId`. Progress updates and
  // final completion are written back via `updateProgress` +
  // `_finalizeOperation`, exactly like add-members. This means the
  // existing `getOperationDetails` endpoint and websocket events the
  // frontend already polls/listens to keep working with no schema
  // changes.

  async _runJoinLeaveBulk({
    opId,
    operationType, // 'join_channels' | 'leave_channels'
    sessionRows,   // [{ id, user_id, ... }]
    targetIds,
    userId,
    concurrency = 8,
    perTargetJitterMs = 750,
  }) {
    const tgService = telegramService;
    const isLeave = operationType === 'leave_channels';
    const totalPairs = sessionRows.length * targetIds.length;

    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    const results = [];

    const emitProgress = async () => {
      const processed = successCount + failedCount + skippedCount;
      await updateProgress(opId, {
        operation_id: opId,
        progress: processed,
        success: successCount,
        failed: failedCount,
        skipped: skippedCount,
        total: totalPairs,
        status: 'running',
      });
      try {
        if (global.io && userId) {
          global.io.to(`user:${userId}`).emit('group:progress', {
            opId,
            jobId: opId,
            progress: {
              processed,
              total: totalPairs,
              success: successCount,
              failed: failedCount,
              skipped: skippedCount,
            },
          });
        }
      } catch (_) {
        // ws unavailable
      }
    };

    // One async worker per parallel slot. Workers pull sessions off a
    // shared cursor so we never run more than `concurrency` sessions
    // at the same time, regardless of how many sessions were chosen.
    let cursor = 0;
    const runWorker = async () => {
      while (true) {
        if (await isCancelled(opId)) return;
        const i = cursor++;
        if (i >= sessionRows.length) return;
        const session = sessionRows[i];

        for (let t = 0; t < targetIds.length; t++) {
          if (await isCancelled(opId)) return;
          const targetId = targetIds[t];
          const result = {
            sessionId: session.id,
            targetId,
            success: false,
          };
          try {
            const opResult = isLeave
              ? await tgService.leaveChannel(session.id, targetId)
              : await tgService.joinChannel(session.id, targetId);
            result.success = opResult.success;
            if (opResult.targetName) result.targetName = opResult.targetName;
            if (opResult.skipped) {
              result.skipped = true;
              result.reason = opResult.reason;
              skippedCount++;
            } else {
              successCount++;
            }
          } catch (err) {
            result.error = err.message || String(err);
            failedCount++;
          }
          results.push(result);
          await emitProgress();

          // Only stagger between *targets within the same session* —
          // different sessions are already running in parallel.
          if (t < targetIds.length - 1) {
            await sleep(perTargetJitterMs);
          }
        }
      }
    };

    const workerCount = Math.max(1, Math.min(concurrency, sessionRows.length));
    const workers = Array.from({ length: workerCount }, () => runWorker());

    try {
      await Promise.all(workers);
    } catch (err) {
      logger.error(`Bulk ${operationType} fatal error op=${opId}: ${err.message}`);
    }

    const cancelled = await isCancelled(opId);
    const finalStatus = cancelled ? 'cancelled' : 'completed';

    await updateProgress(opId, {
      operation_id: opId,
      progress: successCount + failedCount + skippedCount,
      success: successCount,
      failed: failedCount,
      skipped: skippedCount,
      total: totalPairs,
      status: finalStatus,
    });
    await this._finalizeOperation(opId, finalStatus, successCount, failedCount, skippedCount, results);

    return {
      opId,
      total: totalPairs,
      success: successCount,
      failed: failedCount,
      skipped: skippedCount,
      results,
    };
  }

  /**
   * Insert a `group_operations` row for a join/leave bulk run and return
   * `{ opId, totalPairs }`. Done in the controller (synchronously,
   * before responding) so the client gets an immediate handle for
   * polling, even though the actual joins are still pending.
   */
  async createJoinLeaveOperationRow({ userId, operation, sessionRows, targetIds }) {
    const totalPairs = sessionRows.length * targetIds.length;
    const result = await pool.query(
      `INSERT INTO group_operations (
        user_id, session_id, target_group_id, operation, operation_type,
        total_count, total_users, status, options, created_at
      ) VALUES ($1, $2, $3, $4, $4, $5, $5, 'queued', $6, NOW())
      RETURNING id`,
      [
        userId,
        sessionRows[0].id,
        targetIds[0],
        operation, // 'join_channels' | 'leave_channels'
        totalPairs,
        JSON.stringify({
          sessionIds: sessionRows.map((s) => s.id),
          targetIds,
        }),
      ]
    );
    const opId = result.rows[0].id;
    await updateProgress(opId, {
      operation_id: opId,
      progress: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      total: totalPairs,
      status: 'queued',
    });
    return { opId, totalPairs };
  }

  /**
   * Insert a `group_operations` row for an add-members bulk run with
   * status 'queued'. The row is created in the controller so that the
   * async response can return an immediate opId for the UI to poll /
   * subscribe to. The worker (`type='add-members-bulk'`) flips the row
   * to 'running' inside `addMembersToGroups` once it picks up the job.
   *
   * @param {object} args
   * @param {number} args.userId
   * @param {Array<{id:number}>} args.sessionRows  validated session rows
   * @param {Array<string|number>} args.targetIds
   * @param {string} args.targetType
   * @param {Array<object>} args.userList
   * @param {object} args.options                  passthrough for storage
   * @returns {Promise<{opId: number, totalUsers: number}>}
   */
  async createAddMembersOperationRow({ userId, sessionRows, targetIds, targetType, userList, options }) {
    const totalUsers = Array.isArray(userList) ? userList.length : 0;
    const result = await pool.query(
      `INSERT INTO group_operations (
        user_id, session_id, target_group_id, operation, operation_type,
        total_count, total_users, status, user_list, options, created_at
      ) VALUES ($1, $2, $3, 'add_members', 'add_members', $4, $4, 'queued', $5, $6, NOW())
      RETURNING id`,
      [
        userId,
        sessionRows[0].id,
        targetIds[0],
        totalUsers,
        JSON.stringify(Array.isArray(userList) ? userList.slice(0, 100) : []),
        JSON.stringify({
          sessionIds: sessionRows.map((s) => s.id),
          targetIds,
          targetType: targetType || 'group',
          ...(options || {}),
        }),
      ]
    );
    const opId = result.rows[0].id;
    await updateProgress(opId, {
      operation_id: opId,
      progress: 0,
      added: 0,
      failed: 0,
      skipped: 0,
      total: totalUsers,
      status: 'queued',
    });
    return { opId, totalUsers };
  }

  /**
   * Public entry the BullMQ worker calls. Looks up sessions, then runs
   * the parallel join/leave loop. Caller passes the pre-existing opId
   * (created in the controller before responding) so progress/results
   * land on the right row.
   */
  async runJoinLeaveJob({ opId, operation, userId, sessionIds, targetIds }) {
    if (!opId) throw new AppError('opId is required', 400, 'MISSING_OP_ID');
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('sessionIds is required', 400, 'MISSING_SESSIONS');
    }
    if (!Array.isArray(targetIds) || targetIds.length === 0) {
      throw new AppError('targetIds is required', 400, 'MISSING_TARGETS');
    }

    const sessionRows = await validateSessionsOwnership(sessionIds, userId);
    if (sessionRows.length === 0) {
      await this._finalizeOperation(opId, 'failed', 0, 0, 0, []);
      throw new AppError('No valid sessions found for this user', 404, 'SESSION_NOT_FOUND');
    }

    // Mark running before the heavy loop so the UI flips off "queued".
    await pool.query(
      `UPDATE group_operations SET status = 'running' WHERE id = $1`,
      [opId]
    );
    await updateProgress(opId, {
      operation_id: opId,
      progress: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      total: sessionRows.length * targetIds.length,
      status: 'running',
    });

    return this._runJoinLeaveBulk({
      opId,
      operationType: operation,
      sessionRows,
      targetIds,
      userId,
    });
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  async _finalizeOperation(opId, status, successCount, failedCount, skippedCount, results) {
    try {
      // Store detailed results in Redis
      try {
        if (redisClient.isReady) {
          const resultsKey = `group:results:${opId}`;
          const truncatedResults = results.length > 500 ? results.slice(-500) : results;
          await redisClient.set(resultsKey, JSON.stringify(truncatedResults), { EX: PROGRESS_TTL });
        }
      } catch {
        // Skip
      }

      await pool.query(
        `UPDATE group_operations SET
          status = $1,
          success_count = $2,
          failed_count = $3,
          completed_at = NOW()
         WHERE id = $4`,
        [status, successCount, failedCount, opId]
      );
    } catch (err) {
      logger.error(`Failed to finalise operation ${opId}`, { error: err.message });
    }
  }

  _getInputPeer(entity) {
    const { Api } = require('telegram/tl');

    if (entity.className === 'User') {
      return new Api.InputPeerUser({ userId: entity.id, accessHash: entity.accessHash });
    }
    if (entity.className === 'Chat') {
      return new Api.InputPeerChat({ chatId: entity.id });
    }
    if (entity.className === 'Channel') {
      return new Api.InputPeerChannel({ channelId: entity.id, accessHash: entity.accessHash });
    }
    return entity;
  }
}

module.exports = new GroupService();
