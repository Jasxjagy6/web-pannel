const { pool } = require('../config/database');
const telegramService = require('./telegramService');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const { redisClient } = require('../config/redis');
const {
  normalizeTelegramTarget,
  collectTelegramTargetCandidates,
  getAccessHash,
  getPrimaryTelegramId,
} = require('../utils/telegramTargetNormalizer');
const distributionPlanner = require('./distributionPlanner');
const sessionCooldown = require('./sessionCooldown');
const { SessionResolverCache } = require('./sessionResolverCache');
const { run: runWorkerPool } = require('../utils/sessionWorkerPool');

/**
 * Default delay in milliseconds between batch operations.
 */
const DEFAULT_DELAY_MS = 3000;

/**
 * Hard ceiling Telegram empirically tolerates for
 * `channels.InviteToChannel` invites in a tight burst before it starts
 * marking sessions as PEER_FLOOD. Above ~4-5 invites per session per
 * burst, even a "warm" account starts drawing account-level spam
 * flags. This is the default for the new redesigned add-members
 * scheduler; operators can override via `params.maxPerSession`.
 */
const DEFAULT_MAX_ADDS_PER_SESSION = 4;

/**
 * `lists.source` prefixes that mean "the operator uploaded this list".
 * Uploaded lists are deduplicated before the run so we never burn an
 * invite request on the same target twice. Scraped lists (`source =
 * 'job_<scrape_id>'`) skip dedup because the panel scraper already
 * emits one row per user.
 */
const UPLOADED_LIST_SOURCE_PREFIXES = ['import_', 'manual_', 'merge_'];

/**
 * Heuristic match for "this list looks uploaded, dedup it" used when
 * we have a `source` string but it doesn't match a well-known prefix.
 * Anything starting with `job_` or `scrape_` is treated as scraped.
 */
function isUploadedListSource(source) {
  if (!source) return true;
  const s = String(source).toLowerCase();
  if (s.startsWith('job_')) return false;
  if (s.startsWith('scrape_')) return false;
  if (s.startsWith('scraped_')) return false;
  return UPLOADED_LIST_SOURCE_PREFIXES.some((p) => s.startsWith(p)) ||
    s === 'manual' || s === 'manual_input';
}

/**
 * Build a stable canonical key for a userList entry. The first non-empty
 * identifier wins (numeric id > username > phone) so two rows that
 * disagree on, say, casing of the username still collapse to one.
 *
 * Returns `null` for entries with no usable identifier — those rows
 * are kept as-is and surfaced as `unaddressable` later in the pipeline.
 */
function dedupKeyForEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    if (entry == null) return null;
    const s = String(entry).trim();
    if (!s) return null;
    if (/^\d{4,}$/.test(s)) return `id:${s}`;
    return `u:${s.replace(/^@+/, '').toLowerCase()}`;
  }
  const tgId = entry.telegram_id ?? entry.telegramId ?? entry.id;
  if (tgId != null) {
    const s = String(tgId).trim();
    if (s && /^\d+$/.test(s)) return `id:${s}`;
  }
  const uname = entry.username;
  if (uname != null) {
    const s = String(uname).trim().replace(/^@+/, '');
    // Numeric "usernames" are scrape artifacts and aren't valid
    // Telegram handles — collapse them with their numeric-id sibling
    // by reusing the `id:` namespace so they don't double-count.
    if (s) {
      if (/^\d+$/.test(s)) return `id:${s}`;
      return `u:${s.toLowerCase()}`;
    }
  }
  const phone = entry.phone;
  if (phone != null) {
    const s = String(phone).trim().replace(/[^+\d]/g, '');
    if (s) return `p:${s}`;
  }
  return null;
}

/**
 * Dedup an uploaded userList in-memory, preserving order. Returns the
 * deduped list along with a count of rows dropped. Rows with no
 * identifier are passed through untouched so the existing
 * `unaddressable` handling still surfaces them.
 *
 * Pure / side-effect-free.
 */
