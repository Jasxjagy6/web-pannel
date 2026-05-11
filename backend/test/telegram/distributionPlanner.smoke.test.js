/**
 * Smoke test for the new distribution planner.
 *
 * Pins down the institutional defaults so a future tune doesn't
 * silently change planner output for existing operator workflows.
 */

'use strict';

const assert = require('assert');
const planner = require('../../src/services/distributionPlanner');

function nearly(actual, expected, tol = 0) {
  return Math.abs(actual - expected) <= tol;
}

// ---------------------------------------------------------------------------
// Auto mode — group_add
// ---------------------------------------------------------------------------

(function autoGroupTinyJobAggressive() {
  // 27 users / 5 sessions (the reported case). Without the tiny-job
  // band this used to fall into the 5–20 ratio band (30–60s per-item
  // delay × 2-3 rounds × 60–180s cooldown ≈ 20+ minutes for a job
  // operators expected to finish in under five). The tiny-job band
  // should drop per-item delay to 5–15s and skip the cooldown.
  const p = planner.plan({
    totalItems: 27,
    sessionIds: Array.from({ length: 5 }, (_, i) => i + 1),
    workType: 'group_add',
    mode: 'auto',
  });
  assert.strictEqual(p.totalItems, 27);
  assert.strictEqual(p.sessionCount, 5);
  // Tiny-job band relaxes pacing aggressively.
  assert.ok(
    p.itemDelayMsMax <= 15_000,
    `expected itemDelayMsMax <= 15000, got ${p.itemDelayMsMax}`
  );
  assert.ok(
    p.itemDelayMsMin <= 5_000,
    `expected itemDelayMsMin <= 5000, got ${p.itemDelayMsMin}`
  );
  assert.strictEqual(
    p.cooldownSecMin,
    0,
    `expected zero min cooldown, got ${p.cooldownSecMin}`
  );
  assert.ok(
    p.cooldownSecMax <= 30,
    `expected cooldownSecMax <= 30, got ${p.cooldownSecMax}`
  );
  // perSessionBurst should be ceil(ratio) ≤ 4 ceiling.
  assert.ok(p.perSessionBurst >= 1 && p.perSessionBurst <= 4);
  // sum of per-session counts == totalItems.
  const sum = p.perSession.reduce((a, s) => a + s.count, 0);
  assert.strictEqual(sum, 27);
  console.log('autoGroupTinyJobAggressive: OK');
})();

(function autoGroupTinyJobBoundary() {
  // 51 items: just over the tiny-job threshold. Should fall back to
  // the legacy 5–20 / >20 bands (slower pacing).
  const p = planner.plan({
    totalItems: 51,
    sessionIds: Array.from({ length: 5 }, (_, i) => i + 1),
    workType: 'group_add',
    mode: 'auto',
  });
  // 51 / 5 = 10.2 → legacy 5–20 band → 30–60s per-item, ≥60s cooldown.
  assert.ok(
    p.itemDelayMsMin >= 30_000,
    `boundary: expected legacy per-item delay, got ${p.itemDelayMsMin}`
  );
  assert.ok(
    p.cooldownSecMin >= 60,
    `boundary: expected legacy cooldown, got ${p.cooldownSecMin}`
  );
  console.log('autoGroupTinyJobBoundary: OK');
})();

(function autoMessageTinyJob() {
  // bulk_message tiny job: 10 messages × 4 sessions.
  const p = planner.plan({
    totalItems: 10,
    sessionIds: [1, 2, 3, 4],
    workType: 'bulk_message',
    mode: 'auto',
  });
  assert.ok(p.itemDelayMsMax <= 4_000);
  assert.strictEqual(p.cooldownSecMin, 0);
  console.log('autoMessageTinyJob: OK');
})();

(function autoGroupSmallRatio() {
  // 200 users / 100 sessions -> 2 per session, single pass, no cooldown.
  const p = planner.plan({
    totalItems: 200,
    sessionIds: Array.from({ length: 100 }, (_, i) => i + 1),
    workType: 'group_add',
    mode: 'auto',
  });
  assert.strictEqual(p.mode, 'auto');
  assert.strictEqual(p.totalItems, 200);
  assert.strictEqual(p.sessionCount, 100);
  assert.strictEqual(p.perSessionBurst, 2);
  assert.strictEqual(p.rounds, 1);
  assert.strictEqual(p.cooldownSecMax, 0);
  // Every session gets exactly 2.
  for (const s of p.perSession) assert.strictEqual(s.count, 2);
  console.log('autoGroupSmallRatio: OK');
})();

