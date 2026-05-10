/**
 * sessionAffinity — deterministic mapping from sessionId → workerIndex.
 *
 * ============================================================
 *   Goal
 * ============================================================
 *
 * For 1000+ Telegram sessions on one box we want to fan out the
 * MTProto traffic across N worker processes. Two hard constraints:
 *
 *   1. Every session must always land on the SAME worker for the
 *      lifetime of that worker. Bouncing a session between workers
 *      means closing+reopening MTProto, which is the exact
 *      behavior the Telegram spam server flags as suspicious.
 *
 *   2. When workers come or go (scale-up, scale-down, rolling
 *      restart) the *minimum* number of sessions should re-shard.
 *      Naïve `id % N` fails badly here — every change to N
 *      reshuffles every session.
 *
 * ============================================================
 *   Design
 * ============================================================
 *
 * Consistent hashing with virtual nodes. Each real worker gets V
 * (default 64) virtual points placed on a 2^32 ring by hashing
 * `${workerId}#${vIdx}`. A session is hashed once and assigned to
 * the next virtual point clockwise, falling back to the first.
 *
 * Properties:
 *   - Deterministic: same (sessionId, workers) input → same output.
 *   - Stable under scale-up: adding worker N+1 only re-homes ~1/(N+1)
 *     of the sessions on average (the ones whose hash falls in the
 *     newcomer's slice of the ring).
 *   - Stable under scale-down: removing worker K only moves K's
 *     sessions to neighbouring workers; everyone else is untouched.
 *
 * Hash is sha1 of the input — overkill for collision avoidance at
 * this scale, but it's already in the standard library and avoids
 * pulling in a dependency.
 */

'use strict';

const crypto = require('crypto');

const DEFAULT_VIRTUAL_NODES_PER_WORKER = 64;

function hashToUint32(str) {
  // First 4 bytes of sha1 → unsigned 32-bit int.
  const buf = crypto.createHash('sha1').update(str).digest();
  return buf.readUInt32BE(0);
}

/**
 * Build an affinity ring from a list of worker IDs.
 *
 * @param {string[]} workerIds
 * @param {object}   [opts]
 * @param {number}   [opts.virtualNodes]
 */
function buildRing(workerIds, opts = {}) {
  if (!Array.isArray(workerIds) || workerIds.length === 0) {
    throw new Error('sessionAffinity.buildRing: workerIds must be a non-empty array');
  }
  const v = opts.virtualNodes || DEFAULT_VIRTUAL_NODES_PER_WORKER;
  // Each entry: { hash, workerId }. Sorted ascending by hash so we
  // can binary-search for the assignment.
  const points = [];
  for (const wid of workerIds) {
    for (let i = 0; i < v; i++) {
      points.push({
        hash: hashToUint32(`${wid}#${i}`),
        workerId: wid,
      });
    }
  }
  points.sort((a, b) => a.hash - b.hash);
  return { points, workerIds: [...workerIds] };
}

function assign(ring, sessionId) {
  if (!ring || !Array.isArray(ring.points) || ring.points.length === 0) {
    throw new Error('sessionAffinity.assign: ring is empty');
  }
  const h = hashToUint32(String(sessionId));
  // Binary search for the first ring point with hash >= h. Wrap
  // around to the first point if none.
  let lo = 0;
  let hi = ring.points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ring.points[mid].hash < h) lo = mid + 1;
    else hi = mid;
  }
  const point = ring.points[lo];
  return point.hash >= h ? point.workerId : ring.points[0].workerId;
}

/**
 * Bulk assign — useful for the verify-sessions script and the worker
 * boot routine that wants to know "what sessions am I responsible for?".
 */
function assignMany(ring, sessionIds) {
  const out = new Map();
  for (const sid of sessionIds) {
    const w = assign(ring, sid);
    if (!out.has(w)) out.set(w, []);
    out.get(w).push(sid);
  }
  return out;
}

/**
 * Compute the load distribution of a ring against a sample of
 * sessions. Useful for unit tests + the operations dashboard:
 * spot-check that the variance is sane (typically <±15% per worker
 * for V=64).
 */
function distribution(ring, sessionIds) {
  const counts = new Map();
  for (const wid of ring.workerIds) counts.set(wid, 0);
  for (const sid of sessionIds) {
    const w = assign(ring, sid);
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return counts;
}

module.exports = {
  buildRing,
  assign,
  assignMany,
  distribution,
  DEFAULT_VIRTUAL_NODES_PER_WORKER,
  // Exported for the smoke test.
  _hashToUint32: hashToUint32,
};
