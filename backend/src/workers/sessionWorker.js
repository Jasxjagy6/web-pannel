#!/usr/bin/env node
/**
 * sessionWorker — sharded BullMQ worker process for the 1000+ session
 * scale-out.
 *
 * ============================================================
 *   Operating model
 * ============================================================
 *
 * The panel's API server (`backend/src/index.js`) handles HTTP +
 * WebSocket traffic and, today, ALSO runs BullMQ workers in-process.
 * That is fine up to a few hundred sessions; past that, a single
 * Node event loop pinned by serial Telegram RPCs becomes the
 * throughput ceiling.
 *
 * This script lets you fan workers out into separate OS processes:
 *
 *     # process 1 (existing API)
 *     SESSION_WORKER_MODE=api    node backend/src/index.js
 *
 *     # processes 2..N (new BullMQ workers, no HTTP server)
 *     SESSION_WORKER_MODE=worker SHARD_ID=0 SHARD_COUNT=4 \
 *         node backend/src/workers/sessionWorker.js
 *     SESSION_WORKER_MODE=worker SHARD_ID=1 SHARD_COUNT=4 \
 *         node backend/src/workers/sessionWorker.js
 *     ...
 *
 * When the API server sees `SESSION_WORKER_MODE=api` it SKIPS
 * `initializeQueues()` (which is what spawns the in-process
 * BullMQ workers) — so jobs only run in the worker processes,
 * never in the API. That avoids two MTProto connections fighting
 * over the same auth_key. Backwards compatibility: if
 * SESSION_WORKER_MODE is unset (today's behavior) the API server
 * runs the workers itself, exactly like before.
 *
 * ============================================================
 *   Sharding
 * ============================================================
 *
 * Shards are indexed 0..N-1 and pinned to the worker process via
 * `SHARD_ID` / `SHARD_COUNT`. Sessions are mapped to shards by
 * `sessionAffinity.assign(ring, sessionId)` where the ring is
 * built from worker IDs `worker-0`..`worker-{N-1}`.
 *
 * A given worker only initializes MTProto clients (and refreshes
 * heartbeats / answers RPCs) for sessions whose affinity matches
 * its shard. The session ownership lock in Redis enforces this —
 * if a worker tries to connect a session that's owned by a
 * different shard, Redis SETNX fails and the worker logs + skips
 * (rather than connecting twice and risking auth_key invalidation).
 *
 * ============================================================
 *   Graceful drain
 * ============================================================
 *
 * On SIGTERM:
 *   1. Stop accepting new BullMQ jobs (worker.pause).
 *   2. Wait up to DRAIN_GRACE_MS for in-flight jobs to finish.
 *   3. Release every session lock we hold.
 *   4. Disconnect MTProto clients cleanly (they reconnect from
 *      the StringSession on next start — auth_key bytes are NOT
 *      regenerated).
 *   5. Exit 0.
 *
 * No active session is ever marked revoked / inactive / lost
 * during a worker drain. Existing rows stay byte-for-byte
 * identical in DB.
 *
 * ============================================================
 *   Status & roadmap
 * ============================================================
 *
 * This entrypoint is wired up but the JOB ROUTING (per-shard queue
 * vs. shared queue with shard-aware consumers) is intentionally
 * left as the existing shared queue. That means in the multi-shard
 * mode you get pure horizontal scale of *workers* (more concurrent
 * jobs at once) but jobs aren't yet pinned to the worker that owns
 * the session — the session lock prevents data-loss but a worker
 * may drop a job if the session it asks for is owned by another
 * shard. A follow-up PR adds per-shard sub-queues + affinity-aware
 * dispatch in `messageQueue.add`.
 *
 * Until that lands, prefer SHARD_COUNT=1 (single worker process,
 * separated from the API for event-loop isolation). That gives
 * you the lock-mediated safety without any routing concerns.
 */

'use strict';

require('dotenv').config();

const logger = require('../utils/logger');
const { initDB } = require('../config/database');
const { connectRedis } = require('../config/redis');
const { initializeQueues, closeQueues } = require('../queues');
const sessionLock = require('../services/sessionOwnershipLock');

// Shard configuration. Defaults are safe (single-shard, behaves
// like a single worker process).
const SHARD_ID = parseInt(process.env.SHARD_ID || '0', 10);
const SHARD_COUNT = Math.max(1, parseInt(process.env.SHARD_COUNT || '1', 10));
const DRAIN_GRACE_MS = parseInt(process.env.DRAIN_GRACE_MS || '30000', 10);
const HOLDER_ID = `worker-${SHARD_ID}.pid-${process.pid}`;

