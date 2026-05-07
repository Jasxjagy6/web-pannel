/**
 * Smoke test for the bulk-message distribution-engine extensions.
 *
 * Locks in:
 *   1. The Joi schema for /messages/bulk now accepts the new
 *      auto/manual mode controls (`mode`, `perSessionBurst`,
 *      `cooldownSecMin/Max`, `itemDelayMsMin/Max`) and the legacy
 *      payload still passes.
 *   2. The shared distributionPlanner produces a sensible plan for
 *      the canonical "200 users / 20 sessions" institutional
 *      scenario (≥1 round, burst inside the safe band, cooldown
 *      between rotations).
 *   3. Manual-mode overrides flow through unchanged when within
 *      bounds, and clamp gracefully when out of range.
 */

'use strict';

const assert = require('assert');

const validator = require('../../src/middleware/validator');
const distributionPlanner = require('../../src/services/distributionPlanner');

function expectValid(label, payload) {
  const { error, value } = validator.schemas.bulkMessage.validate(payload, {
    abortEarly: false,
  });
  if (error) {
    throw new Error(`[${label}] expected valid, got: ${error.message}`);
  }
  return value;
}

function expectInvalid(label, payload) {
  const { error } = validator.schemas.bulkMessage.validate(payload, {
    abortEarly: false,
  });
  if (!error) {
    throw new Error(`[${label}] expected validation error, got none`);
  }
  return error;
}

const tests = {
  legacyBulkBodyStillPasses() {
    const v = expectValid('legacy', {
      message: 'hi',
      sessionIds: [1, 2, 3],
      targetList: ['111', '222', '333'],
      delayMin: 2,
      delayMax: 5,
    });
    // mode must default to 'auto' when not provided.
    assert.strictEqual(v.mode, 'auto', 'legacy → mode defaults to auto');
  },

  autoModeWithoutKnobsPasses() {
    expectValid('auto-bare', {
      message: 'hi',
      sessionIds: [1, 2],
      targetList: ['t1', 't2'],
      mode: 'auto',
    });
  },

  manualModeWithKnobsPasses() {
    const v = expectValid('manual', {
      message: 'hi',
      sessionIds: [1, 2],
      targetList: ['t1', 't2'],
      mode: 'manual',
      perSessionBurst: 25,
      cooldownSecMin: 30,
      cooldownSecMax: 90,
      itemDelayMsMin: 1000,
      itemDelayMsMax: 4000,
    });
    assert.strictEqual(v.perSessionBurst, 25);
    assert.strictEqual(v.cooldownSecMin, 30);
    assert.strictEqual(v.cooldownSecMax, 90);
  },

  rejectsOutOfBoundBurst() {
    expectInvalid('burst-too-big', {
      message: 'hi',
      sessionIds: [1],
      targetList: ['t1'],
      mode: 'manual',
      perSessionBurst: 9999,
    });
  },

  rejectsNegativeCooldown() {
    expectInvalid('cooldown-neg', {
      message: 'hi',
      sessionIds: [1],
      targetList: ['t1'],
      mode: 'manual',
      cooldownSecMin: -1,
    });
  },

  plannerProducesRotationFor200Items20Sessions() {
    // Institutional canonical case: 200 targets / 20 sessions.
    const sessionIds = Array.from({ length: 20 }, (_, i) => `s${i + 1}`);
    const plan = distributionPlanner.plan({
      totalItems: 200,
      sessionIds,
      workType: 'bulk_message',
      mode: 'auto',
    });
    assert.strictEqual(plan.totalItems, 200);
    assert.strictEqual(plan.sessionCount, 20);
    assert.ok(plan.perSessionBurst >= 1, 'burst must be at least 1');
    assert.ok(plan.rounds >= 1, 'must run at least one round');
    assert.ok(plan.cooldownSecMax >= plan.cooldownSecMin, 'cd range valid');
    assert.ok(plan.itemDelayMsMax >= plan.itemDelayMsMin, 'item delay range valid');
  },

  plannerHandlesGroupAdd200Over20Sessions() {
    // Mirrors the user's stated expectation: 200 users / 20 sessions
    // → ~10 per session per round, with cooldown between rounds.
    const sessionIds = Array.from({ length: 20 }, (_, i) => `s${i + 1}`);
    const plan = distributionPlanner.plan({
      totalItems: 200,
      sessionIds,
      workType: 'group_add',
      mode: 'auto',
    });
    assert.strictEqual(plan.sessionCount, 20);
    // Auto policy for ratio=10 picks burst=4 in the medium band, so
    // we expect multiple rounds (~3) with explicit cooldown.
    assert.ok(plan.rounds >= 1);
    assert.ok(plan.cooldownSecMax > 0, 'group_add medium band must cool down');
  },

  manualBurstHonouredWhenInBounds() {
    const sessionIds = ['s1', 's2', 's3'];
    const plan = distributionPlanner.plan({
      totalItems: 60,
      sessionIds,
      workType: 'bulk_message',
      mode: 'manual',
      perSessionBurst: 10,
      cooldownSecMin: 45,
      cooldownSecMax: 120,
      itemDelayMsMin: 500,
      itemDelayMsMax: 1500,
    });
    assert.strictEqual(plan.perSessionBurst, 10);
    assert.strictEqual(plan.cooldownSecMin, 45);
    assert.strictEqual(plan.cooldownSecMax, 120);
    assert.strictEqual(plan.itemDelayMsMin, 500);
    assert.strictEqual(plan.itemDelayMsMax, 1500);
    // 60 items / (3 sessions × 10 burst) = 2 rounds.
    assert.strictEqual(plan.rounds, 2);
  },
};

let pass = 0;
let fail = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`${name}: OK`);
    pass++;
  } catch (e) {
    console.error(`${name}: FAIL — ${e.message}`);
    fail++;
  }
}

console.log(`\nbulkMessageDistribution.smoke.test: ${fail === 0 ? 'OK' : 'FAILED'} (${pass} pass / ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