function dedupUploadedUserList(userList) {
  if (!Array.isArray(userList)) return { deduped: [], dropped: 0 };
  const seen = new Set();
  const deduped = [];
  let dropped = 0;
  for (const entry of userList) {
    const key = dedupKeyForEntry(entry);
    if (key == null) {
      // Keep the row; the downstream pipeline will mark it
      // unaddressable and report it on the op result.
      deduped.push(entry);
      continue;
    }
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return { deduped, dropped };
}

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
      // Hard per-session-per-burst ceiling. Defaults to
      // `DEFAULT_MAX_ADDS_PER_SESSION` (4) — the empirical Telegram-safe
      // value above which sessions start drawing PEER_FLOOD. The
      // planner will clamp `perSessionBurst` to this value regardless
      // of what auto-mode would otherwise pick.
      maxPerSession,
      // Optional source list id — when set the audience filter
      // persists status back into list_items and purges NOT_FOUND
      // rows from the list. Also drives source-aware deduplication
      // (uploaded lists are deduped, scraped lists pass through).
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

    // Helper: flip the op row to a terminal state and emit a
    // websocket event so the Operation History panel doesn't show a
    // stale `queued`/`running` row. Best-effort; never throws.
    const markPreflightFailure = async (status, message) => {
      if (!existingOpId) return;
      const trimmed = message ? String(message).slice(0, 500) : null;
      try {
        // The `group_operations` table has no dedicated error column,
        // so we stash the message into `options.error` (JSONB merge)
        // alongside the status flip + completed_at. JSONB `||`
        // shallow-merges keys.
        await pool.query(
          `UPDATE group_operations
              SET status       = $2,
                  options      = COALESCE(options, '{}'::jsonb) || $3::jsonb,
                  completed_at = NOW()
            WHERE id = $1`,
          [
            existingOpId,
            status,
            JSON.stringify({ error: trimmed, error_status: status }),
          ]
        );
      } catch (uErr) {
        logger.warn(`addMembersToGroups: could not mark op ${existingOpId} as ${status}: ${uErr.message}`);
      }
      try {
        await updateProgress(existingOpId, {
          operation_id: existingOpId,
          status,
          error: message ? String(message).slice(0, 500) : null,
        });
      } catch (_) {
        // redis unavailable
      }
      try {
        if (global.io && userId) {
          global.io.to(`user:${userId}`).emit('group:failed', {
            opId: existingOpId,
            jobId: existingOpId,
            error: message,
            status,
          });
        }
      } catch (_) {
        // ws unavailable
      }
    };

    // Persist current run counts to the DB so the 10s frontend poll
    // (and the `group_operations` JOINs surfaced elsewhere) reflect
    // live progress. We rate-limit DB writes to ~1 per second per op
    // because `INSERT ... INTO group_operations` is heavier than the
    // websocket fan-out and this loop fires after *every* user
    // attempt.
    let lastRunningPersistAt = 0;
    const persistRunningProgress = async (counts, { force = false } = {}) => {
      if (!existingOpId) return;
      const now = Date.now();
      if (!force && now - lastRunningPersistAt < 1000) return;
      lastRunningPersistAt = now;
      try {
        await pool.query(
          `UPDATE group_operations
              SET status        = 'running',
                  success_count = $2,
                  failed_count  = $3,
                  options       = COALESCE(options, '{}'::jsonb) || $4::jsonb
            WHERE id = $1
              AND status NOT IN ('completed', 'failed', 'cancelled')`,
          [
            existingOpId,
            counts.added || 0,
            counts.failed || 0,
            JSON.stringify({
              skipped_count: counts.skipped || 0,
              processed_count: counts.processed || 0,
              last_progress_at: new Date().toISOString(),
            }),
          ]
        );
      } catch (uErr) {
        logger.warn(`persistRunningProgress: ${uErr.message}`);
      }
    };

    // Emit a `group:progress` websocket event after every per-user
    // attempt so the Operation History panel updates in real time
    // instead of waiting for the final `_finalizeOperation` call.
    // Best-effort — never throws and never blocks the worker on a
    // missing socket / Redis client.
    const emitItemProgress = async (counts) => {
      if (!existingOpId) return;
      try {
        await updateProgress(existingOpId, {
          operation_id: existingOpId,
          status: 'running',
          ...counts,
        });
      } catch (_) {
        // redis unavailable
      }
      try {
        if (global.io && userId) {
          global.io.to(`user:${userId}`).emit('group:progress', {
            opId: existingOpId,
            jobId: existingOpId,
            progress: { status: 'running', ...counts },
          });
        }
      } catch (_) {
        // ws unavailable
      }
      // Throttled DB write so the poll-based fallback also stays fresh.
      await persistRunningProgress(counts);
    };

    // Helper: emit an intermediate 'filtering' / 'validating' phase to
    // the op row + websocket so the Operations UI displays what the
    // worker is doing right now (instead of leaving the row stuck on
    // `queued` for the entire pre-flight).
    const markPhase = async (phase, extra = {}) => {
      if (!existingOpId) return;
      try {
        await pool.query(
          `UPDATE group_operations SET status = $2 WHERE id = $1`,
          [existingOpId, phase]
        );
      } catch (uErr) {
        logger.warn(`addMembersToGroups: could not mark op ${existingOpId} as ${phase}: ${uErr.message}`);
      }
      try {
        await updateProgress(existingOpId, {
          operation_id: existingOpId,
          status: phase,
          ...extra,
        });
      } catch (_) {
        // redis unavailable
      }
      try {
        if (global.io && userId) {
          global.io.to(`user:${userId}`).emit('group:progress', {
            opId: existingOpId,
            jobId: existingOpId,
            progress: { status: phase, ...extra },
          });
        }
      } catch (_) {
        // ws unavailable
      }
    };

    // No pre-job audience filtering: every row in `userList` is
    // attempted directly against Telegram. Per the operator's
    // verbatim "remove the filtering users system completly" rule,
    // we never drop rows for "looks dead / not_found /
    // privacy-restricted" classifications. Real Telegram errors
    // during the add still surface per-row in the results.
    let preparedUsers = [];
    let unaddressable = [];
    let verifiedSessions;
    let dedupStats = { applied: false, before: 0, after: 0, dropped: 0, source: null };
    try {
      // -----------------------------------------------------------------
      // Source-aware deduplication (run BEFORE the audience filter so
      // we don't waste filter probes on rows that are about to be
      // collapsed). Uploaded / manual / merged lists get deduped by
      // canonical key; scraped lists (`source = 'job_<id>'`) skip
      // dedup so the panel's own scrape output is never altered.
      //
      // Operator quote, verbatim: "duplicates id from the list must
      // be filtered out before starting the actual job (the lists
      // that were obtained by scrapping users though pannel must not
      // be fitered. Only uploaded lists must be filtered)."
      // -----------------------------------------------------------------
      let listSource = null;
      if (listId != null) {
        try {
          const listLookup = await pool.query(
            'SELECT source FROM lists WHERE id = $1 AND user_id = $2 LIMIT 1',
            [listId, userId]
          );
          if (listLookup.rows.length > 0) {
            listSource = listLookup.rows[0].source || null;
          }
        } catch (srcErr) {
          logger.warn(
            `addMembersToGroups: lists.source lookup failed for list ${listId}: ${srcErr.message}`
          );
        }
      }
      // No `listId` ⇒ manual input from the Groups page; treat as
      // uploaded (always dedup). Otherwise consult the prefix
      // heuristic — `job_*` / `scrape_*` are skipped, everything else
      // is treated as uploaded.
      const shouldDedup = listId == null ? true : isUploadedListSource(listSource);
      dedupStats = {
        applied: false,
        before: Array.isArray(userList) ? userList.length : 0,
        after: Array.isArray(userList) ? userList.length : 0,
        dropped: 0,
        source: listSource,
        listId: listId != null ? Number(listId) : null,
      };
      if (shouldDedup && Array.isArray(userList) && userList.length > 1) {
        const { deduped, dropped } = dedupUploadedUserList(userList);
        if (dropped > 0) {
          logger.info(
            `addMembersToGroups: deduped ${dropped} duplicate row(s) from ${dedupStats.before} → ${deduped.length}`,
            { userId, listId, source: listSource }
          );
        }
        userList = deduped;
        dedupStats.applied = true;
        dedupStats.after = deduped.length;
        dedupStats.dropped = dropped;
      } else if (!shouldDedup) {
        logger.info(
          `addMembersToGroups: skipping dedup for scraped list (source=${listSource})`,
          { userId, listId }
        );
      }

      // No pre-job audience filtering. Per the operator's verbatim
      // "remove the filtering users system completly … the pannel
      // should try to send messages, add members or whatever task
      // is given without skipping or filtering anything" rule, we
      // do not pre-classify rows as not_found / privacy_restricted
      // / dead. The runner attempts each row directly and surfaces
      // real Telegram errors per-row in the results.

      if (!userList || userList.length === 0) {
        // We only get here if the input list itself was empty — which
        // is already validated by the controller. Keep the throw as a
        // defensive guard but with a non-misleading message.
        throw new AppError(
          'No users to process: the input list is empty.',
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
      for (const entry of userList) {
        const candidates = collectTelegramTargetCandidates(entry);
        if (candidates.length > 0) {
          // The frontend ships `access_hash` alongside `telegram_id`
          // when the row was scraped. Pass it through so
          // `addMemberToGroup` can build an `InputUser` directly for
          // numeric-id candidates without a separate resolution step.
          const accessHash = getAccessHash(entry);
          const primaryNumericId = getPrimaryTelegramId(entry);
          preparedUsers.push({
            entry,
            identifier: candidates[0],
            candidates,
            accessHash,
            numericId: primaryNumericId,
          });
        } else {
          unaddressable.push(entry);
        }
      }

      // Opportunistic access_hash backfill: when the row arrived via a
      // CSV import (or any path that didn't preserve `access_hash`),
      // there's still a good chance THIS account has seen the user
      // before via a previous scrape on the panel. Look those up from
      // `scraped_users` in a single batched query so numeric-id-only
      // rows can still build a valid `InputUser`. Without this, every
      // import of a fresh CSV with bare numeric IDs would silently
      // fail with "Could not find the input entity".
      const missingHashIds = [];
      const preparedByNumericId = new Map();
      for (const p of preparedUsers) {
        if (!p.accessHash && p.numericId) {
          missingHashIds.push(String(p.numericId));
          if (!preparedByNumericId.has(String(p.numericId))) {
            preparedByNumericId.set(String(p.numericId), []);
          }
          preparedByNumericId.get(String(p.numericId)).push(p);
        }
      }
      if (missingHashIds.length > 0) {
        try {
          // pick the most recent non-null hash per telegram_id
          const lookup = await pool.query(
            `SELECT DISTINCT ON (telegram_id) telegram_id, access_hash
               FROM scraped_users
              WHERE access_hash IS NOT NULL
                AND telegram_id::text = ANY($1::text[])
              ORDER BY telegram_id, scraped_at DESC NULLS LAST`,
            [missingHashIds]
          );
          let backfilled = 0;
          for (const row of lookup.rows) {
            const tgId = String(row.telegram_id);
            const hash = row.access_hash != null ? String(row.access_hash) : null;
            if (!hash) continue;
            const targets = preparedByNumericId.get(tgId);
            if (!targets) continue;
            for (const t of targets) {
              t.accessHash = hash;
              backfilled++;
            }
          }
          if (backfilled > 0) {
            logger.info(
              `addMembersToGroups: backfilled ${backfilled} access_hash values from scraped_users for imported list rows`,
              { userId, missingBefore: missingHashIds.length }
            );
          }
        } catch (lookupErr) {
          logger.warn('access_hash backfill from scraped_users failed; continuing without it', {
            error: lookupErr && lookupErr.message,
          });
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

      // Move into the 'validating sessions' phase before we touch the DB
      // for ownership/cooldown — gives the UI a clear state-change.
      await markPhase('validating', {
        total: preparedUsers.length,
        eligible: preparedUsers.length,
      });

      // Verify session ownership (also drops cooldown sessions; throws
      // ALL_SESSIONS_ON_COOLDOWN when nothing usable is left).
      verifiedSessions = await validateSessionsOwnership(sessionIds, userId);
    } catch (preflightErr) {
      // Persist a terminal status on the queued op row so the
      // Operation History panel doesn't show a stale spinner. Then
      // re-throw so BullMQ marks the job failed.
      await markPreflightFailure('failed', preflightErr.message);
      throw preflightErr;
    }
    if (!verifiedSessions || verifiedSessions.length === 0) {
      await markPreflightFailure('failed', 'No valid sessions found');
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
    // Resolve the hard per-session-per-burst cap. Operators may
    // override via `maxPerSession`; otherwise we apply the
    // institutional default (4) which keeps sessions well below the
    // PEER_FLOOD trigger empirically observed for
    // `channels.InviteToChannel`.
    const effectiveMaxPerSession = (() => {
      const raw = Number(maxPerSession);
      if (Number.isFinite(raw) && raw > 0) {
        return Math.min(50, Math.max(1, Math.floor(raw)));
      }
      return DEFAULT_MAX_ADDS_PER_SESSION;
    })();

    const planParams = {
      totalItems: preparedUsers.length,
      sessionIds: verifiedSessions.map((s) => s.id),
      workType: 'group_add',
      mode,
      perSessionBurst: perSessionBurst != null
        ? perSessionBurst
        : (mode === 'manual' ? batchSize : undefined),
      // Hard ceiling — the planner clamps the chosen burst to this
      // value across all auto-mode bands, so even a wildly overshot
      // operator override can't push a session into PEER_FLOOD
      // territory in one rotation.
      maxPerSessionBurst: effectiveMaxPerSession,
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
        dedup: {
          applied: dedupStats.applied,
          before: dedupStats.before,
          after: dedupStats.after,
          dropped: dedupStats.dropped,
          source: dedupStats.source,
        },
        plan: {
          mode: plan.mode,
          perSessionBurst: plan.perSessionBurst,
          maxPerSession: plan.maxPerSessionBurst,
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

    // ===================================================================
    // V2 parallel worker-pool runner.
    // ===================================================================
    const RUNNER_V2_ENABLED = (process.env.RUNNER_V2_ENABLED || 'true').toLowerCase() !== 'false';
    if (RUNNER_V2_ENABLED) {
      return this._runAddMembersV2({
        opId,
        userId,
        userList,
        preparedUsers,
        unaddressable,
        targetIds,
        targetType,
        verifiedSessions,
        plan,
        dedupStats,
        existingOpId,
        addedCount,
        failedCount,
        skippedCount,
        results,
        emitItemProgress,
        persistRunningProgress,
        markPhase,
        markPreflightFailure,
        params,
      });
    }

    try {
      // -----------------------------------------------------------------
      // NOTE: We deliberately do NOT pre-check session membership in
      // each target before the runner starts.
      //
      // The previous implementation called `_resolveEntity(session, target)`
      // for every (session × target) pair before the first invite, which
      // for an N×M fleet emitted N*M `getDialogs` / `messages.getFullChat`
      // round-trips. Telegram counts those toward the same per-account
      // rate budget that drives PEER_FLOOD, so the pre-check was directly
      // contributing to the failure mode it was supposed to prevent.
      //
      // Operator quote, verbatim: "I think currently system firstly check
      // whether session is a member of group or not and that is extra
      // request which is causing telegram peer flood limits. So it must
      // not check just start the job if it's fails move to next session
      // with next I'd or username."
      //
      // We replace the pre-check with a lazy `brokenSessionTargets`
      // denylist: when a session's first invite to a given target fails
      // with a *target-side* error (CHANNEL_PRIVATE / CHAT_INVALID / not
      // a member / not enough rights / "could not resolve group"), we
      // mark `${session.id}:${targetId}` as broken and skip every
      // remaining user in the burst for that pair. The runner moves on
      // to the next session for the same target without making further
      // failed round-trips. User-side errors (PRIVACY_RESTRICT,
      // USER_DEACTIVATED, etc.) keep their existing in-job skip
      // behaviour so other sessions don't re-burn requests on doomed
      // users.
      // -----------------------------------------------------------------
      const brokenSessionTargets = new Set(); // `${sessionId}:${targetId}`

      // Patterns that indicate the failure was on the **target/group**
      // side rather than the **user** side — i.e. this session simply
      // cannot operate against this target, so we should switch to the
      // next session instead of trying the next user.
      const isTargetSideFailure = (msg) => {
        if (!msg) return false;
        const m = String(msg);
        return (
          m.includes('CHAT_ADMIN_REQUIRED') ||
          m.includes('CHAT_WRITE_FORBIDDEN') ||
          m.includes('CHANNEL_PRIVATE') ||
          m.includes('CHANNEL_INVALID') ||
          m.includes('CHAT_INVALID') ||
          m.includes('CHAT_FORBIDDEN') ||
          m.includes('Could not resolve group') ||
          m.includes('USER_NOT_PARTICIPANT') ||
          m.includes('CHAT_GUEST_SEND_FORBIDDEN')
        );
      };

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

      // ---------------------------------------------------------------
      // In-job "skip these users" registry.
      //
      // Once any session in this job sees that user X is privacy-restricted
      // (USER_PRIVACY_RESTRICT, USER_NOT_MUTUAL_CONTACT, USER_CHANNELS_TOO_MUCH)
      // or non-existent (USERNAME_INVALID, USER_DEACTIVATED, USER_ID_INVALID,
      // ...), every other session that later reaches the same prepared
      // entry will short-circuit instead of making another doomed
      // contacts.ResolveUsername / channels.InviteToChannel round-trip.
      //
      // No cross-session user skip cache. Per the operator's rule
      // "no session should skip the job unless session is not
      // active", we never block one session from attempting a user
      // just because another session in the same job hit
      // USER_PRIVACY_RESTRICT / USERNAME_NOT_OCCUPIED / etc. on
      // that user. Telegram answers can vary between accounts
      // (cold sessions can fail to resolve a username that warm
      // sessions resolve fine). We trust real per-attempt errors
      // and surface them per-row in `results` instead of
      // pre-empting siblings.

      for (let tIdx = 0; tIdx < targetIds.length; tIdx++) {
        const targetId = targetIds[tIdx];

        // No pre-check: the runner uses every verified, non-cooldown
        // session and discovers target accessibility lazily. Sessions
        // that fail with a target-side error are added to
        // `brokenSessionTargets` mid-burst and skipped on the next pass.
        const availableSessions = verifiedSessions.slice();

        const burst = plan.perSessionBurst;
        const sessionsForRotation = availableSessions.map((s) => s.id);

        // Per-target work queue. Starts as the full prepared-users list
        // and is refilled with users that need to be retried on a
        // different session when one is marked broken mid-burst. Each
        // pass through the outer `while` is a self-contained rotation
        // over the queue with whatever sessions are still live for
        // this target. Capped at `MAX_FAILOVER_PASSES` so we don't
        // loop forever if every session ends up broken.
        let pendingForTarget = preparedUsers.slice();
        let failoverPass = 0;
        const MAX_FAILOVER_PASSES = 4;

        while (pendingForTarget.length > 0 && failoverPass < MAX_FAILOVER_PASSES) {
          failoverPass++;

          // Sessions that can still try this target. Strict filter:
          // not on PEER_FLOOD, not marked broken for this specific
          // target.
          const liveSessions = availableSessions.filter(
            (s) =>
              !peerFloodSessions.has(s.id) &&
              !brokenSessionTargets.has(`${s.id}:${targetId}`)
          );
          if (liveSessions.length === 0) {
            // Every session has either burned out or been marked
            // broken for this target. Mark the rest of the queue as
            // skipped — there's literally nothing left to try.
            for (const prepared of pendingForTarget) {
              results.push({
                userId: prepared.identifier,
                targetId,
                success: false,
                error:
                  'No live session can access this target (all sessions failed target-side or are on PEER_FLOOD)',
                skipped: true,
              });
              skippedCount++;
            }
            pendingForTarget = [];
            break;
          }

          // Snapshot the queue for THIS pass; failed users (target-side)
          // get pushed to `nextPending` and become the queue for the
          // next pass.
          const queueThisPass = pendingForTarget;
          const nextPending = [];

          // Total rounds for THIS pass (depends on # live sessions).
          const itemsPerRound = liveSessions.length * burst;
          const targetRounds = Math.max(
            1,
            Math.ceil(queueThisPass.length / itemsPerRound)
          );

        for (let round = 0; round < targetRounds; round++) {
          for (let sIdx = 0; sIdx < liveSessions.length; sIdx++) {
            const session = liveSessions[sIdx];
            if (peerFloodSessions.has(session.id)) continue; // skip dead sessions
            if (brokenSessionTargets.has(`${session.id}:${targetId}`)) continue;

            const start = round * itemsPerRound + sIdx * burst;
            const usersChunk = queueThisPass.slice(start, start + burst);
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
            let burstHitTargetSideFailure = false;
            let targetSideFailureChunkIdx = -1;
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

              // No cross-session short-circuit. Per the operator's
              // rule "no session should skip the job unless session
              // is not active", every session attempts every user
              // for the current target — even if a sibling session
              // in this job already failed on this user. Real
              // per-attempt errors get recorded in `results` and
              // shown in the History tab.

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
                // Pair the cached access_hash with the numeric-id
                // candidate only — applying it to a `@username` or
                // `+phone` would just confuse the resolver.
                const candidateOptions =
                  prepared.accessHash &&
                  prepared.numericId &&
                  String(userTelegramId) === String(prepared.numericId)
                    ? { accessHash: prepared.accessHash }
                    : undefined;
                try {
                  await tgService.addMemberToGroup(
                    session.id,
                    targetId,
                    userTelegramId,
                    candidateOptions
                  );
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
                  // likely the original numeric id), and re-attach the
                  // access_hash hint when retrying that numeric id so
                  // we don't lose the hash across the FLOOD_WAIT pause.
                  const retryIdent = candidates[candidates.length - 1];
                  const retryOptions =
                    prepared.accessHash &&
                    prepared.numericId &&
                    String(retryIdent) === String(prepared.numericId)
                      ? { accessHash: prepared.accessHash }
                      : undefined;
                  let retrySuccess = false;
                  let retryAttempts = 0;
                  while (!retrySuccess && retryAttempts < MAX_FLOOD_RETRIES) {
                    try {
                      await tgService.addMemberToGroup(session.id, targetId, retryIdent, retryOptions);
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
                  errMsg.includes('USER_CHANNELS_TOO_MUCH') ||
                  errMsg.includes('Telegram dropped invite (privacy/restricted)')
                ) {
                  userResult.error = 'Privacy settings prevent adding';
                  userResult.skipped = true;
                  skippedCount++;
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
                // Target-side failure — this session simply can't
                // operate against this target (admin missing, channel
                // private, not a participant, group resolution failed).
                // The same answer applies to every user in the burst,
                // so we mark `(session, target)` broken in
                // `brokenSessionTargets`, fail over the remaining users
                // in the burst (including this one) to a different
                // session in the next pass, and stop probing this
                // target with this session for the rest of the job.
                //
                // We deliberately do NOT push `userResult` for this
                // user — the retry on a different session will produce
                // the canonical result. We also do NOT increment
                // `failedCount` here for the same reason.
                else if (isTargetSideFailure(errMsg)) {
                  brokenSessionTargets.add(`${session.id}:${targetId}`);
                  burstHitTargetSideFailure = true;
                  targetSideFailureChunkIdx = chunkIdx;
                  logger.warn(
                    `Target-side failure: session ${session.id} → ${targetId} marked broken (${errMsg}); failing over ${usersChunk.length - chunkIdx} user(s) to next session`,
                    { opId }
                  );
                  break;
                }
                // Handle user banned in channel after the broader
                // target-side check above so we still detect bans.
                // Handle user banned or restricted
                else if (errMsg.includes('USER_BANNED_IN_CHANNEL') || errMsg.includes('USER_RESTRICTED')) {
                  userResult.error = 'User is banned or restricted';
                  failedCount++;
                }
                // CHAT_MEMBER_ADD_FAILED is Telegram's catch-all "I won't
                // tell you why" refusal. Two common causes:
                //   * Target's privacy is "Premium users only" — looks
                //     like privacy-restrict from the outside.
                //   * The inviting session has been silently flagged
                //     after recent invites — same user might succeed
                //     from a warmer session next time.
                // Don't poison the audience cache with this (we can't
                // tell which cause), but skip the user for the rest of
                // *this* job so other sessions don't burn invites on
                // the same target with the same outcome. Counts as
                // skipped, not failed, since it's not the user's fault.
                else if (
                  errMsg.includes('CHAT_MEMBER_ADD_FAILED') ||
                  // The friendly message we mapped CHAT_MEMBER_ADD_FAILED to.
                  errMsg.includes('Telegram refused to add this user')
                ) {
                  userResult.error =
                    'Telegram refused (CHAT_MEMBER_ADD_FAILED) — likely Premium-only privacy or a quietly-flagged session';
                  userResult.skipped = true;
                  skippedCount++;
                }
                // Handle user not found / deactivated / unresolvable
                // username → cache as `not_found` so the next job skips
                // them entirely. The audience filter's HTTP probe can't
                // distinguish "user vs. channel/bot/group handle" from
                // the t.me homepage, so handles like @SomeChannel pass
                // the probe but blow up on contacts.ResolveUsername at
                // run time. Recording these here is what makes the
                // next run actually drop them.
                else if (
                  errMsg.includes('USER_DEACTIVATED') ||
                  errMsg.includes('INPUT_USER_DEACTIVATED') ||
                  errMsg.includes('USER_NOT_FOUND') ||
                  errMsg.includes('USERNAME_NOT_OCCUPIED') ||
                  errMsg.includes('USER_ID_INVALID') ||
                  errMsg.includes('USERNAME_INVALID') ||
                  // The wrapped error string emitted by telegramService
                  // when every candidate in the chain fails resolution.
                  errMsg.includes('Could not resolve user') ||
                  // GramJS' message when contacts.ResolveUsername returns
                  // an empty result for an existing-but-non-user handle.
                  /No user has\s+"/i.test(errMsg)
                ) {
                  userResult.error = errMsg;
                  failedCount++;
                }
                // Generic failure
                else {
                  userResult.error = errMsg;
                  failedCount++;
                }
              }

              results.push(userResult);

              // Real-time progress: emit a `group:progress` websocket
              // event after every per-user attempt so the Operation
              // History panel updates live (instead of waiting for
              // `_finalizeOperation`). Throttled DB writes inside
              // `emitItemProgress` keep the polling fallback fresh too.
              const liveProcessed = addedCount + failedCount + skippedCount;
              await emitItemProgress({
                progress: liveProcessed,
                processed: liveProcessed,
                added: addedCount,
                failed: failedCount,
                skipped: skippedCount,
                total: userList.length * targetIds.length,
                currentTarget: targetId,
                currentSession: session.id,
                currentRound: round + 1,
                totalRounds: targetRounds,
                lastUser: {
                  id: userResult.userId,
                  success: userResult.success === true,
                  skipped: userResult.skipped === true,
                  error: userResult.error || null,
                },
              });

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

            // Re-queue any users in this burst that were affected by a
            // target-side failure. The user that triggered the bail
            // (at `targetSideFailureChunkIdx`) and every unattempted
            // user after it both go onto `nextPending` so a different
            // session in the next pass can take a swing.
            if (burstHitTargetSideFailure && targetSideFailureChunkIdx >= 0) {
              for (let r = targetSideFailureChunkIdx; r < usersChunk.length; r++) {
                nextPending.push(usersChunk[r]);
              }
            }

            // Update progress (Redis snapshot for the burst). Per-user
            // socket fan-out + DB writes happen inside `emitItemProgress`
            // above; this is the burst-summary that drives the Redis
            // poll endpoint.
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
            await persistRunningProgress(
              {
                progress: processed,
                added: addedCount,
                failed: failedCount,
                skipped: skippedCount,
              },
              { force: true }
            );
          }
          } // end (round, session) block

          // Cooldown between rotations (skip after the last round and
          // when no cooldown was configured). `roundLiveSessions`
          // re-filters at this point because PEER_FLOOD may have
          // fired during the round we just finished.
          const roundLiveSessions = liveSessions.filter(
            (s) =>
              !peerFloodSessions.has(s.id) &&
              !brokenSessionTargets.has(`${s.id}:${targetId}`)
          );
          if (
            round < targetRounds - 1 &&
            roundLiveSessions.length > 0 &&
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
              `Cooldown between rotations: ${cooldownSec.toFixed(0)}s (target=${targetId}, pass=${failoverPass}, round=${round + 1}/${targetRounds})`,
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

          // End of this fail-over pass. Roll any users that need to be
          // retried on a different session into `pendingForTarget` so
          // the next iteration of the outer while picks them up.
          pendingForTarget = nextPending;
          if (pendingForTarget.length > 0) {
            logger.info(
              `Fail-over pass ${failoverPass} for target ${targetId}: ${pendingForTarget.length} user(s) need retry on a different session`,
              { opId }
            );
          }
        } // end while (pendingForTarget.length > 0 && failoverPass < MAX)
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
        // Source-aware dedup stats so the UI can surface "X dupes
        // removed before the run started" without re-running the
        // dedup pass on the response.
        dedup: {
          applied: dedupStats.applied,
          before: dedupStats.before,
          after: dedupStats.after,
          dropped: dedupStats.dropped,
          source: dedupStats.source,
          listId: dedupStats.listId,
        },
        // Distribution-plan summary so the UI can show the operator
        // exactly which knobs the planner picked, including the new
        // hard per-session cap.
        plan: {
          mode: plan.mode,
          perSessionBurst: plan.perSessionBurst,
          maxPerSession: plan.maxPerSessionBurst,
          rounds: plan.rounds,
          cooldownSec: [plan.cooldownSecMin, plan.cooldownSecMax],
          itemDelayMs: [plan.itemDelayMsMin, plan.itemDelayMsMax],
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
      'SELECT id, status FROM group_operations WHERE id = $1 AND user_id = $2',
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

    // If the runner hasn't entered the loop yet (e.g. still 'queued',
    // 'filtering', or 'validating'), the next `isCancelled(opId)` check
    // won't fire until it gets there — by which point the audience
    // filter / session validation already wasted work. Flip the row
    // synchronously so the UI shows the cancel as soon as it's
    // requested. The runner's own terminal handlers are idempotent
    // (status guard in the worker.failed backstop too) so this is safe.
    const currentStatus = opResult.rows[0].status;
    if (['queued', 'pending', 'filtering', 'validating'].includes(currentStatus)) {
      try {
        await pool.query(
          `UPDATE group_operations
              SET status       = 'cancelled',
                  completed_at = NOW()
            WHERE id = $1
              AND status NOT IN ('completed', 'failed', 'cancelled')`,
          [opId]
        );
      } catch (uErr) {
        logger.warn(`cancelOperation: could not eagerly mark op ${opId} cancelled: ${uErr.message}`);
      }
      try {
        if (global.io) {
          global.io.to(`user:${userId}`).emit('group:failed', {
            opId,
            jobId: opId,
            error: 'cancelled',
            status: 'cancelled',
          });
        }
      } catch (_) {
        // ws unavailable
      }
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
  // V2 Parallel Worker-Pool Runner (add-members)
  // =========================================================================

  /**
   * Parallel add-members runner. Replaces the legacy sequential-session
   * rotation loop with the `sessionWorkerPool` + `SessionResolverCache`.
   *
   * Preserves all UI contracts: websocket `group:progress` events,
   * Redis progress snapshots, per-row `results` array, DB finalization
   * via `_finalizeOperation`.
   *
   * @private
   */
  async _runAddMembersV2(ctx) {
    const {
      opId,
      userId,
      userList,
      preparedUsers,
      targetIds,
      verifiedSessions,
      plan,
      dedupStats,
      results,
      emitItemProgress,
      persistRunningProgress,
      markPhase,
      params,
    } = ctx;

    let { addedCount, failedCount, skippedCount } = ctx;

    const tgService = telegramService;
    const PRIVACY_QUORUM = Math.max(1, parseInt(process.env.PRIVACY_QUORUM || '1', 10));
    const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT_SESSIONS || '200', 10));

    // Source channel IDs for the resolver cache (enables auth_key-correct
    // access_hash resolution via channels.GetParticipant).
    const sourceChannelIds = Array.isArray(params.sourceChannelIds)
      ? params.sourceChannelIds
      : (params.sourceChannelId ? [params.sourceChannelId] : []);

    // Pre-warm sessions before we start dispatching work.
    await markPhase('warming', {
      total: preparedUsers.length,
      eligible: preparedUsers.length,
      sessionCount: verifiedSessions.length,
    });
    const warmResult = await tgService.preWarmSessions(
      verifiedSessions.map((s) => s.id),
      { concurrency: Math.min(MAX_CONCURRENT, verifiedSessions.length) }
    );

    // Drop permanently dead sessions from the live pool.
    const warmOkSet = new Set(warmResult.ok);
    const liveSessions = verifiedSessions.filter((s) => warmOkSet.has(String(s.id)));
    if (liveSessions.length === 0) {
      await this._finalizeOperation(opId, 'failed', addedCount, failedCount, skippedCount, results);
      throw new AppError(
        'All sessions failed to connect during warm-up',
        500,
        'ALL_SESSIONS_DEAD'
      );
    }

    logger.info(
      `V2 add-members: ${liveSessions.length} sessions warmed (${warmResult.failed.length} failed), ` +
        `${preparedUsers.length} users, ${targetIds.length} target(s), concurrency=${MAX_CONCURRENT}`,
      { opId }
    );

    // Helper: target-side failure classifier (same as legacy runner).
    const isTargetSideFailure = (msg) => {
      if (!msg) return false;
      const m = String(msg);
      return (
        m.includes('CHAT_ADMIN_REQUIRED') ||
        m.includes('CHAT_WRITE_FORBIDDEN') ||
        m.includes('CHANNEL_PRIVATE') ||
        m.includes('CHANNEL_INVALID') ||
        m.includes('CHAT_INVALID') ||
        m.includes('CHAT_FORBIDDEN') ||
        m.includes('Could not resolve group') ||
        m.includes('USER_NOT_PARTICIPANT') ||
        m.includes('CHAT_GUEST_SEND_FORBIDDEN')
      );
    };

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

    // Per-target iteration so each target gets its own worker pool run.
    for (let tIdx = 0; tIdx < targetIds.length; tIdx++) {
      const targetId = targetIds[tIdx];

      // Build a resolver cache for this target run.
      const resolverCache = new SessionResolverCache({
        sourceChannelIds,
        telegramService: tgService,
      });

      // Track broken sessions for this target.
      const brokenSessionsForTarget = new Set();

      // Build work items: each item is a prepared user entry.
      const workItems = preparedUsers.map((p, idx) => ({
        ...p,
        _originalIdx: idx,
        targetId,
      }));

      await markPhase('running', {
        total: preparedUsers.length,
        currentTarget: targetId,
      });

      const poolResult = await runWorkerPool({
        sessions: liveSessions.filter((s) => !brokenSessionsForTarget.has(s.id)),
        items: workItems,
        concurrency: MAX_CONCURRENT,
        perSessionBurst: plan.perSessionBurst,
        cooldownMsMin: (plan.cooldownSecMin || 0) * 1000,
        cooldownMsMax: (plan.cooldownSecMax || 0) * 1000,
        itemDelayMsMin: plan.itemDelayMsMin || 0,
        itemDelayMsMax: plan.itemDelayMsMax || 0,

        isCancelled: async () => isCancelled(opId),

        onProgress: async (snapshot) => {
          const processed = addedCount + failedCount + skippedCount +
            snapshot.succeeded + snapshot.failed;
          await emitItemProgress({
            progress: processed,
            processed,
            added: addedCount + snapshot.succeeded,
            failed: failedCount + snapshot.failed,
            skipped: skippedCount,
            total: userList.length * targetIds.length,
            currentTarget: targetId,
            activeWorkers: snapshot.activeWorkers,
            remaining: snapshot.remaining,
          });
        },

        attempt: async ({ session, item, attemptNum }) => {
          const prepared = item;
          const candidates = prepared.candidates && prepared.candidates.length > 0
            ? prepared.candidates
            : [prepared.identifier];

          // Check if session is broken for this target.
          if (brokenSessionsForTarget.has(session.id)) {
            return { status: 'session_dead', reason: 'Session broken for this target' };
          }

          // Try to resolve the user via the session-aware resolver cache.
          let inputUser = null;
          try {
            inputUser = await resolverCache.resolve(session, prepared);
          } catch (resolveErr) {
            if (tgService.isPermanentAuthError(resolveErr)) {
              return { status: 'session_dead', reason: resolveErr.message };
            }
            // Resolution failure — try the candidate chain directly.
          }

          // If the resolver cache got us an InputUser, try the invite
          // directly (skipping the resolver inside addMemberToGroup).
          // Otherwise, fall back to the legacy per-candidate chain.
          let addErr = null;

          if (inputUser) {
            try {
              await tgService.addMemberToGroup(
                session.id,
                targetId,
                String(inputUser.userId),
                { accessHash: String(inputUser.accessHash) }
              );
              return { status: 'ok' };
            } catch (e) {
              addErr = e;
            }
          } else {
            // Candidate chain fallback.
            for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
              const userTelegramId = candidates[cIdx];
              const candidateOptions =
                prepared.accessHash &&
                prepared.numericId &&
                String(userTelegramId) === String(prepared.numericId)
                  ? { accessHash: prepared.accessHash }
                  : undefined;
              try {
                await tgService.addMemberToGroup(
                  session.id,
                  targetId,
                  userTelegramId,
                  candidateOptions
                );
                return { status: 'ok' };
              } catch (e) {
                addErr = e;
                if (cIdx + 1 < candidates.length && isResolutionError(e && e.message)) {
                  continue;
                }
                break;
              }
            }
          }

          // Classify the error.
          if (!addErr) {
            return { status: 'item_failed', reason: 'No candidate resolved' };
          }

          const errMsg = addErr.message || String(addErr);

          // Permanent auth error → kill the session.
          if (tgService.isPermanentAuthError(addErr)) {
            return { status: 'session_dead', reason: errMsg };
          }

          // PEER_FLOOD → kill the session for the rest of the run.
          if (errMsg.includes('PEER_FLOOD') || errMsg.includes('Too many actions performed')) {
            brokenSessionsForTarget.add(session.id);
            return { status: 'session_dead', reason: 'PEER_FLOOD' };
          }

          // FLOOD_WAIT → session cooldown.
          if (errMsg.includes('FLOOD_WAIT')) {
            const floodSeconds = extractFloodSeconds(errMsg);
            return {
              status: 'session_cooldown',
              reason: `FLOOD_WAIT_${floodSeconds}`,
              cooldownMs: floodSeconds * 1000,
            };
          }

          // Target-side failure → session is broken for this target.
          if (isTargetSideFailure(errMsg)) {
            brokenSessionsForTarget.add(session.id);
            return { status: 'session_dead', reason: errMsg };
          }

          // Privacy restriction → terminal user-side failure.
          if (
            errMsg.includes('USER_PRIVACY_RESTRICT') ||
            errMsg.includes('PRIVACY_RESTRICTED') ||
            errMsg.includes('USER_NOT_MUTUAL_CONTACT') ||
            errMsg.includes('USER_CHANNELS_TOO_MUCH') ||
            errMsg.includes('Telegram dropped invite (privacy/restricted)')
          ) {
            return { status: 'item_failed', reason: 'Privacy settings prevent adding' };
          }

          // Already participant → success from the operator's POV.
          if (
            errMsg.includes('USER_ALREADY_PARTICIPANT') ||
            errMsg.includes('USERS_TOO_MUCH')
          ) {
            return { status: 'ok', reason: 'User already in target' };
          }

          // CHAT_MEMBER_ADD_FAILED
          if (
            errMsg.includes('CHAT_MEMBER_ADD_FAILED') ||
            errMsg.includes('Telegram refused to add this user')
          ) {
            return { status: 'item_retry', reason: errMsg };
          }

          // User banned / restricted.
          if (errMsg.includes('USER_BANNED_IN_CHANNEL') || errMsg.includes('USER_RESTRICTED')) {
            return { status: 'item_failed', reason: 'User is banned or restricted' };
          }

          // User deactivated / not found.
          if (
            errMsg.includes('USER_DEACTIVATED') ||
            errMsg.includes('INPUT_USER_DEACTIVATED') ||
            errMsg.includes('USER_NOT_FOUND') ||
            errMsg.includes('USERNAME_NOT_OCCUPIED') ||
            errMsg.includes('USER_ID_INVALID') ||
            errMsg.includes('USERNAME_INVALID') ||
            errMsg.includes('Could not resolve user') ||
            /No user has\s+"/i.test(errMsg)
          ) {
            return { status: 'item_failed', reason: errMsg };
          }

          // Resolution error → retry on another session.
          if (isResolutionError(errMsg)) {
            return { status: 'item_retry', reason: errMsg };
          }

          // Generic / unknown failure.
          return { status: 'item_failed', reason: errMsg };
        },
      });

      // Map pool results back into the legacy result format.
      for (const row of poolResult.results) {
        if (!row) continue;
        const prepared = row.item;
        const userResult = {
          userId: prepared ? prepared.identifier : 'unknown',
          targetId,
          sessionId: row.sessionId,
          success: row.status === 'ok',
          error: row.reason || null,
        };

        if (row.status === 'ok') {
          addedCount++;
        } else if (row.reason && (
          row.reason.includes('Privacy settings') ||
          row.reason === 'User already in target'
        )) {
          userResult.skipped = true;
          skippedCount++;
        } else {
          failedCount++;
        }
        results.push(userResult);
      }

      logger.info(
        `V2 add-members target ${targetId}: pool stats = ${JSON.stringify(poolResult.stats)}, ` +
          `resolver stats = ${JSON.stringify(resolverCache.stats)}`,
        { opId }
      );

      // Persist progress after each target.
      const processed = addedCount + failedCount + skippedCount;
      await persistRunningProgress(
        { progress: processed, added: addedCount, failed: failedCount, skipped: skippedCount },
        { force: true }
      );
    }

    // Finalize.
    const finalStatus = await isCancelled(opId) ? 'cancelled' : 'completed';
    await this._finalizeOperation(opId, finalStatus, addedCount, failedCount, skippedCount, results);

    logger.info(
      `V2 add members operation ${opId} finished: ${addedCount} added, ${failedCount} failed, ${skippedCount} skipped`,
      { opId }
    );

    return {
      opId,
      total: userList.length,
      added: addedCount,
      failed: failedCount,
      skipped: skippedCount,
      results,
      dedup: {
        applied: dedupStats.applied,
        before: dedupStats.before,
        after: dedupStats.after,
        dropped: dedupStats.dropped,
        source: dedupStats.source,
        listId: dedupStats.listId,
      },
      plan: {
        mode: plan.mode,
        perSessionBurst: plan.perSessionBurst,
        maxPerSession: plan.maxPerSessionBurst,
        rounds: plan.rounds,
        cooldownSec: [plan.cooldownSecMin, plan.cooldownSecMax],
        itemDelayMs: [plan.itemDelayMsMin, plan.itemDelayMsMax],
      },
      cooldownSkipped: verifiedSessions.cooldownSkipped || [],
      runner: 'v2',
    };
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

const groupService = new GroupService();

// Expose the pure dedup helpers as static properties so unit tests
// can exercise them in isolation without spinning up the full
// service / DB / Redis.
groupService.dedupUploadedUserList = dedupUploadedUserList;
groupService.dedupKeyForEntry = dedupKeyForEntry;
groupService.isUploadedListSource = isUploadedListSource;
groupService.DEFAULT_MAX_ADDS_PER_SESSION = DEFAULT_MAX_ADDS_PER_SESSION;

module.exports = groupService;
