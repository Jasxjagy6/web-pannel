/**
 * DistributionPlanner — shared planner for multi-session bulk jobs
 * (group add-members, bulk DM).
 *
 * Given a total item count and a pool of sessions, this module
 * decides how to split the work into rotations so that no single
 * session is asked to do too many requests in a row (which is what
 * triggers Telegram's PEER_FLOOD account-level lockout).
 *
 * Two modes:
 *
 *   - 'auto'   : the planner picks a safe per-session burst, the
 *                cooldown range, and the per-item delay range based
 *                on items / sessions and the work type. Operators
 *                that don't want to think about knobs get sane
 *                institutional defaults out of the box.
 *
 *   - 'manual' : the operator passes every knob explicitly. The
 *                planner just normalises and validates the values
 *                (clamps to range, swaps min/max if reversed, etc.).
 *
 * The runner consumes the resulting plan as:
 *
 *   for round in 0..plan.rounds:
 *     for session in plan.sessions:
 *       process up to plan.perSessionBurst items
 *       sleep random(plan.itemDelayMsMin, plan.itemDelayMsMax) between items
 *     if not the last round:
 *       sleep random(plan.cooldownSecMin, plan.cooldownSecMax)
 *
 * The planner is pure (no Redis/DB). The runner is responsible for
 * persistence + Telegram I/O.
 */

'use strict';

const VALID_MODES = new Set(['auto', 'manual']);
const VALID_WORK_TYPES = new Set(['group_add', 'bulk_message']);

// Manual-mode validator clamps. Auto-mode picks values inside these
// ranges so we never have to second-guess the planner downstream.
const LIMITS = {
  perSessionBurst: { min: 1, max: 500 },
  cooldownSec:     { min: 0, max: 1800 },     // 0–30 min
  itemDelayMs:     { min: 50, max: 600000 },  // 50ms–10min
};

/**
 * Hard ceiling Telegram empirically tolerates for
 * `channels.InviteToChannel` before it starts marking sessions as
 * PEER_FLOOD. Above ~4-5 invites in a tight burst, even a "warm"
 * account starts drawing account-level spam flags. The
 * `addMembersToGroups` runner enforces this as a session-level burst
 * cap and the planner clamps `perSessionBurst` to it by default for
 * `group_add` work; operators can override via
 * `params.maxPerSessionBurst` if they really know what they're doing
 * on a particular fleet.
 */
const GROUP_ADD_DEFAULT_MAX_BURST = 4;

/**
 * Auto-mode policy.
 *
 * `ratioBands` are evaluated in order; the first band whose
 * `maxRatio` is >= the actual `items / sessions` ratio wins. The
 * trailing entry has `maxRatio: Infinity` and acts as the catch-all.
 *
 * Defaults are intentionally conservative — they're tuned for
 * institutional use against Telegram's MTProto layer where PEER_FLOOD
 * (an account-level "this account is spamming" mark) is the failure
 * mode you want to avoid above all else.
 */
