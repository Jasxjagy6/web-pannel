/**
 * cohortPlanner — pure, deterministic shift planner for monitor V2.
 *
 * ----------------------------------------------------------------------
 *  Why it's pure
 * ----------------------------------------------------------------------
 *
 *  All the I/O (DB reads of jobs / chats / shifts / fatigue, Redis
 *  health snapshots, BullMQ enqueues) lives in the Orchestrator.
 *  This module gets the snapshot as plain JS objects and returns a
 *  plain JS object describing what shifts to start / extend / end /
 *  schedule. That makes the planning logic trivially unit-testable
 *  against synthetic fleets and lets us simulate "what would the
 *  planner do with 1000 sessions and 50 chats" offline.
 *
 * ----------------------------------------------------------------------
 *  Inputs
 * ----------------------------------------------------------------------
 *
 *  plan({
 *    now: Date,
 *    job: {
 *      id, userId,
 *      cohortSizeDefault,
 *      shiftMinSeconds, shiftMaxSeconds,
 *      overlapSeconds,
 *      perSessionEventBudget,
 *      // policy overrides; everything optional, sensible defaults used.
 *    },
 *    chat: {
 *      id, targetId, targetType,
 *      detectedMode,                  // 'open_roster' | 'admin_only' | 'unknown'
 *      cohortSize, cohortSizePinned,
 *      eventsPerMinuteRecent,
 *      excludedSessionIds = [],       // operator pins
 *      preferredSessionIds = [],
 *    },
 *    pool: [ {
 *      sessionId,
 *      ownerUserId,
 *      isLoggedIn,
 *      riskScore,                     // 0.0–1.0, null if unknown
 *      dcId,
 *      proxyCountry,
 *      lastShiftEndedAt,              // Date | null
 *      lastShiftEndedOnChatId,        // bigint | null
 *      fatigueOnThisChat,             // 0.0–1.0 (rolling 24h)
 *      fatigueGlobal,                 // 0.0–1.0
 *      activeShifts,                  // count across all chats RIGHT NOW
 *    }, ...],
 *    activeShifts: [ { sessionId, chatId, plannedEnd } ],
 *  })
 *
 * ----------------------------------------------------------------------
 *  Output
 * ----------------------------------------------------------------------
 *
 *  {
 *    startNow:    [ { sessionId, plannedEnd, reason } ],
 *    startSoon:   [ { sessionId, plannedStart, plannedEnd, reason } ],
 *    endNow:      [ { sessionId, shiftId } ],
 *    cohortSize:  number,             // newly computed (may differ from input)
 *    notes:       string[],
 *  }
 *
 *  - startNow: bring up immediately to fill cohort gap (or replace a
 *    failed shift). plannedEnd is jittered within [shiftMin, shiftMax].
 *  - startSoon: scheduled to begin `overlapSeconds` BEFORE the
 *    outgoing shift's plannedEnd, for handoff.
 *  - endNow: outgoing shifts that have hit their planned_end while a
 *    successor is already active (i.e. the overlap is done).
 */

'use strict';

