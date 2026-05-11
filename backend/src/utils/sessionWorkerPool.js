/**
 * sessionWorkerPool — parallel per-session worker primitive for the
 * bulk runners (add-members, single-user mass DM).
 *
 * Why this exists
 * ===============
 * The legacy runners in `groupService.addMembersToGroups` and
 * `messageService._processSingleUserMassDm` iterate sessions
 * sequentially:
 *
 *   for round in 0..targetRounds:
 *     for session in liveSessions:           // <-- *await*-ed
 *       for chunk in session.burst:
 *         await sendOrInvite(...)
 *         await sleep(perItemDelay)
 *
 * With 1000 sessions and even modest per-item delays this gives a
 * round time of (sessionCount × burst × delay), i.e. days. The
 * planner's `estimatedMs` even comments that items are "processed in
 * parallel across sessions within a round" — but the actual control
 * flow is single-threaded.
 *
 * This module gives both runners a small, dependency-free, fully
 * tested parallel worker pool that pulls work items off a shared
 * atomic queue. Per-session pacing (burst + cooldown + per-item
 * delay) is preserved INSIDE each worker so PEER_FLOOD risk doesn't
 * change. Throughput becomes O(concurrent_sessions × invite_qps)
 * instead of O(total_sessions × per_item_delay).
 *
 * Design contract
 * ===============
 *   run({
 *     sessions:           Array<{ id, ... }>,
 *     items:              Array<any>,
 *     concurrency:        number,                // max workers in flight
 *     perSessionBurst:    number,                // items per burst, then cooldown
 *     cooldownMsMin:      number,
 *     cooldownMsMax:      number,
 *     itemDelayMsMin:     number,
 *     itemDelayMsMax:     number,
 *     startStaggerMsMin:  number,                // optional, see below
 *     startStaggerMsMax:  number,
 *     attempt(ctx),                              // user-supplied per-attempt fn
 *     onProgress(snapshot),                      // optional
 *     isCancelled(),                             // optional
 *   }) -> { results: Array<AttemptResult>, stats: PoolStats }
 *
 * Cross-session pacing (`startStaggerMs*`)
 * ----------------------------------------
 * `itemDelayMs*` paces successive items WITHIN a single session's
 * burst. For bulk mass-DM where each session has exactly ONE item
 * per target, this delay never fires — every worker pops its only
 * item immediately and races every other worker to Telegram. With
 * 33+ sessions hitting a single user in sub-second concurrency,
 * Telegram raises an account-level PEER_FLOOD spam flag on every
 * session involved (see Job 54 in the operator's logs).
 *
 * `startStaggerMsMin/Max` introduces an offset BEFORE each worker's
 * first `attempt()` call: worker N waits `N × pickDelay(min,max)` ms
 * AFTER popping its first item but BEFORE invoking `attempt()`. The
 * "after pop" placement is deliberate — for the one-item-per-session
 * mass-DM shape, every worker pops in the same event-loop tick (FIFO),
 * which means item i naturally lands on worker i. If we slept before
 * popping, worker 0 would race through every item alone and we'd just
 * trade a fan-out PEER_FLOOD across 33 sessions for a single-session
 * SendMessage flood on session 0. The total wall time of the pool
 * stays `O(staggerMs × workers)` in the worst case — fine for
 * institutional batches because the alternative was a sequential
 * per-item delay across the whole queue. Callers that don't need
 * cross-session pacing leave these knobs at 0 (the default) and the
 * behaviour is unchanged.
 *
 * Each `attempt(ctx)` receives:
 *   {
 *     session,                  // session row picked by the pool
 *     item,                     // the work item from `items`
 *     itemIndex,                // index in the original `items` array
 *     attemptNum,               // 1-based, increments on re-queue
 *   }
 *
 * It must return (or throw) an `AttemptResult`-shaped object:
 *   {
 *     status: 'ok' | 'item_failed' | 'item_retry' | 'session_dead'
 *           | 'session_cooldown',
 *     reason?: string,                  // human-readable for the row UI
 *     cooldownMs?: number,              // for 'session_cooldown'
 *     extra?: object,                   // merged into the final row
 *   }
 *
 * Status semantics:
 *
 *   'ok'                — item done, count toward success.
 *   'item_failed'       — terminal user-side failure (USER_BANNED,
 *                         USER_DEACTIVATED, USER_PRIVACY_RESTRICT, ...).
 *                         Counted as failed once; not re-queued.
 *   'item_retry'        — transient or session-mismatch error. The item
 *                         is pushed back onto the queue with attemptNum+1
 *                         so a DIFFERENT session can try it. Capped by
 *                         `maxAttemptsPerItem` (default = sessionCount,
 *                         bounded at 5 to avoid runaway).
 *   'session_dead'      — auth_key dead, peer-flooded, banned, etc.
 *                         The session exits the pool permanently and
 *                         the item is re-queued (status 'item_retry').
 *   'session_cooldown'  — FLOOD_WAIT_n. The session sleeps for
 *                         `cooldownMs` then re-enters the pool. The
 *                         item is re-queued.
 *
 * `onProgress(snapshot)` is invoked after every attempt with the
 * current counters. Snapshots are cheap; callers should debounce
 * persistence on their own. Snapshot shape:
 *
 *   {
 *     completed: number,
 *     succeeded: number,
 *     failed: number,
 *     retried: number,
 *     sessionDead: number,
 *     sessionCooldown: number,
 *     remaining: number,
 *     activeWorkers: number,
 *     lastResult: { itemIndex, sessionId, status, reason },
 *   }
 *
 * Cancellation: `isCancelled()` is checked at the top of every
 * worker iteration. When true, in-flight attempts are allowed to
 * finish but no new items are dispatched.
 *
 * @module sessionWorkerPool
 */