(function autoGroupMediumRatio() {
  // 200 users / 20 sessions = 10/session; band 2 -> burst 4, cooldown.
  const p = planner.plan({
    totalItems: 200,
    sessionIds: Array.from({ length: 20 }, (_, i) => i + 1),
    workType: 'group_add',
    mode: 'auto',
  });
  assert.strictEqual(p.perSessionBurst, 4);
  assert.ok(p.rounds >= 3, `expected >=3 rounds, got ${p.rounds}`);
  assert.ok(p.cooldownSecMin >= 60);
  assert.ok(p.cooldownSecMax <= 300);
  // sum of all per-session counts == totalItems
  const sum = p.perSession.reduce((a, s) => a + s.count, 0);
  assert.strictEqual(sum, 200);
  console.log('autoGroupMediumRatio: OK');
})();

(function autoGroupLargeRatio() {
  // 5000 users / 10 sessions = 500/session.
  //
  // The redesigned `group_add` policy hard-clamps `perSessionBurst`
  // to `GROUP_ADD_DEFAULT_MAX_BURST` (4) across all auto bands so a
  // single session never gets pushed into PEER_FLOOD territory in
  // one rotation. The legacy 70-burst band is still used to choose
  // the cooldown range (1-5 min between rotations) but the actual
  // burst the runner executes is clamped to 4.
  const p = planner.plan({
    totalItems: 5000,
    sessionIds: Array.from({ length: 10 }, (_, i) => i + 1),
    workType: 'group_add',
    mode: 'auto',
  });
  assert.strictEqual(p.perSessionBurst, 4,
    `expected hard clamp at 4, got ${p.perSessionBurst}`);
  assert.strictEqual(p.maxPerSessionBurst, 4);
  // 5000 / (10 sessions × 4) = 125 rounds.
  assert.ok(p.rounds >= 100, `expected >=100 rounds, got ${p.rounds}`);
  assert.strictEqual(p.cooldownSecMin, 60);
  assert.strictEqual(p.cooldownSecMax, 300);
  console.log('autoGroupLargeRatio: OK');
})();

(function autoGroupLargeRatioOperatorOverride() {
  // Operators who really know their fleet can opt out of the
  // institutional ceiling via `maxPerSessionBurst`.
  const p = planner.plan({
    totalItems: 5000,
    sessionIds: Array.from({ length: 10 }, (_, i) => i + 1),
    workType: 'group_add',
    mode: 'auto',
    maxPerSessionBurst: 70,
  });
  assert.strictEqual(p.perSessionBurst, 70,
    `with explicit override should be 70, got ${p.perSessionBurst}`);
  assert.strictEqual(p.maxPerSessionBurst, 70);
  console.log('autoGroupLargeRatioOperatorOverride: OK');
})();

// ---------------------------------------------------------------------------
// Auto mode — bulk_message
// ---------------------------------------------------------------------------

(function autoMessageSmall() {
  const p = planner.plan({
    totalItems: 100,
    sessionIds: [1, 2, 3, 4],
    workType: 'bulk_message',
    mode: 'auto',
  });
  // ratio 25 → small band, burst = ceil(25) = 25.
  assert.strictEqual(p.perSessionBurst, 25);
  assert.strictEqual(p.rounds, 1);
  console.log('autoMessageSmall: OK');
})();

(function autoMessageBig() {
  const p = planner.plan({
    totalItems: 5000,
    sessionIds: [1, 2, 3, 4, 5],
    workType: 'bulk_message',
    mode: 'auto',
  });
  // ratio 1000 → large band, burst 100, cooldown 60-180.
  assert.strictEqual(p.perSessionBurst, 100);
  assert.ok(p.cooldownSecMin >= 60);
  assert.ok(p.cooldownSecMax <= 180);
  console.log('autoMessageBig: OK');
})();

// ---------------------------------------------------------------------------
// Manual mode passes user knobs through (clamped)
// ---------------------------------------------------------------------------

