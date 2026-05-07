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
  // 5000 users / 10 sessions = 500/session => 70 burst, 1-5min cooldown.
  const p = planner.plan({
    totalItems: 5000,
    sessionIds: Array.from({ length: 10 }, (_, i) => i + 1),
    workType: 'group_add',
    mode: 'auto',
  });
  assert.strictEqual(p.perSessionBurst, 70);
  assert.ok(p.rounds >= 7);
  assert.strictEqual(p.cooldownSecMin, 60);
  assert.strictEqual(p.cooldownSecMax, 300);
  console.log('autoGroupLargeRatio: OK');
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
  assert.strictEqual(p.perSessionBurst, 25);
  assert.strictEqual(p.cooldownSecMin, 90);
  assert.strictEqual(p.cooldownSecMax, 240);
  assert.strictEqual(p.itemDelayMsMin, 20_000);
  assert.strictEqual(p.itemDelayMsMax, 45_000);
  console.log('manualPassthrough: OK');
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