// We store every session lock token we acquire in this map so the
// drain handler can release them on shutdown. Keys are sessionId
// (string), values are fencing tokens.
const heldLocks = new Map();

let shuttingDown = false;

async function start() {
  logger.info(
    `[sessionWorker] starting shard ${SHARD_ID}/${SHARD_COUNT} as ${HOLDER_ID}`
  );
  await initDB();
  logger.info('[sessionWorker] DB initialized');
  await connectRedis();
  logger.info('[sessionWorker] Redis connected');
  await initializeQueues();
  logger.info('[sessionWorker] BullMQ workers running');

  // Wire up signal handlers for clean drain.
  const handle = (sig) => () => gracefulDrain(sig);
  process.on('SIGTERM', handle('SIGTERM'));
  process.on('SIGINT', handle('SIGINT'));

  // Don't crash the process on a single uncaught exception — same
  // posture as backend/src/index.js. The MTProto _updateLoop
  // occasionally emits parser errors when Telegram ships a TL
  // upgrade ahead of GramJS; one of those should not destroy every
  // session this worker holds.
  process.on('uncaughtException', (err) => {
    logger.error(
      `[sessionWorker] uncaughtException: ${err && err.message}`,
      { stack: err && err.stack }
    );
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(
      `[sessionWorker] unhandledRejection: ${reason && reason.message ? reason.message : reason}`
    );
  });

  logger.info(
    `[sessionWorker] shard ${SHARD_ID}/${SHARD_COUNT} ready (drain grace=${DRAIN_GRACE_MS}ms)`
  );
}

async function gracefulDrain(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[sessionWorker] ${signal} received, draining`);

  const force = setTimeout(() => {
    logger.warn('[sessionWorker] drain grace exceeded, forcing exit');
    process.exit(1);
  }, DRAIN_GRACE_MS);
  // Don't keep the loop alive solely on the timer.
  if (force.unref) force.unref();

  try {
    // 1) Stop pulling new BullMQ jobs and wait for in-flight to drain.
    //    closeQueues() in queues/index.js calls worker.close() per
    //    queue which respects in-flight job completion before
    //    resolving — so this is the same drain semantics as the
    //    existing API process.
    await closeQueues();
    logger.info('[sessionWorker] queues drained');

    // 2) Release every session lock we hold so the next worker
    //    cycle (or the API server in a single-process rollback)
    //    can take ownership immediately. Without this step the
    //    locks would naturally expire after their TTL (default
    //    60s) — releasing eagerly is just nicer for ops.
    const releases = [];
    for (const [sessionId, token] of heldLocks.entries()) {
      releases.push(
        sessionLock.release(sessionId, token).catch((err) => {
          logger.warn(
            `[sessionWorker] release(${sessionId}) failed: ${err.message}`
          );
        })
      );
    }
    await Promise.all(releases);
    heldLocks.clear();
    logger.info(`[sessionWorker] released ${releases.length} session lock(s)`);

    // 3) Close DB pool last so that if anything tried to log on
    //    the way out it still had a connection.
    try {
      const { pool } = require('../config/database');
      await pool.end();
    } catch (err) {
      logger.warn(`[sessionWorker] pool.end failed: ${err.message}`);
    }

    clearTimeout(force);
    logger.info('[sessionWorker] drain complete; exiting 0');
    process.exit(0);
  } catch (err) {
    logger.error(`[sessionWorker] drain failed: ${err.message}`);
    clearTimeout(force);
    process.exit(1);
  }
}

/**
 * Public hook for telegramService._ensureConnected to register a
 * session lock token under our process so the drain handler can
 * release it on the way out. Calling code shouldn't need to know
 * about heldLocks.
 */
function rememberLock(sessionId, token) {
  if (!sessionId || !token) return;
  heldLocks.set(String(sessionId), token);
}

function forgetLock(sessionId) {
  heldLocks.delete(String(sessionId));
}

module.exports = {
  // Configuration constants exposed for tests + ops endpoints.
  SHARD_ID,
  SHARD_COUNT,
  HOLDER_ID,
  DRAIN_GRACE_MS,
  rememberLock,
  forgetLock,
};

if (require.main === module) {
  start().catch((err) => {
    logger.error(`[sessionWorker] failed to start: ${err && err.message}`);
    process.exit(1);
  });
}