const DEFAULTS = Object.freeze({
  cohortSizeDefault: 1,
  shiftMinSeconds: 30 * 60,      // 30 min
  shiftMaxSeconds: 90 * 60,      // 90 min
  overlapSeconds: 60,            // 1 min overlap window
  perSessionEventBudget: 20000,  // events / session / 24h before fatigue=1
  riskGate: 0.7,                 // riskScore >= this → exclude
  // Scoring weights. Lower score = better candidate.
  weights: {
    risk: 1.5,
    fatigueChat: 1.0,
    fatigueGlobal: 0.6,
    recency: 0.6,
    busy: 0.4,
    dcMatch: -0.3,
    proxyDiversity: -0.2,
  },
  // Recency penalty falls off after this many seconds — a session that
  // ended a shift on this chat 4 h ago is back to baseline.
  recencyHalfLifeSeconds: 30 * 60,
  // Force at least one full shift gap between a session's consecutive
  // shifts on the same chat. Lookup window for "was the outgoing
  // session on this chat".
  consecutiveGuardSeconds: 30 * 60,
  // Maximum simultaneous shifts a single session can hold across all
  // chats at once. Even healthy accounts shouldn't be on >2 chats
  // simultaneously — that's also a fingerprint.
  maxSimultaneousShiftsPerSession: 2,
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function rng(seed) {
  // Mulberry32. Pure, deterministic; we seed off (chatId, now) so two
  // invocations of plan() with the same snapshot yield the same shifts,
  // which makes test assertions stable.
  let t = (seed >>> 0) + 0x6D2B79F5;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pickShiftDuration(eventsPerMinute, policy, rand) {
  const min = policy.shiftMinSeconds;
  const max = policy.shiftMaxSeconds;
  if (max <= min) return min;
  // Hot chats lean toward shorter shifts; cold chats toward longer.
  // Linear bias on log(events/min) to keep the curve gentle.
  let bias = 0.5;
  if (eventsPerMinute >= 60) bias = 0.15;        // hot → close to min
  else if (eventsPerMinute >= 10) bias = 0.35;   // warm
  else if (eventsPerMinute <= 1) bias = 0.85;    // quiet → near max
  const span = max - min;
  // Jitter inside a band centred on bias.
  const jitter = (rand() - 0.5) * 0.3;           // ±15% of the span
  const fraction = clamp(bias + jitter, 0.05, 0.95);
  return Math.round(min + span * fraction);
}

function computeCohortSize(chat, policy) {
  if (chat.cohortSizePinned && Number.isFinite(chat.cohortSize)) {
    return clamp(Math.floor(chat.cohortSize), 1, 5);
  }
  const r = Number(chat.eventsPerMinuteRecent) || 0;
  // Cold (<10 ev/min) → 1, warm (10..100) → 2, hot (>=100) → 3.
  // Open_roster chats: after fast scrape we still want a thin listener
  // for new joiners; 1 is enough.
  if (chat.detectedMode === 'open_roster') return 1;
  if (r >= 100) return 3;
  if (r >= 10) return 2;
  return Math.max(1, policy.cohortSizeDefault || 1);
}

function isEligible(s, chat, policy, now) {
  if (!s) return false;
  if (s.isLoggedIn === false) return false;
  if (Array.isArray(chat.excludedSessionIds)
      && chat.excludedSessionIds.includes(s.sessionId)) {
    return false;
  }
  const risk = (s.riskScore == null ? 0 : Number(s.riskScore));
  if (risk >= policy.riskGate) return false;
  // Hard cap on concurrent shifts.
  if (Number(s.activeShifts || 0) >= policy.maxSimultaneousShiftsPerSession) {
    return false;
  }
  // Cooldown if the session just finished a shift on this chat —
  // enforces at least one rotation gap so the SAME session never
  // immediately re-grabs its own outgoing shift.
  if (s.lastShiftEndedOnChatId === chat.id && s.lastShiftEndedAt) {
    const sinceEnd = (now.getTime() - new Date(s.lastShiftEndedAt).getTime()) / 1000;
    if (sinceEnd < policy.consecutiveGuardSeconds) return false;
  }
  // Per-session global event budget — even healthy sessions deserve
  // a break once they've absorbed ~budget events in a rolling day.
  if (Number(s.fatigueGlobal || 0) >= 1.0) return false;
  return true;
}

function recencyPenalty(s, chat, policy, now) {
  if (s.lastShiftEndedOnChatId !== chat.id || !s.lastShiftEndedAt) return 0;
  const seconds = Math.max(
    0,
    (now.getTime() - new Date(s.lastShiftEndedAt).getTime()) / 1000
  );
  if (seconds <= 0) return 1.0;
  // Exponential decay; halflife in policy.recencyHalfLifeSeconds.
  const k = Math.log(2) / Math.max(1, policy.recencyHalfLifeSeconds);
  return Math.exp(-k * seconds);
}

function dcMatchBonus(s, chat) {
  // For now we don't have per-chat DC info; treat as a noop until the
  // orchestrator can supply it. The hook stays so we can flip it on
  // without changing call sites.
  return chat.preferredDc && s.dcId === chat.preferredDc ? 1.0 : 0.0;
}

function proxyDiversityBonus(s, alreadyChosen) {
  if (!s.proxyCountry) return 0.0;
  // Reward sessions whose proxy country is NOT already represented in
  // the currently-chosen cohort for this chat.
  const seen = new Set(
    (alreadyChosen || [])
      .map((c) => c && c.proxyCountry)
      .filter(Boolean)
  );
  return seen.has(s.proxyCountry) ? 0.0 : 1.0;
}

function scoreSession(s, chat, policy, now, alreadyChosen) {
  const w = policy.weights;
  const risk = (s.riskScore == null ? 0 : Number(s.riskScore));
  const fatigueChat = Number(s.fatigueOnThisChat || 0);
  const fatigueGlobal = Number(s.fatigueGlobal || 0);
  const recency = recencyPenalty(s, chat, policy, now);
  const busy = Number(s.activeShifts || 0);
  const dc = dcMatchBonus(s, chat);
  const proxy = proxyDiversityBonus(s, alreadyChosen);
  // Preferred sessions get a fixed boost (subtract from score).
  const preferred = Array.isArray(chat.preferredSessionIds)
    && chat.preferredSessionIds.includes(s.sessionId)
    ? 0.5 : 0.0;

  return (
    w.risk * risk
    + w.fatigueChat * fatigueChat
    + w.fatigueGlobal * fatigueGlobal
    + w.recency * recency
    + w.busy * busy
    + w.dcMatch * dc
    + w.proxyDiversity * proxy
    - preferred
  );
}

function pickCohort(eligible, chat, policy, now, cohortSize) {
  const chosen = [];
  // Fresh copy because we'll mutate alreadyChosen on each iteration to
  // re-score proxy diversity.
  const pool = eligible.slice();
  while (chosen.length < cohortSize && pool.length > 0) {
    let best = null;
    let bestScore = Infinity;
    for (const s of pool) {
      const score = scoreSession(s, chat, policy, now, chosen);
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (!best) break;
    chosen.push({ ...best, _score: bestScore });
    // Remove chosen session from the remaining pool.
    const idx = pool.indexOf(best);
    if (idx >= 0) pool.splice(idx, 1);
  }
  return chosen;
}

function reasonFor(s, chat, policy, now) {
  const parts = [];
  parts.push(`risk=${Number(s.riskScore || 0).toFixed(2)}`);
  parts.push(`fatigue_chat=${Number(s.fatigueOnThisChat || 0).toFixed(2)}`);
  parts.push(`fatigue_global=${Number(s.fatigueGlobal || 0).toFixed(2)}`);
  if (s.lastShiftEndedOnChatId === chat.id && s.lastShiftEndedAt) {
    const mins = Math.round(
      (now.getTime() - new Date(s.lastShiftEndedAt).getTime()) / 60000
    );
    parts.push(`last_on_chat=${mins}m_ago`);
  } else {
    parts.push('first_shift_on_chat');
  }
  if (s.dcId != null) parts.push(`dc=${s.dcId}`);
  if (s.proxyCountry) parts.push(`proxy=${s.proxyCountry}`);
  if (s._score != null) parts.push(`score=${s._score.toFixed(2)}`);
  return parts.join(' ');
}

function normalisePolicy(jobPolicy) {
  const p = { ...DEFAULTS, ...(jobPolicy || {}) };
  // Force ordering invariants so test snapshots don't depend on the
  // caller's manners.
  if (p.shiftMaxSeconds < p.shiftMinSeconds) {
    [p.shiftMinSeconds, p.shiftMaxSeconds] = [p.shiftMaxSeconds, p.shiftMinSeconds];
  }
  if (p.overlapSeconds > p.shiftMinSeconds / 4) {
    // Don't let overlap eat more than 25% of the min shift.
    p.overlapSeconds = Math.floor(p.shiftMinSeconds / 4);
  }
  p.weights = { ...DEFAULTS.weights, ...(jobPolicy && jobPolicy.weights || {}) };
  return p;
}

/**
 * Plan the next shift transitions for a single chat.
 *
 * @returns {{
 *   startNow:    Array<{sessionId, plannedEnd, reason}>,
 *   startSoon:   Array<{sessionId, plannedStart, plannedEnd, reason}>,
 *   endNow:      Array<{sessionId, shiftId}>,
 *   cohortSize:  number,
 *   notes:       string[],
 * }}
 */
function plan({ now, job, chat, pool, activeShifts }) {
  const policy = normalisePolicy(job);
  const notes = [];
  const out = {
    startNow: [], startSoon: [], endNow: [],
    cohortSize: 1, notes,
  };
  const _now = new Date(now);

  const cohortSize = computeCohortSize(chat, policy);
  out.cohortSize = cohortSize;

  const myActive = (activeShifts || []).filter((a) => a.chatId === chat.id);

  // Random source: stable across calls for the same chat/now-second.
  const rand = rng(
    (Number(chat.id) || 0) * 1000003
    + Math.floor(_now.getTime() / 1000)
  );

  // ---------- 1. End-now: shifts that overran their planned_end AND
  //             whose successor is already active.
  // We mark `endNow` to let the orchestrator clean them up; the worker
  // itself stops listening at planned_end anyway.
  for (const a of myActive) {
    if (a.plannedEnd && new Date(a.plannedEnd).getTime() <= _now.getTime()) {
      // Did we provision a successor that's also active?
      const successor = myActive.find(
        (b) => b !== a
          && b.sessionId !== a.sessionId
          && new Date(b.plannedEnd).getTime() > _now.getTime()
      );
      if (successor) {
        out.endNow.push({ sessionId: a.sessionId, shiftId: a.shiftId });
      }
    }
  }

  // Sessions occupying an active or imminent shift on this chat.
  // We don't want to start the SAME session twice on the same chat.
  const sessionsBusyOnThisChat = new Set(myActive.map((a) => a.sessionId));

  // ---------- 2. Compute the live cohort (active + still-fresh shifts).
  const live = myActive.filter(
    (a) => new Date(a.plannedEnd).getTime() > _now.getTime()
  );
  const liveCount = live.length;

  // Filter eligible sessions globally.
  const eligible = (pool || []).filter(
    (s) => isEligible(s, chat, policy, _now)
      && !sessionsBusyOnThisChat.has(s.sessionId)
  );

  if (eligible.length === 0 && liveCount < cohortSize) {
    notes.push('no_eligible_sessions');
  }

  // ---------- 3. Fill gaps: startNow.
  const gap = Math.max(0, cohortSize - liveCount);
  if (gap > 0 && eligible.length > 0) {
    const cohort = pickCohort(eligible, chat, policy, _now, gap);
    for (const s of cohort) {
      const durSec = pickShiftDuration(
        chat.eventsPerMinuteRecent || 0, policy, rand
      );
      const plannedEnd = new Date(_now.getTime() + durSec * 1000);
      out.startNow.push({
        sessionId: s.sessionId,
        plannedEnd,
        durationSeconds: durSec,
        reason: reasonFor(s, chat, policy, _now),
      });
      sessionsBusyOnThisChat.add(s.sessionId);
    }
  }

  // ---------- 4. Handoff prep: any live shift whose plannedEnd is
  // within `overlapSeconds` from now needs a successor pre-scheduled
  // to start NOW (overlap) — we count those as startNow too because the
  // orchestrator should bring them up immediately.
  for (const a of live) {
    const secsToEnd = (new Date(a.plannedEnd).getTime() - _now.getTime()) / 1000;
    if (secsToEnd <= policy.overlapSeconds + 5) {
      // Does this active shift already have a successor in flight?
      const successorAlready = live.some(
        (b) => b !== a
          && b.sessionId !== a.sessionId
          && (new Date(b.plannedStart || _now).getTime() >= new Date(a.plannedEnd).getTime() - (policy.overlapSeconds + 60) * 1000)
      );
      if (successorAlready) continue;

      // Pick one fresh successor.
      const remaining = eligible.filter(
        (s) => !sessionsBusyOnThisChat.has(s.sessionId)
      );
      if (remaining.length === 0) {
        notes.push('handoff_no_successor');
        continue;
      }
      const next = pickCohort(remaining, chat, policy, _now, 1)[0];
      if (!next) continue;
      const durSec = pickShiftDuration(
        chat.eventsPerMinuteRecent || 0, policy, rand
      );
      const plannedEnd = new Date(_now.getTime() + durSec * 1000);
      out.startNow.push({
        sessionId: next.sessionId,
        plannedEnd,
        durationSeconds: durSec,
        reason: 'handoff: ' + reasonFor(next, chat, policy, _now),
      });
      sessionsBusyOnThisChat.add(next.sessionId);
    }
  }

  return out;
}

module.exports = {
  plan,
  // Re-exports for tests / orchestrator introspection.
  DEFAULTS,
  _internal: {
    normalisePolicy,
    computeCohortSize,
    isEligible,
    scoreSession,
    pickCohort,
    pickShiftDuration,
  },
};
