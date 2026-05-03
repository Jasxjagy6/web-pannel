/**
 * Behavioural pacing model (Phase 2, B9 + B11 + B14).
 *
 * The Phase 1 sessionLimiter enforces a per-session rate; this module
 * adds the *human* shape on top:
 *
 *   B9  — Wider, jittered DM pacing: 5–30 minutes between DMs to
 *         **different** recipients; 30–90s allowed only for replies in
 *         the same thread; a 4-hour global cooldown after
 *         feedback_required.
 *
 *   B11 — Realistic action mix: a weighted random picker that returns
 *         the next action a "human" would do (read / react / search /
 *         story-view / DM), so the warmup loop stops being a lockstep
 *         timeline+inbox+news triple.
 *
 *   B14 — De-correlate panel-batch sends: a per-target inter-session
 *         pause (60–180s) so account A sending a DM at t=0 isn't
 *         followed by account B's DM at t=4s to a different person —
 *         that pattern is a textbook panel-of-fresh-accounts signal.
 *
 * No side effects beyond reading platform_state and computing
 * timings; persistence (cooldown markers etc.) is the caller's
 * responsibility via `markFeedbackRequired` / `markSent`.
 */

'use strict';

// ---------------------------------------------------------------------
// B9 — DM pacing curves.
// ---------------------------------------------------------------------

const _DM_DIFFERENT_RECIPIENT_MIN_MS = 5 * 60 * 1000;
const _DM_DIFFERENT_RECIPIENT_MAX_MS = 30 * 60 * 1000;
const _DM_SAME_THREAD_MIN_MS = 30 * 1000;
const _DM_SAME_THREAD_MAX_MS = 90 * 1000;
const _FEEDBACK_REQUIRED_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h

/**
 * Pick a wait between two DMs, given whether they're in the same
 * thread (a reply) or to different recipients (the bulk-DM case).
 *
 * Returns ms. Includes ±30% jitter on top of the base curve so two
 * sessions running side-by-side don't fire on aligned second
 * boundaries.
 */
function dmPaceMs({ sameThread = false } = {}) {
  const minBase = sameThread ? _DM_SAME_THREAD_MIN_MS : _DM_DIFFERENT_RECIPIENT_MIN_MS;
  const maxBase = sameThread ? _DM_SAME_THREAD_MAX_MS : _DM_DIFFERENT_RECIPIENT_MAX_MS;
  const base = minBase + Math.random() * (maxBase - minBase);
  const jitter = (Math.random() * 0.6 - 0.3) * base; // ±30%
  return Math.max(1000, Math.round(base + jitter));
}

/**
 * Returns true if this session is currently within a
 * feedback_required cooldown. Reads
 * `platform_state.cooldowns.feedback_required_until` (ISO string).
 */
function isInFeedbackCooldown(session, now = new Date()) {
  const ps = (session && session.platform_state) || {};
  const until = ps.cooldowns && ps.cooldowns.feedback_required_until;
  if (!until) return false;
  const t = Date.parse(until);
  if (Number.isNaN(t)) return false;
  return now.getTime() < t;
}

/**
 * Returns the platform_state patch a caller should merge after IG
 * returned `feedback_required` for this session. The caller persists
 * it; we just compute the timestamp so the pacing logic is unit-testable.
 */
function buildFeedbackCooldownPatch(now = new Date()) {
  const until = new Date(now.getTime() + _FEEDBACK_REQUIRED_COOLDOWN_MS);
  return { feedback_required_until: until.toISOString() };
}

// ---------------------------------------------------------------------
// B11 — Realistic action mix.
//
// Weighted random pick. Weights are tuned so the warmup loop spends
// most of its budget on cheap reads and only occasionally pokes the
// inbox / search / explore pages. Real users open IG and scroll; they
// don't methodically check inbox + notifications + feed in lockstep.
// ---------------------------------------------------------------------

const _ACTION_MIX = [
  { kind: 'feed_timeline',     weight: 35 }, // open the app / scroll
  { kind: 'feed_explore',      weight: 18 }, // explore tab
  { kind: 'view_story',        weight: 18 }, // tap a story
  { kind: 'feed_user_profile', weight: 12 }, // open a profile
  { kind: 'search',            weight:  7 }, // search bar
  { kind: 'react_post',        weight:  5 }, // like a post
  { kind: 'inbox_check',       weight:  3 }, // open DM inbox
  { kind: 'notifications',     weight:  2 }, // notifications tab
];

const _TOTAL_MIX_WEIGHT = _ACTION_MIX.reduce((a, b) => a + b.weight, 0);

/**
 * Pick the next "human" action for a passive warmup tick.
 * Returns one of the kinds in _ACTION_MIX.
 */
function pickAction() {
  let r = Math.random() * _TOTAL_MIX_WEIGHT;
  for (const a of _ACTION_MIX) {
    r -= a.weight;
    if (r <= 0) return a.kind;
  }
  return _ACTION_MIX[0].kind;
}

/**
 * For inspection / debugging from admin endpoints.
 */
function actionMixSummary() {
  return _ACTION_MIX.map((a) => ({
    kind: a.kind,
    weight: a.weight,
    pct: Math.round((a.weight / _TOTAL_MIX_WEIGHT) * 100),
  }));
}

// ---------------------------------------------------------------------
// B14 — De-correlate panel-batch sends.
// ---------------------------------------------------------------------

const _INTER_SESSION_GAP_MIN_MS = 60 * 1000;
const _INTER_SESSION_GAP_MAX_MS = 180 * 1000;

/**
 * Returns the inter-session sleep ms between two consecutive DM sends
 * coming from different sessions in the same panel-batch.
 *
 * 60–180 s, biased low (most cluster near 60s; long tail above 120s)
 * via a quick squared-uniform.
 */
function interSessionGapMs() {
  const u = Math.random() * Math.random(); // bias low
  return Math.round(
    _INTER_SESSION_GAP_MIN_MS + u * (_INTER_SESSION_GAP_MAX_MS - _INTER_SESSION_GAP_MIN_MS)
  );
}

module.exports = {
  // B9
  dmPaceMs,
  isInFeedbackCooldown,
  buildFeedbackCooldownPatch,

  // B11
  pickAction,
  actionMixSummary,

  // B14
  interSessionGapMs,

  // exposed for tests
  _DM_DIFFERENT_RECIPIENT_MIN_MS,
  _DM_DIFFERENT_RECIPIENT_MAX_MS,
  _DM_SAME_THREAD_MIN_MS,
  _DM_SAME_THREAD_MAX_MS,
  _FEEDBACK_REQUIRED_COOLDOWN_MS,
  _ACTION_MIX,
  _INTER_SESSION_GAP_MIN_MS,
  _INTER_SESSION_GAP_MAX_MS,
};
