/**
 * Smoke test for the cross-session start-stagger introduced to fix
 * the Mass-DM PEER_FLOOD failure mode.
 *
 * Symptom (Job 54 in the operator's logs):
 *   33 sessions × 1 target → every worker popped its only item in
 *   the same sub-second and Telegram raised account-level
 *   PEER_FLOOD on every session in ~1s. The legacy `itemDelayMs*`
 *   knob doesn't help because it only paces successive items inside
 *   a single session's burst, and each session here had exactly one
 *   item.
 *
 * Fix:
 *   `runWorkerPool({ startStaggerMsMin, startStaggerMsMax })` makes
 *   worker `i` sleep `i × pickDelay(min, max)` ms before claiming
 *   its first item. The total wall time grows with the number of
 *   workers — that's the point: it spreads the burst out.
 *
 * This test exercises the offset with a no-op `handle` so it
 * completes in well under a second.
 */

'use strict';

const assert = require('assert');
const { run: runWorkerPool } = require('../../src/utils/sessionWorkerPool');

async function staggerSpacesFirstAttempts() {
  const sessions = Array.from({ length: 5 }, (_, i) => ({
    id: String(100 + i),
  }));
  const items = sessions.map((s) => ({ sessionId: s.id, target: 'X' }));

  const attemptTimes = [];
  const t0 = Date.now();

  await runWorkerPool({
    sessions,
    items,
    concurrency: sessions.length,
    perSessionBurst: 1,
    cooldownMsMin: 0,
    cooldownMsMax: 0,
    itemDelayMsMin: 0,
    itemDelayMsMax: 0,
    startStaggerMsMin: 60,
    startStaggerMsMax: 60,
    maxAttemptsPerItem: 1,
    attempt: async (_ctx) => {
      attemptTimes.push(Date.now() - t0);
      return { status: 'ok' };
    },
  });

  assert.strictEqual(attemptTimes.length, 5);
  attemptTimes.sort((a, b) => a - b);

  // First worker fires immediately, subsequent workers each wait
  // an additional ~60 ms. We allow loose lower bounds (timers in
  // CI can be a couple of ms behind) and a generous upper bound
  // (event-loop jitter).
  for (let i = 1; i < attemptTimes.length; i++) {
    const gap = attemptTimes[i] - attemptTimes[i - 1];
    assert.ok(
      gap >= 30 && gap <= 250,
      `worker ${i} attempt gap should be ~60ms, got ${gap}ms`
    );
  }
  console.log('staggerSpacesFirstAttempts: OK');
}

async function defaultStaggerIsZero() {
  // When the caller leaves the knobs at the default 0, behaviour is
  // unchanged — all 5 workers can claim their first item
  // essentially in parallel.
  const sessions = Array.from({ length: 5 }, (_, i) => ({
    id: String(200 + i),
  }));
  const items = sessions.map((s) => ({ sessionId: s.id, target: 'X' }));

  const attemptTimes = [];
  const t0 = Date.now();

  await runWorkerPool({
    sessions,
    items,
    concurrency: sessions.length,
    perSessionBurst: 1,
    cooldownMsMin: 0,
    cooldownMsMax: 0,
    itemDelayMsMin: 0,
    itemDelayMsMax: 0,
    maxAttemptsPerItem: 1,
    attempt: async () => {
      attemptTimes.push(Date.now() - t0);
      return { status: 'ok' };
    },
  });

  assert.strictEqual(attemptTimes.length, 5);
  attemptTimes.sort((a, b) => a - b);
  const spread = attemptTimes[attemptTimes.length - 1] - attemptTimes[0];
  assert.ok(
    spread < 100,
    `default-stagger should have <100ms spread, got ${spread}ms`
  );
  console.log('defaultStaggerIsZero: OK');
}

(async () => {
  try {
    await staggerSpacesFirstAttempts();
    await defaultStaggerIsZero();
    console.log('sessionWorkerPoolStagger.smoke.test: OK');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
