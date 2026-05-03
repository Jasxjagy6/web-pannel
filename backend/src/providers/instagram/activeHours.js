/**
 * Active-hours window enforcement (Phase 2, B10).
 *
 * A real human Instagram user does NOT post / DM / scroll uniformly
 * across the 24-hour clock. The vast majority of activity falls into
 * a waking window typically between 08:00 and 23:30 in the user's
 * own timezone. A panel that fires bulk DM at 03:14 UTC because
 * BullMQ happened to wake up then is a textbook sign of automation.
 *
 * Each session row carries `platform_state.activeHours` of shape:
 *   { start: '08:30', end: '23:15', tz: 'Asia/Kolkata' }
 *
 * Defaults are derived from `platform_state.locale.regionHint`
 * (which Phase 1 pinned at upload) — see `_defaultsFor`.
 *
 * Public API:
 *   isWithinActiveHours(session) -> boolean
 *   nextOpenAt(session)          -> Date in UTC of the next time
 *                                   the session re-enters the window
 *   getActiveHours(session)      -> resolved {start, end, tz} for
 *                                   the given session
 *
 * Callers (messaging, scrape, sessionHealth) wrap their per-session
 * loop with `if (!isWithinActiveHours(session)) skip-and-postpone`.
 *
 * NOTE: we deliberately do not call out to a TZ DB beyond
 * `Intl.DateTimeFormat` (built-in to Node since v13). This avoids
 * adding a dependency for a 1-call-per-session check.
 */

'use strict';

/**
 * Hard-coded sane defaults per region. Each entry is the median
 * waking window of an instagram-active demographic in that region.
 * Stretched generously so we don't false-positive on night owls.
 */
const _DEFAULTS_BY_REGION = {
  US: { start: '07:30', end: '23:30', tz: 'America/New_York' },
  CA: { start: '07:30', end: '23:30', tz: 'America/Toronto' },
  UK: { start: '07:30', end: '23:30', tz: 'Europe/London' },
  GB: { start: '07:30', end: '23:30', tz: 'Europe/London' },
  IE: { start: '07:30', end: '23:30', tz: 'Europe/Dublin' },
  DE: { start: '07:30', end: '23:30', tz: 'Europe/Berlin' },
  FR: { start: '07:30', end: '23:30', tz: 'Europe/Paris' },
  IT: { start: '07:30', end: '23:30', tz: 'Europe/Rome' },
  ES: { start: '08:00', end: '00:30', tz: 'Europe/Madrid' },
  PT: { start: '08:00', end: '00:00', tz: 'Europe/Lisbon' },
  NL: { start: '07:30', end: '23:30', tz: 'Europe/Amsterdam' },
  BR: { start: '08:00', end: '23:30', tz: 'America/Sao_Paulo' },
  AR: { start: '08:00', end: '23:30', tz: 'America/Argentina/Buenos_Aires' },
  MX: { start: '08:00', end: '23:30', tz: 'America/Mexico_City' },
  IN: { start: '07:30', end: '23:30', tz: 'Asia/Kolkata' },
  PK: { start: '08:00', end: '23:30', tz: 'Asia/Karachi' },
  BD: { start: '08:00', end: '23:30', tz: 'Asia/Dhaka' },
  ID: { start: '07:30', end: '23:30', tz: 'Asia/Jakarta' },
  PH: { start: '07:30', end: '23:30', tz: 'Asia/Manila' },
  JP: { start: '07:30', end: '23:30', tz: 'Asia/Tokyo' },
  KR: { start: '07:30', end: '23:30', tz: 'Asia/Seoul' },
  AU: { start: '07:30', end: '23:30', tz: 'Australia/Sydney' },
  NZ: { start: '07:30', end: '23:30', tz: 'Pacific/Auckland' },
  AE: { start: '08:00', end: '23:30', tz: 'Asia/Dubai' },
  SA: { start: '08:00', end: '23:30', tz: 'Asia/Riyadh' },
  TR: { start: '08:00', end: '23:30', tz: 'Europe/Istanbul' },
  RU: { start: '08:00', end: '23:30', tz: 'Europe/Moscow' },
  ZA: { start: '07:30', end: '23:30', tz: 'Africa/Johannesburg' },
  NG: { start: '07:30', end: '23:30', tz: 'Africa/Lagos' },
  EG: { start: '08:00', end: '23:30', tz: 'Africa/Cairo' },
};

const _FALLBACK = { start: '07:30', end: '23:30', tz: 'UTC' };