const AUTO_POLICY = {
  group_add: {
    ratioBands: [
      // ≤ 5 users per session in one pass → just split it,
      // no cooldown needed.
      {
        maxRatio: 5,
        perSessionBurst: (ratio) => Math.max(1, Math.ceil(ratio)),
        cooldownSecMin: 0,
        cooldownSecMax: 0,
        itemDelayMsMin: 30_000,
        itemDelayMsMax: 60_000,
      },
      // 5–20 users / session → two-three rotations, short cooldown.
      {
        maxRatio: 20,
        perSessionBurst: () => 4,
        cooldownSecMin: 60,
        cooldownSecMax: 180,
        itemDelayMsMin: 30_000,
        itemDelayMsMax: 60_000,
      },
      // 20+ users / session → cap each burst at ~70 (Telegram's
      // empirical rate-limit threshold), with a real 1-5 min cooldown
      // between rotations. This is the "70-80 then sleep" pattern the
      // operator described.
      {
        maxRatio: Infinity,
        perSessionBurst: () => 70,
        cooldownSecMin: 60,
        cooldownSecMax: 300,
        itemDelayMsMin: 30_000,
        itemDelayMsMax: 60_000,
      },
    ],
  },
  bulk_message: {
    ratioBands: [
      // ≤ 50 messages / session → one pass, modest cooldown.
      {
        maxRatio: 50,
        perSessionBurst: (ratio) => Math.max(1, Math.ceil(ratio)),
        cooldownSecMin: 30,
        cooldownSecMax: 60,
        itemDelayMsMin: 2_000,
        itemDelayMsMax: 6_000,
      },
      // 50–200 messages / session → ~50/burst, ~1-3min cooldown.
      {
        maxRatio: 200,
        perSessionBurst: () => 50,
        cooldownSecMin: 60,
        cooldownSecMax: 180,
        itemDelayMsMin: 2_000,
        itemDelayMsMax: 6_000,
      },
      // 200+ messages / session → 100/burst, 1-3min cooldown,
      // wider per-item delay.
      {
        maxRatio: Infinity,
        perSessionBurst: () => 100,
        cooldownSecMin: 60,
        cooldownSecMax: 180,
        itemDelayMsMin: 3_000,
        itemDelayMsMax: 8_000,
      },
    ],
  },
};

function _clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function _normPair(rawMin, rawMax, fallbackMin, fallbackMax, limits) {
  const lo = limits.min;
  const hi = limits.max;
  let mn = _clamp(rawMin != null ? Number(rawMin) : fallbackMin, lo, hi);
  let mx = _clamp(rawMax != null ? Number(rawMax) : fallbackMax, lo, hi);
  if (mn > mx) {
    const tmp = mn;
    mn = mx;
    mx = tmp;
  }
  return [mn, mx];
}

/**
 * Compute the rotation plan for a bulk job.
 *
 * @param {object} params
 * @param {number} params.totalItems  Total user/message count (after dedup).
 * @param {number[]|string[]} params.sessionIds  Sessions to use (already validated).
 * @param {'group_add'|'bulk_message'} params.workType
 * @param {'auto'|'manual'} [params.mode='auto']
 * @param {number} [params.perSessionBurst]   Manual-mode override.
 * @param {number} [params.cooldownSecMin]    Manual-mode override.
 * @param {number} [params.cooldownSecMax]    Manual-mode override.
 * @param {number} [params.itemDelayMsMin]    Manual-mode override.
 * @param {number} [params.itemDelayMsMax]    Manual-mode override.
 * @returns {{
 *   mode: 'auto'|'manual',
 *   workType: string,
 *   totalItems: number,
 *   sessionCount: number,
 *   perSessionBurst: number,
 *   cooldownSecMin: number,
 *   cooldownSecMax: number,
 *   itemDelayMsMin: number,
 *   itemDelayMsMax: number,
 *   rounds: number,
 *   perSession: Array<{sessionId: string, count: number, rounds: Array<number>}>,
 *   estimatedMs: { min: number, max: number },
 * }}
 */
