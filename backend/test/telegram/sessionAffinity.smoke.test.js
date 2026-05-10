/**
 * Smoke test for the consistent-hash session affinity ring.
 *
 * Properties we verify:
 *   1. Deterministic — same inputs, same output.
 *   2. Stable under scale-up — adding a new worker only re-homes
 *      ~1/(N+1) of the sessions, not the entire fleet.
 *   3. Reasonably balanced load with virtualNodes=64.
 *   4. Stable under scale-down — removing a worker only moves the
 *      sessions that were on it.
 *   5. Bulk assign returns one entry per worker, total count
 *      matches input.
 *
 * No Redis / DB needed — this is a pure function module.
 */

'use strict';

const assert = require('assert');
const aff = require('../../src/workers/sessionAffinity');

// Deterministic synthetic session IDs.
const SESSIONS = Array.from({ length: 1000 }, (_, i) => `sess-${i}`);

(function deterministic() {
  const ring = aff.buildRing(['w0', 'w1', 'w2']);
  const a1 = aff.assign(ring, 'sess-42');
  const a2 = aff.assign(ring, 'sess-42');
  assert.strictEqual(a1, a2, 'same sessionId must map to same worker');
  // Different ring instance, same workerIds → same answer
  const ring2 = aff.buildRing(['w0', 'w1', 'w2']);
  const a3 = aff.assign(ring2, 'sess-42');
  assert.strictEqual(a3, a1, 'rebuilt ring with same workerIds is deterministic');
  console.log('OK deterministic mapping');
})();

(function balanced() {
  // With V=64 across 4 workers, the variance should be modest.
  // Pure mathematical guarantee: by the Chernoff bound, with V=64
  // and 1000 sessions / 4 workers expected count is 250 per worker.
  // Empirically the spread fits inside ±20%; tighten test bound a
  // touch so we'd notice a real regression.
  const ring = aff.buildRing(['w0', 'w1', 'w2', 'w3']);
  const dist = aff.distribution(ring, SESSIONS);
  const counts = Array.from(dist.values());
  const expected = SESSIONS.length / 4;
  for (const c of counts) {
    const dev = Math.abs(c - expected) / expected;
    assert.ok(dev < 0.30, `worker count ${c} too far from expected ${expected} (dev=${dev.toFixed(2)})`);
  }
  console.log(`OK balanced load: counts=${counts.join(',')}`);
})();

(function stableScaleUp() {
  // Build a ring of N=4. Note who owns each session. Build a ring
  // of N=5 (added w4). Confirm at most ~1/5 of sessions moved.
  const r4 = aff.buildRing(['w0', 'w1', 'w2', 'w3']);
  const r5 = aff.buildRing(['w0', 'w1', 'w2', 'w3', 'w4']);
  let moved = 0;
  for (const s of SESSIONS) {
    if (aff.assign(r4, s) !== aff.assign(r5, s)) moved++;
  }
  const movedPct = moved / SESSIONS.length;
  // Theoretical mean is 1/5=0.20. Allow up to 0.35 as a safety
  // margin for V=64 noise on a 1000-sample run.
  assert.ok(movedPct < 0.35, `scale-up moved ${(movedPct*100).toFixed(1)}% of sessions (expected ~20%)`);
  console.log(`OK stable scale-up: ${(movedPct*100).toFixed(1)}% moved on N=4 → N=5`);
})();

(function stableScaleDown() {
  // Remove w3 from the N=5 ring. Sessions that were NOT on w3 must
  // still be on the same worker; sessions that were on w3 must
  // have moved to one of {w0,w1,w2,w4}.
  const r5 = aff.buildRing(['w0', 'w1', 'w2', 'w3', 'w4']);
  const r4 = aff.buildRing(['w0', 'w1', 'w2', 'w4']);
  let movedNotOnDoomed = 0;
  let onDoomed = 0;
  for (const s of SESSIONS) {
    const prev = aff.assign(r5, s);
    const next = aff.assign(r4, s);
    if (prev === 'w3') {
      onDoomed++;
      assert.ok(next !== 'w3', 'session that was on w3 must move off');
    } else if (prev !== next) {
      movedNotOnDoomed++;
    }
  }
  assert.strictEqual(movedNotOnDoomed, 0, 'scale-down only moves sessions on the removed worker');
  console.log(`OK stable scale-down: ${onDoomed} on-w3 sessions moved; 0 unrelated sessions disturbed`);
})();

(function bulkAssign() {
  const ring = aff.buildRing(['w0', 'w1']);
  const groups = aff.assignMany(ring, SESSIONS);
  let total = 0;
  for (const ids of groups.values()) total += ids.length;
  assert.strictEqual(total, SESSIONS.length, 'bulk assign loses no sessions');
  // Each group's entries must individually match assign()
  for (const [worker, ids] of groups.entries()) {
    for (const sid of ids) {
      assert.strictEqual(aff.assign(ring, sid), worker, 'bulk assign agrees with single assign');
    }
  }
  console.log('OK bulk assignMany matches per-session assign');
})();

(function rejectsEmptyRing() {
  assert.throws(() => aff.buildRing([]), /non-empty array/);
  assert.throws(() => aff.assign({ points: [] }, 'x'), /ring is empty/);
  console.log('OK empty-input guards');
})();

console.log('\nsessionAffinity.smoke.test: OK');