function _defaultsFor(regionHint) {
  if (!regionHint) return _FALLBACK;
  const key = String(regionHint).toUpperCase();
  return _DEFAULTS_BY_REGION[key] || _FALLBACK;
}

/**
 * Resolve the active-hours window for a session.
 *
 * Precedence:
 *   1. session.platform_state.activeHours if explicitly set (operator
 *      override or seeded at upload)
 *   2. defaults derived from platform_state.locale.regionHint
 *   3. _FALLBACK (UTC 07:30–23:30)
 */
function getActiveHours(session) {
  const ps = (session && session.platform_state) || {};
  if (ps.activeHours && ps.activeHours.start && ps.activeHours.end && ps.activeHours.tz) {
    return ps.activeHours;
  }
  const region = (ps.locale && ps.locale.regionHint) || null;
  return _defaultsFor(region);
}

/**
 * Parse "HH:MM" -> minutes since 00:00. Returns null on malformed.
 */
function _hhmmToMinutes(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!(h >= 0 && h <= 23 && mm >= 0 && mm <= 59)) return null;
  return h * 60 + mm;
}

/**
 * Returns the local wall-clock minutes-since-midnight in the given
 * IANA tz, computed from `now` (or current time).
 */
function _localMinutesNow(tz, now = new Date()) {
  // Intl.DateTimeFormat with hourCycle:'h23' gives us 00..23.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(now).reduce((a, p) => {
    if (p.type === 'hour' || p.type === 'minute') a[p.type] = Number(p.value);
    return a;
  }, {});
  if (Number.isNaN(parts.hour) || Number.isNaN(parts.minute)) return null;
  return parts.hour * 60 + parts.minute;
}

/**
 * Returns true when `now` falls inside the session's active-hours
 * window (inclusive of start, exclusive of end). Handles windows
 * that wrap midnight (e.g. start=22:00, end=02:00).
 */
function isWithinActiveHours(session, now = new Date()) {
  const w = getActiveHours(session);
  let start = _hhmmToMinutes(w.start);
  let end = _hhmmToMinutes(w.end);
  if (start == null || end == null) return true; // fail-open on malformed
  let cur;
  try {
    cur = _localMinutesNow(w.tz, now);
  } catch (_e) {
    return true; // fail-open on bad tz
  }
  if (cur == null) return true;

  if (start === end) return true; // a 24h window
  if (start < end) {
    return cur >= start && cur < end;
  }
  // Wrapping window (e.g. 22:00–02:00): inside means
  // cur >= start OR cur < end.
  return cur >= start || cur < end;
}

/**
 * Returns the next Date (UTC) at which the session re-enters its
 * active-hours window. If it's already inside, returns `now`.
 *
 * Used by job runners to compute a precise sleep / requeue delay
 * instead of polling.
 */
function nextOpenAt(session, now = new Date()) {
  if (isWithinActiveHours(session, now)) return new Date(now.getTime());

  const w = getActiveHours(session);
  const start = _hhmmToMinutes(w.start);
  if (start == null) return new Date(now.getTime() + 30 * 60 * 1000); // unknown → 30min

  let cur;
  try {
    cur = _localMinutesNow(w.tz, now);
  } catch (_e) {
    return new Date(now.getTime() + 30 * 60 * 1000);
  }
  if (cur == null) return new Date(now.getTime() + 30 * 60 * 1000);

  let waitMin;
  if (cur < start) {
    waitMin = start - cur;
  } else {
    // current > start so we're past today's window-end; jump to
    // tomorrow's start.
    waitMin = (24 * 60 - cur) + start;
  }
  return new Date(now.getTime() + waitMin * 60 * 1000);
}

/**
 * Convenience for callers that just want a one-line "should I skip
 * this session right now?" check that also returns the postpone
 * delay so the queue can requeue precisely.
 */
function gate(session, now = new Date()) {
  if (isWithinActiveHours(session, now)) {
    return { allowed: true, waitMs: 0, window: getActiveHours(session) };
  }
  const next = nextOpenAt(session, now);
  return {
    allowed: false,
    waitMs: Math.max(0, next.getTime() - now.getTime()),
    nextOpenAt: next,
    window: getActiveHours(session),
  };
}

module.exports = {
  isWithinActiveHours,
  nextOpenAt,
  getActiveHours,
  gate,
  _defaultsFor,           // exported for tests
  _DEFAULTS_BY_REGION,    // exported for tests
};