function plan(params = {}) {
  const {
    totalItems = 0,
    sessionIds = [],
    workType,
    mode = 'auto',
  } = params;

  if (!VALID_WORK_TYPES.has(workType)) {
    throw new Error(`distributionPlanner.plan: invalid workType "${workType}"`);
  }
  if (!VALID_MODES.has(mode)) {
    throw new Error(`distributionPlanner.plan: invalid mode "${mode}"`);
  }
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new Error('distributionPlanner.plan: at least one session is required');
  }

  // Per-session burst ceiling. For `group_add` we default to the
  // empirical Telegram-safe value (`GROUP_ADD_DEFAULT_MAX_BURST`).
  // For `bulk_message` no ceiling is enforced because bulk DM uses
  // a different rate-limit profile (per-second outgoing messages,
  // not the spam-flag heuristic that `channels.InviteToChannel`
  // triggers). Operators can override per-call.
  const rawMaxBurst = Number(params.maxPerSessionBurst);
  let maxPerSessionBurst;
  if (Number.isFinite(rawMaxBurst) && rawMaxBurst > 0) {
    maxPerSessionBurst = _clamp(
      Math.floor(rawMaxBurst),
      LIMITS.perSessionBurst.min,
      LIMITS.perSessionBurst.max
    );
  } else if (workType === 'group_add') {
    maxPerSessionBurst = GROUP_ADD_DEFAULT_MAX_BURST;
  } else {
    maxPerSessionBurst = LIMITS.perSessionBurst.max;
  }

  const items = Math.max(0, Math.floor(Number(totalItems) || 0));
  if (items === 0) {
    return {
      mode,
      workType,
      totalItems: 0,
      sessionCount: sessionIds.length,
      perSessionBurst: 1,
      cooldownSecMin: 0,
      cooldownSecMax: 0,
      itemDelayMsMin: 0,
      itemDelayMsMax: 0,
      rounds: 0,
      perSession: sessionIds.map((sid) => ({
        sessionId: String(sid),
        count: 0,
        rounds: [],
      })),
      estimatedMs: { min: 0, max: 0 },
    };
  }

  const ratio = items / sessionIds.length;
  const policy = AUTO_POLICY[workType];
  const band =
    policy.ratioBands.find((b) => ratio <= b.maxRatio) ||
    policy.ratioBands[policy.ratioBands.length - 1];

  let perSessionBurst;
  let cooldownSecMin;
  let cooldownSecMax;
  let itemDelayMsMin;
  let itemDelayMsMax;

  if (mode === 'auto') {
    perSessionBurst = _clamp(
      band.perSessionBurst(ratio),
      LIMITS.perSessionBurst.min,
      maxPerSessionBurst
    );
    [cooldownSecMin, cooldownSecMax] = _normPair(
      band.cooldownSecMin,
      band.cooldownSecMax,
      band.cooldownSecMin,
      band.cooldownSecMax,
      LIMITS.cooldownSec
    );
    [itemDelayMsMin, itemDelayMsMax] = _normPair(
      band.itemDelayMsMin,
      band.itemDelayMsMax,
      band.itemDelayMsMin,
      band.itemDelayMsMax,
      LIMITS.itemDelayMs
    );
  } else {
    // manual
    perSessionBurst = _clamp(
      Number(params.perSessionBurst) || band.perSessionBurst(ratio),
      LIMITS.perSessionBurst.min,
      maxPerSessionBurst
    );
    [cooldownSecMin, cooldownSecMax] = _normPair(
      params.cooldownSecMin,
      params.cooldownSecMax,
      band.cooldownSecMin,
      band.cooldownSecMax,
      LIMITS.cooldownSec
    );
    [itemDelayMsMin, itemDelayMsMax] = _normPair(
      params.itemDelayMsMin,
      params.itemDelayMsMax,
      band.itemDelayMsMin,
      band.itemDelayMsMax,
      LIMITS.itemDelayMs
    );
  }

  const sessionCount = sessionIds.length;
  // How many full rounds we need for every session to drain its share.
  // Items are dealt out round-robin: in round r, session i takes the
  // items at indices (r * sessionCount * burst) + (i * burst)
  // through ... + burst - 1 (clamped at totalItems).
  const itemsPerRound = sessionCount * perSessionBurst;
  const rounds = Math.ceil(items / itemsPerRound);

  // Build a per-session breakdown so the UI can render the same
  // "stacked-bar" preview as Messaging already does.
  const perSession = sessionIds.map((sid) => ({
    sessionId: String(sid),
    count: 0,
    rounds: new Array(rounds).fill(0),
  }));

  let cursor = 0;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < sessionCount && cursor < items; i++) {
      const take = Math.min(perSessionBurst, items - cursor);
      perSession[i].count += take;
      perSession[i].rounds[r] = take;
      cursor += take;
    }
  }

  // Time estimate: per-item delay (avg) * items + cooldown (avg) * (rounds - 1).
  // Items are processed in parallel across sessions within a round, so
  // the round duration is roughly maxBurstThisRound * itemDelayAvg.
  const itemDelayAvg = (itemDelayMsMin + itemDelayMsMax) / 2;
  const cooldownAvg = ((cooldownSecMin + cooldownSecMax) / 2) * 1000;
  let estimateAvgMs = 0;
  for (let r = 0; r < rounds; r++) {
    let maxBurstThisRound = 0;
    for (const s of perSession) {
      if (s.rounds[r] > maxBurstThisRound) maxBurstThisRound = s.rounds[r];
    }
    estimateAvgMs += maxBurstThisRound * itemDelayAvg;
    if (r < rounds - 1) estimateAvgMs += cooldownAvg;
  }
  const estimateMinMs =
    estimateAvgMs *
    (itemDelayMsMin / itemDelayAvg) *
    (rounds > 1 && cooldownAvg > 0 ? cooldownSecMin / ((cooldownSecMin + cooldownSecMax) / 2 || 1) : 1);
  const estimateMaxMs =
    estimateAvgMs *
    (itemDelayMsMax / itemDelayAvg) *
    (rounds > 1 && cooldownAvg > 0 ? cooldownSecMax / ((cooldownSecMin + cooldownSecMax) / 2 || 1) : 1);

  return {
    mode,
    workType,
    totalItems: items,
    sessionCount,
    perSessionBurst,
    maxPerSessionBurst,
    cooldownSecMin,
    cooldownSecMax,
    itemDelayMsMin,
    itemDelayMsMax,
    rounds,
    perSession,
    estimatedMs: {
      min: Math.round(estimateMinMs || estimateAvgMs),
      max: Math.round(estimateMaxMs || estimateAvgMs),
    },
  };
}

