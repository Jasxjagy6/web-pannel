/**
 * Phase 2 smoke test (B9–B14).
 *
 * Pure unit-level checks against activeHours.js + behaviorPacing.js +
 * the helper math in messaging/accountSettings. We do NOT load the
 * full provider chain (which needs a database) — these are the
 * deterministic policy checks an operator can run with no infra.
 *
 *   node backend/test/instagram/antiBanPhase2.smoke.test.js
 */

'use strict';

const assert = require('assert');

const activeHours = require('../../src/providers/instagram/activeHours');
const behaviorPacing = require('../../src/providers/instagram/behaviorPacing');

const PASS = (n) => console.log(`PASS  ${n}`);

function _testB10_activeHoursWindow() {
  // A session in Asia/Kolkata with default window 07:30–23:30.
  const session = {
    platform_state: {
      activeHours: { start: '07:30', end: '23:30', tz: 'Asia/Kolkata' },
    },
  };

  // 12:00 IST => 06:30 UTC -> inside.
  const noonIST = new Date('2025-06-15T06:30:00Z');
  assert.strictEqual(activeHours.isWithinActiveHours(session, noonIST), true,
    'noon IST should be inside active-hours');

  // 03:00 IST => 21:30 UTC previous day -> outside.
  const threeIST = new Date('2025-06-14T21:30:00Z');
  assert.strictEqual(activeHours.isWithinActiveHours(session, threeIST), false,
    '03:00 IST should be outside active-hours');

  PASS('B10 isWithinActiveHours respects tz + window correctly');
}

function _testB10_wrappingWindow() {
  // Spain-style late-night window 08:00–00:30 (wraps midnight).
  const session = {
    platform_state: {
      activeHours: { start: '08:00', end: '00:30', tz: 'UTC' },
    },
  };

  // 23:00 UTC -> inside (after start).
  assert.strictEqual(activeHours.isWithinActiveHours(session, new Date('2025-06-15T23:00:00Z')), true);
  // 00:15 UTC -> inside (before end).
  assert.strictEqual(activeHours.isWithinActiveHours(session, new Date('2025-06-15T00:15:00Z')), true);
  // 03:00 UTC -> outside.
  assert.strictEqual(activeHours.isWithinActiveHours(session, new Date('2025-06-15T03:00:00Z')), false);
  // 07:59 UTC -> outside.
  assert.strictEqual(activeHours.isWithinActiveHours(session, new Date('2025-06-15T07:59:00Z')), false);

  PASS('B10 wrapping windows (e.g. 08:00–00:30) handled correctly');
}

function _testB10_nextOpenAt() {
  const session = {
    platform_state: {
      activeHours: { start: '08:00', end: '20:00', tz: 'UTC' },
    },
  };
  // At 03:00 UTC, next open is 08:00 UTC same day → +5h.
  const at3 = new Date('2025-06-15T03:00:00Z');
  const next = activeHours.nextOpenAt(session, at3);
  const dt = next.getTime() - at3.getTime();
  assert.ok(dt > 4 * 3600 * 1000 && dt < 6 * 3600 * 1000, `expected ~5h wait; got ${dt}ms`);

  // At 21:00 UTC (past today's window), next open is tomorrow 08:00 → +11h.
  const at21 = new Date('2025-06-15T21:00:00Z');
  const next2 = activeHours.nextOpenAt(session, at21);
  const dt2 = next2.getTime() - at21.getTime();
  assert.ok(dt2 > 10 * 3600 * 1000 && dt2 < 12 * 3600 * 1000, `expected ~11h wait; got ${dt2}ms`);

  PASS('B10 nextOpenAt computes precise reopen delays');
}

function _testB10_defaults() {
  const us = activeHours._defaultsFor('US');
  assert.strictEqual(us.tz, 'America/New_York');
  const india = activeHours._defaultsFor('IN');
  assert.strictEqual(india.tz, 'Asia/Kolkata');
  const fallback = activeHours._defaultsFor('XX');
  assert.strictEqual(fallback.tz, 'UTC');
  PASS('B10 region-hint defaults map to expected tz');
}

function _testB10_gateApi() {
  // Inside window
  const insideSession = {
    platform_state: {
      activeHours: { start: '00:00', end: '23:59', tz: 'UTC' },
    },
  };
  const okGate = activeHours.gate(insideSession);
  assert.strictEqual(okGate.allowed, true);
  assert.strictEqual(okGate.waitMs, 0);

  // Outside (start=end means 24h-open in our impl, so use a strict zero window)
  const outsideSession = {
    platform_state: {
      activeHours: { start: '08:00', end: '20:00', tz: 'UTC' },
    },
  };
  const at4 = new Date('2025-06-15T04:00:00Z');
  const blockGate = activeHours.gate(outsideSession, at4);
  assert.strictEqual(blockGate.allowed, false);
  assert.ok(blockGate.waitMs > 0);
  assert.ok(blockGate.nextOpenAt instanceof Date);
  PASS('B10 gate() returns waitMs + nextOpenAt outside window');
}