(function manualPassthrough() {
  // Manual mode still honours operator knobs, but the redesigned
  // `group_add` policy clamps `perSessionBurst` to the hard
  // institutional ceiling (4 by default). Cooldown / item-delay
  // pass through verbatim.
  const p = planner.plan({
    totalItems: 200,
    sessionIds: [1, 2, 3, 4],
    workType: 'group_add',
    mode: 'manual',
    perSessionBurst: 25,
    cooldownSecMin: 90,
    cooldownSecMax: 240,
    itemDelayMsMin: 20_000,
    itemDelayMsMax: 45_000,
  });
  assert.strictEqual(p.perSessionBurst, 4,
    `manual perSessionBurst should be clamped to 4, got ${p.perSessionBurst}`);
  assert.strictEqual(p.maxPerSessionBurst, 4);
  assert.strictEqual(p.cooldownSecMin, 90);
  assert.strictEqual(p.cooldownSecMax, 240);
  assert.strictEqual(p.itemDelayMsMin, 20_000);
  assert.strictEqual(p.itemDelayMsMax, 45_000);
  console.log('manualPassthrough: OK');
})();

(function manualPassthroughWithExplicitCap() {
  // When operators explicitly raise `maxPerSessionBurst`, manual
  // values up to that ceiling pass through unmodified.
  const p = planner.plan({
    totalItems: 200,
    sessionIds: [1, 2, 3, 4],
    workType: 'group_add',
    mode: 'manual',
    perSessionBurst: 25,
    maxPerSessionBurst: 30,
    cooldownSecMin: 90,
    cooldownSecMax: 240,
    itemDelayMsMin: 20_000,
    itemDelayMsMax: 45_000,
  });
  assert.strictEqual(p.perSessionBurst, 25);
  assert.strictEqual(p.maxPerSessionBurst, 30);
  console.log('manualPassthroughWithExplicitCap: OK');
})();

(function manualSwapsReversedRanges() {
  const p = planner.plan({
    totalItems: 50,
    sessionIds: [1, 2],
    workType: 'group_add',
    mode: 'manual',
    cooldownSecMin: 300,
    cooldownSecMax: 60,
  });
  // Reversed pair must be normalised to (60, 300).
  assert.strictEqual(p.cooldownSecMin, 60);
  assert.strictEqual(p.cooldownSecMax, 300);
  console.log('manualSwapsReversedRanges: OK');
})();

(function manualClampsToLimits() {
  const p = planner.plan({
    totalItems: 50,
    sessionIds: [1, 2],
    workType: 'bulk_message',
    mode: 'manual',
    perSessionBurst: 99999,
    cooldownSecMax: 99999,
  });
  assert.ok(p.perSessionBurst <= planner.LIMITS.perSessionBurst.max);
  assert.ok(p.cooldownSecMax <= planner.LIMITS.cooldownSec.max);
  console.log('manualClampsToLimits: OK');
})();

// ---------------------------------------------------------------------------
// buildQueues round-robin layout
// ---------------------------------------------------------------------------

(function buildQueuesRoundRobin() {
  const items = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const { queues, schedule } = planner.buildQueues(items, ['s1', 's2'], 2);
  assert.deepStrictEqual(queues.get('s1'), ['A', 'B', 'E', 'F', 'I', 'J']);
  assert.deepStrictEqual(queues.get('s2'), ['C', 'D', 'G', 'H']);
  assert.strictEqual(schedule.length, 3);
  assert.deepStrictEqual(schedule[0], [
    { sessionId: 's1', items: ['A', 'B'] },
    { sessionId: 's2', items: ['C', 'D'] },
  ]);
  console.log('buildQueuesRoundRobin: OK');
})();

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

(function zeroItems() {
  const p = planner.plan({
    totalItems: 0,
    sessionIds: [1, 2],
    workType: 'group_add',
    mode: 'auto',
  });
  assert.strictEqual(p.rounds, 0);
  assert.strictEqual(p.totalItems, 0);
  console.log('zeroItems: OK');
})();

(function rejectsBadInput() {
  assert.throws(() =>
    planner.plan({ totalItems: 1, sessionIds: [], workType: 'group_add' })
  , /at least one session/);
  assert.throws(() =>
    planner.plan({ totalItems: 1, sessionIds: [1], workType: 'invalid' })
  , /invalid workType/);
  assert.throws(() =>
    planner.plan({ totalItems: 1, sessionIds: [1], workType: 'group_add', mode: 'wat' })
  , /invalid mode/);
  console.log('rejectsBadInput: OK');
})();

console.log('distributionPlanner.smoke.test: OK');
