/**
 * Normalize a list-item-shaped target into something `_resolveEntity`
 * can resolve, or null if there's nothing usable.
 *
 * Behaviour, in priority order:
 *   1. Numeric `telegram_id` / `telegramId` / `id` -> the bare numeric string.
 *   2. `username` (without UUID/numeric stubs) -> `@username`.
 *   3. `phone` / `phone_number` -> `+<digits>`.
 *
 * Strings/numbers passed in directly are passed through unchanged unless
 * they're a UUID-style placeholder (e.g. `2617dd5b-...`), in which case
 * we return null. Plain numeric strings, `@username`, and `+phone`
 * pass through.
 *
 * This is the same fallback used by `messageService.normalizeTargetId`
 * and `groupService` when it dispatches to `telegramService.addMemberToGroup`,
 * so a list item that has only a username (telegram_id = null) is still
 * deliverable.
 *
 * @param {*} target  Either a raw string/number identifier or a list-item
 *                    object (`{ telegram_id, username, phone, ... }`).
 * @returns {string|null} A normalized identifier, or null if the entry
 *                        is unaddressable.
 */
'use strict';

const UUID_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function _toIdString(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (UUID_LIKE_RE.test(s)) return null;
  if (!/^-?\d+$/.test(s)) return null;
  return s;
}

function _toUsername(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/^@+/, '').trim();
  if (!s) return null;
  if (UUID_LIKE_RE.test(s)) return null;
  if (/^\d+$/.test(s)) return null; // numeric stubs aren't real handles
  return `@${s}`;
}

function _toPhone(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!/^\+?\d{5,15}$/.test(s)) return null;
  return s.startsWith('+') ? s : `+${s}`;
}

/**
 * Pull the access_hash for a list-item-shaped target. Accepts the
 * canonical snake_case form persisted on `list_items` rows, the
 * camelCase variant the frontend ships in WebSocket payloads, and the
 * shorter `hash` alias some operator-built JSON exports use.
 *
 * @param {*} target
 * @returns {string|null} Decimal-string representation of the int64
 *                        access_hash, or null when absent / malformed.
 */
function _accessHashOf(target) {
  if (!target || typeof target !== 'object') return null;
  const raw =
    target.access_hash !== undefined && target.access_hash !== null ? target.access_hash :
    target.accessHash !== undefined && target.accessHash !== null ? target.accessHash :
    target.hash !== undefined && target.hash !== null ? target.hash :
    null;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'bigint') return raw.toString();
  const s = String(raw).trim();
  if (!s) return null;
  if (!/^-?\d+$/.test(s)) return null;
  return s;
}

/**
 * Like `normalizeTelegramTarget` but returns *every* usable identifier
 * for a list entry, in resolution-priority order. Use this when you
 * want to fall back through (id → @username → +phone) — e.g. when a
 * scraped numeric id has no cached access_hash but the row also has
 * a real public username that `contacts.ResolveUsername` can handle.
 *
 * @param {*} target
 * @returns {string[]} Distinct candidate identifiers, possibly empty.
 */
function collectTelegramTargetCandidates(target) {
  if (target === null || target === undefined) return [];

  if (typeof target === 'number') {
    const s = _toIdString(target);
    return s ? [s] : [];
  }

  if (typeof target === 'string') {
    const s = target.trim();
    if (!s) return [];
    if (UUID_LIKE_RE.test(s)) return [];
    return [s];
  }

  if (typeof target === 'object') {
    const out = [];
    const seen = new Set();
    const push = (v) => {
      if (v && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    };

    push(_toIdString(target.telegram_id));
    push(_toIdString(target.telegramId));
    push(_toIdString(target.id));
    push(_toIdString(target.user_id));
    push(_toIdString(target.userId));

    push(_toUsername(target.username));
    push(_toUsername(target.user_name));
    push(_toUsername(target.handle));

    push(_toPhone(target.phone));
    push(_toPhone(target.phone_number));

    return out;
  }

  return [];
}

function normalizeTelegramTarget(target) {
  const candidates = collectTelegramTargetCandidates(target);
  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * Pick the primary numeric `telegram_id` carried on a target object,
 * if any. Used by the add-members worker to pair an access_hash with
 * the right candidate (the numeric-id one) and skip the entity-
 * resolution round-trip when the hash is known.
 *
 * @param {*} target
 * @returns {string|null}
 */
function getPrimaryTelegramId(target) {
  if (!target || typeof target !== 'object') return null;
  return (
    _toIdString(target.telegram_id) ||
    _toIdString(target.telegramId) ||
    _toIdString(target.id) ||
    _toIdString(target.user_id) ||
    _toIdString(target.userId) ||
    null
  );
}

module.exports = {
  normalizeTelegramTarget,
  collectTelegramTargetCandidates,
  getAccessHash: _accessHashOf,
  getPrimaryTelegramId,
  // Exposed for unit testing:
  _UUID_LIKE_RE: UUID_LIKE_RE,
};