/**
 * Build the per-session work queues from a flat list of items, in the
 * same round-robin order the runner is going to consume them.
 *
 * Given `items = [A, B, C, D, E, F, G, H, I, J]`, `sessionIds = [s1, s2]`,
 * `perSessionBurst = 2`:
 *
 *   round 0: s1 -> [A, B],   s2 -> [C, D]
 *   round 1: s1 -> [E, F],   s2 -> [G, H]
 *   round 2: s1 -> [I, J],   s2 -> []
 *
 * which collapses (per-session) to:
 *
 *   s1 -> [A, B, E, F, I, J]
 *   s2 -> [C, D, G, H]
 *
 * @param {Array} items
 * @param {Array<string|number>} sessionIds
 * @param {number} perSessionBurst
 * @returns {{
 *   queues: Map<string, Array>,  // per-session items in round-rotation order
 *   schedule: Array<Array<{sessionId: string, items: Array}>>,  // round -> session -> burst
 * }}
 */
function buildQueues(items, sessionIds, perSessionBurst) {
  if (!Array.isArray(items)) items = [];
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return { queues: new Map(), schedule: [] };
  }

  const burst = Math.max(1, Math.floor(perSessionBurst) || 1);
  const sessionCount = sessionIds.length;
  const itemsPerRound = sessionCount * burst;
  const rounds = Math.ceil(items.length / itemsPerRound);

  const queues = new Map();
  for (const sid of sessionIds) queues.set(String(sid), []);
  const schedule = [];

  for (let r = 0; r < rounds; r++) {
    const round = [];
    for (let i = 0; i < sessionCount; i++) {
      const sid = String(sessionIds[i]);
      const start = r * itemsPerRound + i * burst;
      const slice = items.slice(start, start + burst);
      if (slice.length > 0) {
        queues.get(sid).push(...slice);
      }
      round.push({ sessionId: sid, items: slice });
    }
    schedule.push(round);
  }

  return { queues, schedule };
}

module.exports = {
  plan,
  buildQueues,
  LIMITS,
  AUTO_POLICY,
  GROUP_ADD_DEFAULT_MAX_BURST,
  VALID_MODES,
  VALID_WORK_TYPES,
};
