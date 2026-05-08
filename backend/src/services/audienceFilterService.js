/**
 * audienceFilterService — pre-job list filter pipeline.
 *
 * Goal: stop sessions from burning their RPC quota on entries that are
 * obviously bad (deleted accounts, never-existed handles, fake phone
 * numbers). When a job for `add-members` / `send-bulk` starts we run this
 * filter first; the resulting `eligible` array is the only set of
 * users sessions get to talk to Telegram about.
 *
 * Pipeline:
 *   1. Normalize + dedupe the input list (case-insensitive on @username,
 *      exact on telegram_id, exact on phone).
 *   2. Look up each unique identifier in `audience_resolution_cache` —
 *      cache lives forever, populated incrementally by us and by the
 *      worker observing add-attempt outcomes.
 *   3. For cache MISSES that are `@usernames`, do a session-LESS HTTP probe
 *      against `https://t.me/{username}`. The page is public and tells us
 *      whether the handle exists.
 *   4. Persist results into the cache + into list_items so future jobs
 *      skip even the cache lookup.
 *
 * Important:
 *   - We do NOT do a session-backed probe for numeric IDs / phones inside
 *     this module; the cost+risk doesn't justify it. The runner emits
 *     `recordObserved*` calls for entries the worker actually attempts,
 *     which seeds the cache organically. After the first job a numeric
 *     ID stays in cache forever.
 *   - Privacy-restricted state can only be detected by an actual add
 *     attempt (channels.InviteToChannel.users dropped). Callers report
 *     those via `recordObservedPrivacyRestricted` once the job is done;
 *     the next job for the same list_item will carry `dm_only=true` so
 *     group-add jobs skip them while DM jobs include them.
 *   - `not_found` results are persisted as `not_found` and the matching
 *     list_items are removed when the job persists results back.
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');

const PROBE_TIMEOUT_MS = 6000;
const PROBE_CONCURRENCY = 8;
const TME_BASE = 'https://t.me/';
const PROBE_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36';

const STATUS = Object.freeze({
  LIVE: 'live',
  PRIVACY_RESTRICTED: 'privacy_restricted',
  NOT_FOUND: 'not_found',
  UNKNOWN: 'unknown',
});

const KIND = Object.freeze({
  USERNAME: 'username',
  TELEGRAM_ID: 'telegram_id',
  PHONE: 'phone',
});

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normalizeUsername(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/^@+/, '');
  if (!s) return null;
  if (!/^[A-Za-z0-9_]{4,32}$/.test(s)) return null;
  return s.toLowerCase();
}

function normalizeTelegramId(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return null;
  return s;
}

function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/[^\d]/g, '');
  if (!s || s.length < 6 || s.length > 16) return null;
  return s;
}

/**
 * Pick the best-key for an audience entry. Order matters: usernames are
 * cheapest to probe (HTTP), then telegram_id, then phone.
 */
function classifyEntry(entry) {
  if (!entry) return null;
  const username = normalizeUsername(entry.username);
  const telegramId = normalizeTelegramId(entry.telegram_id || entry.telegramId);
  const phone = normalizePhone(entry.phone);
  if (username) return { kind: KIND.USERNAME, key: username, raw: entry };
  if (telegramId) return { kind: KIND.TELEGRAM_ID, key: telegramId, raw: entry };
  if (phone) return { kind: KIND.PHONE, key: phone, raw: entry };
  return null;
}

// ---------------------------------------------------------------------------
// Session-less probe via t.me/{username}
// ---------------------------------------------------------------------------

/**
 * Classify the HTML body of a public `t.me/{username}` response.
 *
 * Behaviour observed in production:
 *   - Existing user / channel / group / bot:
 *       og:title is `Telegram: Contact @username`
 *       page contains `tgme_page_action`, `tgme_action_button_label`, etc.
 *   - Non-existent username:
 *       og:title is `Telegram` (the homepage hero) and the body is the
 *       generic landing page (no `tgme_page_action`/`tgme_action_button`).
 *   - Banned/deleted but reserved handle: Telegram serves the same
 *       homepage layout — we treat as not_found which is what we want
 *       (don't waste sessions on it).
 */
function classifyTmeBody(html) {
  if (!html || typeof html !== 'string') return STATUS.UNKNOWN;
  const lower = html.toLowerCase();
  const hasContactOg = /<meta property="og:title" content="telegram:\s*contact /i.test(html);
  const hasActionBlock =
    /tgme_page_action/.test(lower) ||
    /tgme_action_button_label/.test(lower) ||
    /tgme_action_button_new/.test(lower);
  if (hasContactOg || hasActionBlock) return STATUS.LIVE;
  // Channel / group pages use og:title "Telegram: Contact" too. If neither
  // marker is present this is the generic homepage → handle does not exist.
  return STATUS.NOT_FOUND;
}