'use strict';

const DEFAULT_CONCURRENCY = 200;
const MAX_ITEM_ATTEMPTS_HARD_CAP = 5;

function sleep(ms) {
  return new Promise((res) => setTimeout(res, Math.max(0, ms)));
}

function pickDelay(min, max) {
  if (!Number.isFinite(min) || min < 0) min = 0;
  if (!Number.isFinite(max) || max < min) max = min;
  if (max === min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Sleep, but bail out as soon as `isCancelled()` returns true.
 *
 * This stops a 5-minute cooldown from holding the whole job hostage
 * after the operator hits Cancel.
 */
async function cancellableSleep(ms, isCancelled) {
  const start = Date.now();
  const step = 250;
  while (Date.now() - start < ms) {
    if (typeof isCancelled === 'function') {
      try {
        if (await isCancelled()) return;
      } catch (_) { /* best-effort */ }
    }
    await sleep(Math.min(step, ms - (Date.now() - start)));
  }
}

/**
 * Shared, mutex-free FIFO queue. JS is single-threaded so we don't
 * need a real mutex; we just need atomic-feeling shift() / push()
 * semantics. We do guard against accidental re-entrant push() of
 * the same logical item by tracking an attempt counter per index.
 */
function _makeQueue(initialItems) {
  const buf = initialItems.map((item, idx) => ({
    item,
    itemIndex: idx,
    attemptNum: 1,
  }));
  return {
    pop() {
      return buf.shift() || null;
    },
    push(entry) {
      buf.push(entry);
    },
    size() {
      return buf.length;
    },
  };
}

/**
 * Run a parallel worker pool over `items` using `sessions`.
 *
 * @param {object} cfg
 * @returns {Promise<{ results: Array, stats: object }>}
 */
async function run(cfg) {
  const {
    sessions,
    items,
    attempt,
    onProgress,
    isCancelled,
    perSessionBurst = 1,
    cooldownMsMin = 0,
    cooldownMsMax = 0,
    itemDelayMsMin = 0,
    itemDelayMsMax = 0,
    startStaggerMsMin = 0,
    startStaggerMsMax = 0,
    maxAttemptsPerItem,
  } = cfg;

  if (typeof attempt !== 'function') {
    throw new Error('sessionWorkerPool.run: attempt() is required');
  }
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new Error('sessionWorkerPool.run: at least one session is required');
  }
  if (!Array.isArray(items)) {
    throw new Error('sessionWorkerPool.run: items must be an array');
  }
  if (items.length === 0) {
    return {
      results: [],
      stats: {
        completed: 0, succeeded: 0, failed: 0, retried: 0,
        sessionDead: 0, sessionCooldown: 0,
      },
    };
  }

  const concurrency = Math.max(1, Math.min(
    sessions.length,
    Number.isFinite(cfg.concurrency) && cfg.concurrency > 0
      ? Math.floor(cfg.concurrency)
      : DEFAULT_CONCURRENCY
  ));

  // Per-item attempt cap: bounded at 5 by default to avoid a
  // single doomed item ping-ponging through the pool. A 5-session
  // retry budget is more than enough to disambiguate a real
  // user-side failure from a single transient session glitch.
  const itemAttemptCap = Math.max(1, Math.min(
    MAX_ITEM_ATTEMPTS_HARD_CAP,
    Number.isFinite(maxAttemptsPerItem) && maxAttemptsPerItem > 0
      ? Math.floor(maxAttemptsPerItem)
      : Math.min(sessions.length, MAX_ITEM_ATTEMPTS_HARD_CAP)
  ));

  const queue = _makeQueue(items);
  const results = new Array(items.length).fill(null);
  const stats = {
    completed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    sessionDead: 0,
    sessionCooldown: 0,
  };

  // Sessions still eligible to take work. We pop the head when a
  // worker picks up a session and push back at the end of its
  // burst (or after a cooldown). Sessions that go 'session_dead'
  // are never returned to the pool.
  const liveSessions = sessions.slice();
  let activeWorkers = 0;

  const emitProgress = async (lastResult) => {
    if (typeof onProgress !== 'function') return;
    try {
      await onProgress({
        completed: stats.completed,
        succeeded: stats.succeeded,
        failed: stats.failed,
        retried: stats.retried,
        sessionDead: stats.sessionDead,
        sessionCooldown: stats.sessionCooldown,
        remaining: queue.size(),
        activeWorkers,
        lastResult: lastResult || null,
      });
    } catch (_) { /* best-effort */ }
  };

  /**
   * One session's worker loop. Owns the session row for the
   * duration of one burst. Re-acquires the session from the
   * pool head after the burst's cooldown.
   *
   * `startOffsetMs` is the cross-session stagger applied BEFORE
   * worker N invokes `attempt()` for its first item. We delay
   * *after* `queue.pop()` rather than before, so the FIFO pop order
   * still pins items to sessions when `items.length === sessions.length`
   * (the mass-DM "one target per session" pattern relies on this
   * happy accident — items[i].sessionId == sessions[i].id when both
   * arrays are zipped). Without that ordering, worker 0 would race
   * through every item alone and we'd just trade a fan-out PEER_FLOOD
   * across 33 sessions for a single-session SendMessage flood.
   */
  async function sessionWorker(session, startOffsetMs) {
    activeWorkers++;
    let sessionDead = false;
    let firstAttempt = true;
    try {
      let burstRemaining = perSessionBurst;

      while (queue.size() > 0) {
        // Cancellation gate.
        if (typeof isCancelled === 'function') {
          try {
            if (await isCancelled()) return;
          } catch (_) { /* fall through */ }
        }

        const entry = queue.pop();
        if (!entry) return;

        // Cross-session stagger: each worker sleeps `startOffsetMs`
        // ONCE, just before its first attempt. We sleep here (after
        // pop) instead of before the while-loop so the queue's pop
        // order pins each item to the worker that popped it (see the
        // function-level comment above).
        if (firstAttempt) {
          firstAttempt = false;
          if (startOffsetMs > 0) {
            await cancellableSleep(startOffsetMs, isCancelled);
          }
        }

        const ctx = {
          session,
          item: entry.item,
          itemIndex: entry.itemIndex,
          attemptNum: entry.attemptNum,
        };

        let result;
        try {
          result = await attempt(ctx);
        } catch (err) {
          // Any uncaught throw is treated as a permanent item
          // failure so a single buggy attempt() can't poison
          // the whole pool. attempt() should normally classify
          // errors itself and return a typed result.
          result = {
            status: 'item_failed',
            reason: err && err.message ? err.message : String(err),
          };
        }

        result = result || { status: 'item_failed', reason: 'attempt() returned no result' };
        const status = String(result.status || 'item_failed');

        const row = {
          itemIndex: entry.itemIndex,
          item: entry.item,
          sessionId: session && session.id,
          attemptNum: entry.attemptNum,
          status,
          reason: result.reason || null,
          ...(result.extra || {}),
        };

        if (status === 'ok') {
          stats.succeeded++;
          stats.completed++;
          results[entry.itemIndex] = row;
        } else if (status === 'item_failed') {
          stats.failed++;
          stats.completed++;
          results[entry.itemIndex] = row;
        } else if (status === 'item_retry') {
          stats.retried++;
          if (entry.attemptNum >= itemAttemptCap) {
            // Out of retries. Record as failed with a clear reason.
            stats.failed++;
            stats.completed++;
            results[entry.itemIndex] = {
              ...row,
              status: 'item_failed',
              reason: row.reason || `Out of retries (${itemAttemptCap} attempts across sessions)`,
            };
          } else {
            queue.push({
              item: entry.item,
              itemIndex: entry.itemIndex,
              attemptNum: entry.attemptNum + 1,
            });
            // Don't mark `completed++` — the item isn't done yet.
            // We still emit a progress event so the UI sees the retry.
          }
        } else if (status === 'session_dead') {
          stats.sessionDead++;
          sessionDead = true;
          // Re-queue the item so another session can take it.
          if (entry.attemptNum < itemAttemptCap) {
            stats.retried++;
            queue.push({
              item: entry.item,
              itemIndex: entry.itemIndex,
              attemptNum: entry.attemptNum + 1,
            });
          } else {
            stats.failed++;
            stats.completed++;
            results[entry.itemIndex] = {
              ...row,
              status: 'item_failed',
              reason: row.reason || 'Session died and no retries left',
            };
          }
          await emitProgress(row);
          return; // exit worker permanently
        } else if (status === 'session_cooldown') {
          stats.sessionCooldown++;
          // Re-queue the item for someone else AND park this session.
          if (entry.attemptNum < itemAttemptCap) {
            stats.retried++;
            queue.push({
              item: entry.item,
              itemIndex: entry.itemIndex,
              attemptNum: entry.attemptNum + 1,
            });
          } else {
            stats.failed++;
            stats.completed++;
            results[entry.itemIndex] = {
              ...row,
              status: 'item_failed',
              reason: row.reason || 'Session on cooldown and no retries left',
            };
          }
          await emitProgress(row);
          const cdMs = Number.isFinite(result.cooldownMs) && result.cooldownMs > 0
            ? result.cooldownMs
            : pickDelay(cooldownMsMin, cooldownMsMax);
          await cancellableSleep(cdMs, isCancelled);
          // Reset the burst counter — the wait counts as the cooldown.
          burstRemaining = perSessionBurst;
          continue;
        } else {
          // Unknown status — log and treat as failed.
          stats.failed++;
          stats.completed++;
          results[entry.itemIndex] = {
            ...row,
            status: 'item_failed',
            reason: row.reason || `Unknown attempt status: ${status}`,
          };
        }

        await emitProgress(row);

        // Pacing: per-item delay between attempts within a burst,
        // burst cooldown between bursts.
        burstRemaining--;
        if (queue.size() === 0) break;
        if (burstRemaining <= 0) {
          burstRemaining = perSessionBurst;
          await cancellableSleep(pickDelay(cooldownMsMin, cooldownMsMax), isCancelled);
        } else if (itemDelayMsMax > 0) {
          await cancellableSleep(pickDelay(itemDelayMsMin, itemDelayMsMax), isCancelled);
        }
      }
    } finally {
      activeWorkers--;
      if (sessionDead) {
        const idx = liveSessions.indexOf(session);
        if (idx >= 0) liveSessions.splice(idx, 1);
      }
    }
  }

  // Spin up workers up to `concurrency`. Each worker is bound to
  // ONE session for its lifetime, so we pull `concurrency` sessions
  // off the live pool and run them in parallel. Any sessions left
  // over are unused; that's fine, our throughput is already
  // saturating the queue.
  //
  // Workers are staggered by `startStaggerMs*` so a 100-session pool
  // with 1 item per session doesn't fire 100 requests at Telegram
  // inside the same second (the PEER_FLOOD failure mode for mass DM).
  // Worker 0 starts immediately; worker N waits N * pickDelay(min,max).
  const workerPromises = [];
  const initialBatch = Math.min(concurrency, liveSessions.length);
  for (let i = 0; i < initialBatch; i++) {
    const session = liveSessions[i];
    const startOffsetMs = i === 0 || startStaggerMsMax <= 0
      ? 0
      : i * pickDelay(startStaggerMsMin, startStaggerMsMax);
    workerPromises.push(sessionWorker(session, startOffsetMs));
  }

  await Promise.all(workerPromises);

  // Fill any leftover null rows (queue went dry mid-flight while
  // a worker was already past the queue.size() check). They get a
  // "no session reached this item" terminal result so callers
  // never see a half-populated results array.
  for (let i = 0; i < results.length; i++) {
    if (results[i] === null) {
      results[i] = {
        itemIndex: i,
        item: items[i],
        sessionId: null,
        attemptNum: 0,
        status: 'item_failed',
        reason: 'No session reached this item (pool exhausted before pickup)',
      };
      stats.failed++;
      stats.completed++;
    }
  }

  return { results, stats };
}

module.exports = {
  run,
  // Exported for tests so they can poke pacing helpers without
  // having to monkey-patch global timers.
  __internal: { pickDelay, cancellableSleep },
  DEFAULT_CONCURRENCY,
  MAX_ITEM_ATTEMPTS_HARD_CAP,
};