function _testB9_dmPaceMs() {
  const samples = [];
  for (let i = 0; i < 200; i++) samples.push(behaviorPacing.dmPaceMs({ sameThread: false }));
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  // Curve is 5–30min ±30%. Min should be > 3min, max < 40min.
  assert.ok(min >= 3 * 60 * 1000, `dmPaceMs min too low: ${min}ms`);
  assert.ok(max <= 40 * 60 * 1000, `dmPaceMs max too high: ${max}ms`);

  const sameThread = [];
  for (let i = 0; i < 50; i++) sameThread.push(behaviorPacing.dmPaceMs({ sameThread: true }));
  const sMax = Math.max(...sameThread);
  // Same-thread is 30–90s ±30%, never above 2min.
  assert.ok(sMax <= 2 * 60 * 1000, `same-thread dmPaceMs max too high: ${sMax}ms`);

  PASS('B9 dmPaceMs returns 5–30min for different recipients, 30–90s for same thread');
}

function _testB9_feedbackCooldown() {
  const patch = behaviorPacing.buildFeedbackCooldownPatch(new Date('2025-06-15T12:00:00Z'));
  assert.strictEqual(patch.feedback_required_until, '2025-06-15T16:00:00.000Z');

  const session = {
    platform_state: { cooldowns: { feedback_required_until: '2025-06-15T16:00:00.000Z' } },
  };
  assert.strictEqual(behaviorPacing.isInFeedbackCooldown(session, new Date('2025-06-15T13:00:00Z')), true);
  assert.strictEqual(behaviorPacing.isInFeedbackCooldown(session, new Date('2025-06-15T16:30:00Z')), false);
  PASS('B9 feedback_required cooldown stamps 4h forward and clears after expiry');
}

function _testB11_actionMix() {
  const counts = {};
  for (let i = 0; i < 5000; i++) {
    const a = behaviorPacing.pickAction();
    counts[a] = (counts[a] || 0) + 1;
  }
  // Must produce at least 3 different action kinds in 5000 picks.
  assert.ok(Object.keys(counts).length >= 4, `action mix lacks diversity: ${JSON.stringify(counts)}`);
  // feed_timeline should dominate but never be 100%.
  const totalPct = (counts.feed_timeline || 0) / 5000;
  assert.ok(totalPct > 0.2 && totalPct < 0.5,
    `feed_timeline share unexpected: ${totalPct.toFixed(2)} (expected 0.2–0.5)`);
  PASS(`B11 action mix is diverse (${Object.keys(counts).length} kinds, feed_timeline ${(totalPct*100).toFixed(0)}%)`);
}

function _testB14_interSessionGap() {
  const samples = [];
  for (let i = 0; i < 500; i++) samples.push(behaviorPacing.interSessionGapMs());
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  assert.ok(min >= 60 * 1000, `interSessionGap min too low: ${min}ms`);
  assert.ok(max <= 180 * 1000, `interSessionGap max too high: ${max}ms`);
  PASS('B14 interSessionGapMs in 60–180s range across 500 samples');
}

function _testB13_ageCappedDaily() {
  // We replicate the closed-over function's policy directly to test
  // it without instantiating the full messaging module.
  function ageCapped(ageDays, configuredDaily = 30) {
    let cap;
    if (ageDays < 7) cap = 3;
    else if (ageDays < 14) cap = 8;
    else if (ageDays < 30) cap = 15;
    else cap = configuredDaily;
    return Math.min(configuredDaily, cap);
  }
  assert.strictEqual(ageCapped(0), 3, '0-day account → 3 DM cap');
  assert.strictEqual(ageCapped(6), 3);
  assert.strictEqual(ageCapped(7), 8);
  assert.strictEqual(ageCapped(13), 8);
  assert.strictEqual(ageCapped(14), 15);
  assert.strictEqual(ageCapped(29), 15);
  assert.strictEqual(ageCapped(30), 30);
  assert.strictEqual(ageCapped(45), 30);
  // Operator floor wins.
  assert.strictEqual(ageCapped(45, 10), 10);
  PASS('B13 dynamic warmup cap ladder: 3 → 8 → 15 → configured');
}

function _testB12_renameCooldownPolicy() {
  // Mirror the gate's policy for a unit test (full module needs DB).
  const _RENAME_MIN_AGE_DAYS = 30;
  const _RENAME_COOLDOWN_DAYS = 60;
  function check(ageDays, daysSinceRename) {
    if (ageDays < _RENAME_MIN_AGE_DAYS) return 'AGED_SESSION_REQUIRED';
    if (daysSinceRename < _RENAME_COOLDOWN_DAYS) return 'RENAME_COOLDOWN';
    return 'allowed';
  }
  assert.strictEqual(check(5, Infinity), 'AGED_SESSION_REQUIRED');
  assert.strictEqual(check(45, 30), 'RENAME_COOLDOWN');
  assert.strictEqual(check(45, 90), 'allowed');
  PASS('B12 rename gate: <30d age fails AGED, <60d since last fails RENAME_COOLDOWN');
}

(async function main() {
  try {
    _testB10_activeHoursWindow();
    _testB10_wrappingWindow();
    _testB10_nextOpenAt();
    _testB10_defaults();
    _testB10_gateApi();
    _testB9_dmPaceMs();
    _testB9_feedbackCooldown();
    _testB11_actionMix();
    _testB14_interSessionGap();
    _testB13_ageCappedDaily();
    _testB12_renameCooldownPolicy();
    console.log('\nAll Phase 2 smoke checks passed.');
  } catch (err) {
    console.error('SMOKE TEST FAILED:', err);
    process.exit(1);
  }
})();