async function fetchWithTimeout(url, timeoutMs) {
  if (typeof fetch !== 'function') {
    return { ok: false, status: 0, body: '', error: 'fetch unavailable' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': PROBE_USER_AGENT,
        Accept: 'text/html,*/*',
      },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: '', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function probeUsername(username) {
  const url = `${TME_BASE}${encodeURIComponent(username)}`;
  const res = await fetchWithTimeout(url, PROBE_TIMEOUT_MS);
  if (res.error || res.status === 0) {
    return { status: STATUS.UNKNOWN, source: 'tme_http', reason: res.error || 'no response' };
  }
  if (res.status === 404) {
    return { status: STATUS.NOT_FOUND, source: 'tme_http', reason: 'http_404' };
  }
  if (res.status >= 500) {
    return { status: STATUS.UNKNOWN, source: 'tme_http', reason: `http_${res.status}` };
  }
  return {
    status: classifyTmeBody(res.body),
    source: 'tme_http',
    reason: `http_${res.status}`,
  };
}

// ---------------------------------------------------------------------------
// Cache layer
// ---------------------------------------------------------------------------

async function readCache(keys /* [{kind, key}] */) {
  if (!keys.length) return new Map();
  const kinds = keys.map((k) => k.kind);
  const ks = keys.map((k) => k.key);
  try {
    const { rows } = await pool.query(
      `SELECT identifier_kind, identifier_norm, status, resolved_username, resolved_id, reason, source
         FROM audience_resolution_cache
        WHERE (identifier_kind, identifier_norm) IN (
          SELECT * FROM UNNEST($1::text[], $2::text[])
        )`,
      [kinds, ks]
    );
    const out = new Map();
    for (const r of rows) {
      out.set(`${r.identifier_kind}::${r.identifier_norm}`, r);
    }
    return out;
  } catch (err) {
    logger.warn(`[audienceFilter] readCache failed: ${err.message}`);
    return new Map();
  }
}

async function upsertCache(entries) {
  if (!entries.length) return;
  // Bulk upsert via UNNEST.
  const kinds = entries.map((e) => e.kind);
  const ks = entries.map((e) => e.key);
  const statuses = entries.map((e) => e.status);
  const sources = entries.map((e) => e.source || 'unknown');
  const reasons = entries.map((e) => e.reason || null);
  const usernames = entries.map((e) => e.resolvedUsername || null);
  const ids = entries.map((e) => e.resolvedId || null);
  try {
    await pool.query(
      `INSERT INTO audience_resolution_cache
         (identifier_kind, identifier_norm, status, source, reason, resolved_username, resolved_id, probed_at, updated_at)
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]
       ) AS t(kind, key, status, source, reason, username, rid)
       CROSS JOIN LATERAL (SELECT NOW() AS probed_at, NOW() AS updated_at) ts
       ON CONFLICT (identifier_kind, identifier_norm) DO UPDATE SET
         status            = EXCLUDED.status,
         source            = EXCLUDED.source,
         reason            = EXCLUDED.reason,
         resolved_username = COALESCE(EXCLUDED.resolved_username, audience_resolution_cache.resolved_username),
         resolved_id       = COALESCE(EXCLUDED.resolved_id, audience_resolution_cache.resolved_id),
         updated_at        = NOW()`,
      [kinds, ks, statuses, sources, reasons, usernames, ids]
    );
  } catch (err) {
    logger.warn(`[audienceFilter] upsertCache failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Persistence into list_items
// ---------------------------------------------------------------------------

async function persistListItemStatuses({ listId, classifications }) {
  if (!listId || !classifications || classifications.size === 0) return;
  const kindIdx = { username: [], telegram_id: [], phone: [] };
  const valIdx = { username: [], telegram_id: [], phone: [] };
  const stIdx = { username: [], telegram_id: [], phone: [] };
  const reasonIdx = { username: [], telegram_id: [], phone: [] };

  for (const [, info] of classifications) {
    if (!kindIdx[info.kind]) continue;
    valIdx[info.kind].push(info.key);
    stIdx[info.kind].push(info.status);
    reasonIdx[info.kind].push(info.reason || info.source || null);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (valIdx.username.length) {
      await client.query(
        `UPDATE list_items
            SET privacy_status = u.status,
                privacy_reason = u.reason,
                last_filter_at = NOW(),
                dm_only        = (u.status = 'privacy_restricted')
           FROM UNNEST($2::text[], $3::text[], $4::text[]) AS u(uname, status, reason)
          WHERE list_id = $1
            AND username IS NOT NULL
            AND LOWER(username) = u.uname`,
        [listId, valIdx.username, stIdx.username, reasonIdx.username]
      );
    }
    if (valIdx.telegram_id.length) {
      await client.query(
        `UPDATE list_items
            SET privacy_status = u.status,
                privacy_reason = u.reason,
                last_filter_at = NOW(),
                dm_only        = (u.status = 'privacy_restricted')
           FROM UNNEST($2::text[], $3::text[], $4::text[]) AS u(tid, status, reason)
          WHERE list_id = $1
            AND telegram_id IS NOT NULL
            AND telegram_id::text = u.tid`,
        [listId, valIdx.telegram_id, stIdx.telegram_id, reasonIdx.telegram_id]
      );
    }
    if (valIdx.phone.length) {
      await client.query(
        `UPDATE list_items
            SET privacy_status = u.status,
                privacy_reason = u.reason,
                last_filter_at = NOW(),
                dm_only        = (u.status = 'privacy_restricted')
           FROM UNNEST($2::text[], $3::text[], $4::text[]) AS u(ph, status, reason)
          WHERE list_id = $1
            AND phone IS NOT NULL
            AND regexp_replace(phone, '[^0-9]', '', 'g') = u.ph`,
        [listId, valIdx.phone, stIdx.phone, reasonIdx.phone]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    logger.warn(`[audienceFilter] persistListItemStatuses failed: ${err.message}`);
  } finally {
    client.release();
  }
}

/**
 * Drop list_items that the filter has confirmed `not_found`.
 * Privacy-restricted items are KEPT (operator may want them for DM jobs).
 */
async function purgeNotFoundFromList(listId) {
  if (!listId) return 0;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM list_items
        WHERE list_id = $1
          AND privacy_status = 'not_found'`,
      [listId]
    );
    return rowCount || 0;
  } catch (err) {
    logger.warn(`[audienceFilter] purgeNotFoundFromList ${listId} failed: ${err.message}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full filter against `userList`. Always synchronous from the
 * caller's perspective: it dedupes, hits the cache, probes the misses,
 * persists results, and returns the eligible subset (unique entries that
 * are NOT confirmed not_found, with `dm_only` indicating privacy_restricted).
 *
 * @param {object}                    args
 * @param {Array<object>}             args.userList   raw list (telegram_id|username|phone|first_name|last_name)
 * @param {number|string}             [args.listId]   optional — when supplied, the filter persists results back
 * @param {number}                    [args.userId]   informational only (logging)
 * @param {string}                    [args.context]  informational only (e.g. 'add-members')
 * @param {boolean}                   [args.skipNetworkProbe]  set true for unit tests / when offline
 * @param {{purgeNotFound?: boolean, includePrivacyRestricted?: boolean}} [args.options]
 * @returns {Promise<{eligible: Array, dropped: Array, dmOnly: Array, stats: object}>}
 */
async function filterUserList({
  userList,
  listId = null,
  userId = null,
  context = 'unknown',
  skipNetworkProbe = false,
  options = {},
}) {
  const includePrivacyRestricted = options.includePrivacyRestricted !== false;
  const purgeNotFound = options.purgeNotFound !== false;
  const stats = {
    input: Array.isArray(userList) ? userList.length : 0,
    classified: 0,
    duplicatesRemoved: 0,
    cacheHits: 0,
    httpProbes: 0,
    eligible: 0,
    dropped: 0,
    dmOnly: 0,
    unknown: 0,
  };

  if (!Array.isArray(userList) || userList.length === 0) {
    return { eligible: [], dropped: [], dmOnly: [], stats, classifications: new Map() };
  }

  // Step 1 — normalize + dedupe.
  const dedupMap = new Map(); // key=`${kind}::${key}` → { kind, key, raw }
  for (const entry of userList) {
    const c = classifyEntry(entry);
    if (!c) continue;
    const id = `${c.kind}::${c.key}`;
    if (!dedupMap.has(id)) dedupMap.set(id, c);
  }
  stats.classified = dedupMap.size;
  stats.duplicatesRemoved = userList.length - dedupMap.size;

  // Step 2 — read cache.
  const allKeys = [...dedupMap.values()].map((v) => ({ kind: v.kind, key: v.key }));
  const cache = await readCache(allKeys);
  stats.cacheHits = cache.size;

  // Step 3 — for cache misses, probe (only usernames are session-less).
  const probeQueue = [];
  for (const [id, c] of dedupMap) {
    const cached = cache.get(`${c.kind}::${c.key}`);
    if (cached) continue;
    if (c.kind === KIND.USERNAME && !skipNetworkProbe) probeQueue.push({ id, c });
  }

  const probeResults = new Map();
  if (probeQueue.length) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, probeQueue.length) }, async () => {
      while (cursor < probeQueue.length) {
        const slot = cursor++;
        if (slot >= probeQueue.length) return;
        const { id, c } = probeQueue[slot];
        const result = await probeUsername(c.key);
        probeResults.set(id, { kind: c.kind, key: c.key, ...result });
      }
    });
    await Promise.all(workers);
    stats.httpProbes = probeResults.size;
  }

  // Step 4 — assemble final classification + persist into cache.
  const classifications = new Map();
  const cacheUpserts = [];
  for (const [id, c] of dedupMap) {
    const cached = cache.get(`${c.kind}::${c.key}`);
    let status;
    let reason = null;
    let source = 'cache';
    let resolvedUsername = null;
    let resolvedId = null;
    if (cached) {
      status = cached.status;
      reason = cached.reason || null;
      source = cached.source || 'cache';
      resolvedUsername = cached.resolved_username || null;
      resolvedId = cached.resolved_id || null;
    } else if (probeResults.has(id)) {
      const p = probeResults.get(id);
      status = p.status;
      reason = p.reason;
      source = p.source;
      cacheUpserts.push({
        kind: c.kind,
        key: c.key,
        status,
        source,
        reason,
      });
    } else {
      // Numeric IDs / phones with no cache hit — leave as 'unknown' so the
      // worker still attempts them; the runner will record observed
      // outcomes after the attempt and the cache fills organically.
      status = STATUS.UNKNOWN;
      source = 'untested';
    }
    classifications.set(id, {
      kind: c.kind,
      key: c.key,
      raw: c.raw,
      status,
      reason,
      source,
      resolvedUsername,
      resolvedId,
    });
  }
  if (cacheUpserts.length) await upsertCache(cacheUpserts);

  // Step 5 — persist results back to the list_items rows when we have a listId.
  if (listId) {
    await persistListItemStatuses({ listId, classifications });
    if (purgeNotFound) {
      const removed = await purgeNotFoundFromList(listId);
      if (removed > 0) {
        logger.info(`[audienceFilter] purged ${removed} not_found rows from list ${listId}`);
      }
    }
  }

  // Step 6 — assemble outputs.
  const eligible = [];
  const dropped = [];
  const dmOnly = [];
  for (const [, info] of classifications) {
    if (info.status === STATUS.NOT_FOUND) {
      dropped.push(info);
      continue;
    }
    if (info.status === STATUS.PRIVACY_RESTRICTED) {
      dmOnly.push(info);
      if (!includePrivacyRestricted) continue;
    }
    if (info.status === STATUS.UNKNOWN) stats.unknown += 1;
    eligible.push(info);
  }
  stats.eligible = eligible.length;
  stats.dropped = dropped.length;
  stats.dmOnly = dmOnly.length;

  logger.info(`[audienceFilter] ${context}: ${JSON.stringify(stats)}`, { userId, listId });

  // Project eligible back into the worker-friendly shape (telegram_id,
  // username, phone, first_name, last_name). The worker can address any
  // candidate from the row.
  const eligibleEntries = eligible.map((info) => ({
    ...info.raw,
    _filter_kind: info.kind,
    _filter_status: info.status,
  }));

  return {
    eligible: eligibleEntries,
    dropped,
    dmOnly,
    classifications,
    stats,
  };
}

/**
 * Worker hook — record an observed outcome from a real Telegram add/DM
 * attempt. Drives privacy_restricted / not_found into the cache so the
 * next job for the same identifier doesn't waste a session probing it.
 *
 * @param {object} args
 * @param {string} args.kind         'username' | 'telegram_id' | 'phone'
 * @param {string} args.key          normalized identifier
 * @param {string} args.status       'live' | 'privacy_restricted' | 'not_found' | 'unknown'
 * @param {string} [args.reason]     short description ('USER_PRIVACY_RESTRICTED', 'USER_NOT_MUTUAL_CONTACT', etc.)
 * @param {string} [args.source]     where this came from ('add_attempt', 'dm_attempt', 'resolve')
 */
async function recordObserved({ kind, key, status, reason = null, source = 'observed' }) {
  if (!kind || !key || !status) return;
  await upsertCache([{ kind, key, status, reason, source }]);
}

async function recordObservedFromEntry(entry, status, reason = null, source = 'observed') {
  const c = classifyEntry(entry);
  if (!c) return;
  return recordObserved({ kind: c.kind, key: c.key, status, reason, source });
}

module.exports = {
  STATUS,
  KIND,
  filterUserList,
  recordObserved,
  recordObservedFromEntry,
  classifyEntry,
  normalizeUsername,
  normalizeTelegramId,
  normalizePhone,
  // exported for tests
  __internal: {
    classifyTmeBody,
    probeUsername,
    readCache,
    upsertCache,
    persistListItemStatuses,
    purgeNotFoundFromList,
  },
};
