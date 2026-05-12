/**
 * Smoke test for cohortPlanner (monitor V2).
 *
 * Pure-function tests: no DB, no Redis, no Telegram.
 */

'use strict';

const assert = require('assert');
const planner = require('../../src/services/monitor/cohortPlanner');

const NOW = new Date('2025-01-01T12:00:00Z');

function mkSession(over = {}) {
  return {
    sessionId: over.sessionId || 1,
    ownerUserId: 100,
    isLoggedIn: true,
    riskScore: 0.1,
    dcId: 4,
    proxyCountry: 'DE',
    lastShiftEndedAt: null,
    lastShiftEndedOnChatId: null,
    fatigueOnThisChat: 0.0,
    fatigueGlobal: 0.0,
    activeShifts: 0,
    ...over,
  };
}

function mkChat(over = {}) {
  return {
    id: 42,
    targetId: '-1001234567890',
    targetType: 'group',
    detectedMode: 'admin_only',
    cohortSize: 1,
    cohortSizePinned: false,
    eventsPerMinuteRecent: 5,
    excludedSessionIds: [],
    preferredSessionIds: [],
    ...over,
  };
}

function mkJob(over = {}) {
  return {
    id: 7,
    userId: 100,
    cohortSizeDefault: 1,
    shiftMinSeconds: 1800,
    shiftMaxSeconds: 5400,
    overlapSeconds: 60,
    perSessionEventBudget: 20000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Cold-start with empty active list → fills cohort with the lowest-risk,
//    lowest-fatigue session.
// ---------------------------------------------------------------------------
(function coldStartFillsCohort() {
  const pool = [
    mkSession({ sessionId: 1, riskScore: 0.4, fatigueOnThisChat: 0.3 }),
    mkSession({ sessionId: 2, riskScore: 0.1, fatigueOnThisChat: 0.1 }),
    mkSession({ sessionId: 3, riskScore: 0.6, fatigueOnThisChat: 0.0 }),
  ];
  const out = planner.plan({
    now: NOW,
    job: mkJob(),
    chat: mkChat({ eventsPerMinuteRecent: 5 }),
    pool,
    activeShifts: [],
  });
  assert.strictEqual(out.cohortSize, 1, 'cold chat → cohort=1');
  assert.strictEqual(out.startNow.length, 1, 'one shift starts immediately');
  assert.strictEqual(out.startNow[0].sessionId, 2, 'low-risk low-fatigue wins');
  assert.ok(out.startNow[0].plannedEnd > NOW);
  assert.ok(out.startNow[0].reason.includes('risk='));
  console.log('coldStartFillsCohort: OK');
})();

// ---------------------------------------------------------------------------
// 2. Hot chat (>= 100 ev/min) gets cohort=3.
// ---------------------------------------------------------------------------
(function hotChatGetsBiggerCohort() {
  const pool = Array.from({ length: 8 }, (_, i) =>
    mkSession({ sessionId: i + 1, riskScore: 0.1 + i * 0.05 })
  );
  const out = planner.plan({
    now: NOW,
    job: mkJob(),
    chat: mkChat({ eventsPerMinuteRecent: 200 }),
    pool,
    activeShifts: [],
  });
  assert.strictEqual(out.cohortSize, 3);
  assert.strictEqual(out.startNow.length, 3);
  // All distinct.
  const ids = new Set(out.startNow.map((s) => s.sessionId));
  assert.strictEqual(ids.size, 3);
  console.log('hotChatGetsBiggerCohort: OK');
})();

// ---------------------------------------------------------------------------
// 3. Risk gate: anything with risk >= 0.7 is excluded.
// ---------------------------------------------------------------------------
(function riskGateExcludes() {
  const pool = [
    mkSession({ sessionId: 1, riskScore: 0.95 }),
    mkSession({ sessionId: 2, riskScore: 0.8 }),
    mkSession({ sessionId: 3, riskScore: 0.2 }),
  ];
  const out = planner.plan({
    now: NOW,
    job: mkJob(),
    chat: mkChat(),
    pool,
    activeShifts: [],
  });
  assert.strictEqual(out.startNow.length, 1);
  assert.strictEqual(out.startNow[0].sessionId, 3);
  console.log('riskGateExcludes: OK');
})();

// ---------------------------------------------------------------------------
// 4. Consecutive guard: a session that JUST finished a shift on this
//    chat can't re-grab it.
// ---------------------------------------------------------------------------
(function consecutiveGuard() {
  const recent = new Date(NOW.getTime() - 60 * 1000); // 1 min ago
  const pool = [
    mkSession({
      sessionId: 1,
      riskScore: 0.05,
      lastShiftEndedAt: recent,
      lastShiftEndedOnChatId: 42,
    }),
    mkSession({ sessionId: 2, riskScore: 0.3 }),
  ];
  const out = planner.plan({
    now: NOW,
    job: mkJob(),
    chat: mkChat(),
    pool,
    activeShifts: [],
  });
  assert.strictEqual(out.startNow.length, 1);
  assert.strictEqual(
    out.startNow[0].sessionId, 2,
    'session 1 must be on cooldown despite better risk'
  );
  console.log('consecutiveGuard: OK');
})();

// ---------------------------------------------------------------------------
// 5. Handoff: when an active shift is within overlap_seconds of its
//    plannedEnd, a successor is scheduled NOW.
// ---------------------------------------------------------------------------
(function handoffSchedulesSuccessor() {
  const pool = [
    mkSession({ sessionId: 1, riskScore: 0.1 }),
    mkSession({ sessionId: 2, riskScore: 0.1 }),
  ];
  const plannedEnd = new Date(NOW.getTime() + 30 * 1000); // 30s away, overlap=60s
  const out = planner.plan({
    now: NOW,
    job: mkJob({ overlapSeconds: 60 }),
    chat: mkChat(),
    pool,
    activeShifts: [
      { sessionId: 1, chatId: 42, plannedStart: new Date(NOW.getTime() - 3600000), plannedEnd, shiftId: 99 },
    ],
  });
  // Cohort=1, one already live → gap=0. But handoff path should still
  // schedule a successor.
  assert.ok(out.startNow.length >= 1, 'handoff successor scheduled');
  const successor = out.startNow.find((s) => s.reason.startsWith('handoff:'));
  assert.ok(successor, 'one shift is tagged as handoff');
  assert.strictEqual(successor.sessionId, 2, 'session 2 is the successor');
  console.log('handoffSchedulesSuccessor: OK');
})();

// ---------------------------------------------------------------------------
// 6. End-now: outgoing shift past plannedEnd while successor is live.
// ---------------------------------------------------------------------------
(function endNowOutgoingShift() {
  const out = planner.plan({
    now: NOW,
    job: mkJob(),
    chat: mkChat(),
    pool: [mkSession({ sessionId: 3 })],
    activeShifts: [
      // Outgoing — already past end.
      { sessionId: 1, chatId: 42, shiftId: 11, plannedStart: new Date(NOW.getTime() - 7200000), plannedEnd: new Date(NOW.getTime() - 60000) },
      // Successor — still well within window.
      { sessionId: 2, chatId: 42, shiftId: 12, plannedStart: new Date(NOW.getTime() - 30000), plannedEnd: new Date(NOW.getTime() + 3600000) },
    ],
  });
  assert.ok(out.endNow.length >= 1, 'outgoing shift queued for end');
  assert.strictEqual(out.endNow[0].sessionId, 1);
  console.log('endNowOutgoingShift: OK');
})();

// ---------------------------------------------------------------------------
// 7. Pinned cohort_size overrides auto-sizing.
// ---------------------------------------------------------------------------
(function pinnedCohortSize() {
  const pool = Array.from({ length: 5 }, (_, i) =>
    mkSession({ sessionId: i + 1, riskScore: 0.1 })
  );
  const out = planner.plan({
    now: NOW,
    job: mkJob(),
    chat: mkChat({
      eventsPerMinuteRecent: 0, // would normally be 1
      cohortSize: 4,
      cohortSizePinned: true,
    }),
    pool,
    activeShifts: [],
  });
  assert.strictEqual(out.cohortSize, 4);
  assert.strictEqual(out.startNow.length, 4);
  console.log('pinnedCohortSize: OK');
})();

// ---------------------------------------------------------------------------
// 8. open_roster chats stay at cohort=1 even when hot (because the fast
//    scrape captures the bulk and we only need a thin listener for new joiners).
// ---------------------------------------------------------------------------
(function openRosterStaysThin() {
  const pool = Array.from({ length: 5 }, (_, i) =>
    mkSession({ sessionId: i + 1, riskScore: 0.1 })
  );
  const out = planner.plan({
    now: NOW,
    job: mkJob(),
    chat: mkChat({
      detectedMode: 'open_roster',
      eventsPerMinuteRecent: 250,  // would normally be 3
    }),
    pool,
    activeShifts: [],
  });
  assert.strictEqual(out.cohortSize, 1);
  assert.strictEqual(out.startNow.length, 1);
  console.log('openRosterStaysThin: OK');
})();

// ---------------------------------------------------------------------------
// 9. Excluded sessions never picked.
// ---------------------------------------------------------------------------
(function operatorExcludesSession() {
  const pool = [
    mkSession({ sessionId: 1, riskScore: 0.05 }),
    mkSession({ sessionId: 2, riskScore: 0.3 }),
  ];
  const out = planner.plan({
    now: NOW,
    job: mkJob(),
    chat: mkChat({ excludedSessionIds: [1] }),
    pool,
    activeShifts: [],
  });
  assert.strictEqual(out.startNow.length, 1);
  assert.strictEqual(out.startNow[0].sessionId, 2);
  console.log('operatorExcludesSession: OK');
})();

// ---------------------------------------------------------------------------
// 10. Empty pool → no startNow, notes captures reason.
// ---------------------------------------------------------------------------
(function emptyPoolGracefulFailure() {
  const out = planner.plan({
    now: NOW,
    job: mkJob(),
    chat: mkChat(),
    pool: [],
    activeShifts: [],
  });
  assert.strictEqual(out.startNow.length, 0);
  assert.ok(out.notes.includes('no_eligible_sessions'));
  console.log('emptyPoolGracefulFailure: OK');
})();

// ---------------------------------------------------------------------------
// 11. activeShifts cap: a session already on 2 chats won't get a third.
// ---------------------------------------------------------------------------
(function maxSimultaneousShifts() {
  const pool = [
    mkSession({ sessionId: 1, riskScore: 0.0, activeShifts: 2 }),
    mkSession({ sessionId: 2, riskScore: 0.3, activeShifts: 0 }),
  ];
  const out = planner.plan({
    now: NOW,
    job: mkJob(),
    chat: mkChat(),
    pool,
    activeShifts: [],
  });
  assert.strictEqual(out.startNow.length, 1);
  assert.strictEqual(out.startNow[0].sessionId, 2);
  console.log('maxSimultaneousShifts: OK');
})();

console.log('All cohortPlanner smoke tests passed.');
