/**
 * sessionResolverCache — per-session entity resolution cache + auth_key-correct
 * fallbacks for the bulk add-members / mass-DM runners.
 *
 * Why this exists
 * ===============
 * MTProto `access_hash` values are signed against the auth_key that
 * observed the peer. A hash that scraper session A captured for user
 * U is **always** rejected (UserEmpty) when handed to a different,
 * fresh session B. The legacy `_resolveEntity` fast path was passing
 * the scraped hash straight into `Api.InputUser({ userId, accessHash })`
 * on whatever session was inviting — so for 1000 fresh sessions × 10k
 * scraped IDs, every fresh session burned one wasted MTProto round-trip
 * before falling back to `contacts.ResolveUsername`. Rows with no
 * username failed permanently with "Could not resolve user", even
 * though the user existed.
 *
 * This module gives the runners a clean abstraction:
 *
 *   resolver = new SessionResolverCache({ sourceChannelIds, telegramService });
 *   const inputUser = await resolver.resolve(session, item);
 *
 * `item` is the prepared list-item shape from groupService
 * (`{ telegram_id?, username?, phone?, access_hash?, candidates }`).
 * Resolution strategy, in order:
 *
 *   1. Per-(session, userKey) memo. If we already resolved this user
 *      on this session in this job, return the cached InputUser.
 *
 *   2. `contacts.ResolveUsername` if the item has a `@username` and
 *      that username has not already been confirmed dead on this
 *      session. Cheapest auth_key-correct path for CSV imports.
 *
 *   3. `channels.GetParticipant(sourceChannel, userId)` for each
 *      caller-supplied source channel. When the operator's
 *      panel-scraped list came from a channel that every working
 *      session has already joined (the typical setup), this returns
 *      a session-correct access_hash with one cheap round-trip per
 *      (session, user, channel).
 *
 *   4. `contacts.ImportContacts` for `+phone` rows.
 *
 *   5. Legacy fall-back to `telegramService._resolveEntity` (the old
 *      chain). Anything that resolves at this step is best-effort.
 *
 * Per-session caches are LRU-capped at `MAX_CACHE_ENTRIES_PER_SESSION`
 * so the resolver can't bloat memory on a 1000-session × 10k-user job.
 *
 * @module sessionResolverCache
 */

'use strict';

const { Api } = require('telegram');
const logger = require('../utils/logger');

const MAX_CACHE_ENTRIES_PER_SESSION = 5000;

/**
 * Pull a canonical, comparable key out of a prepared list-item.
 * Used as the inner cache key per session.
 */
function _itemKey(item) {
  if (!item) return null;
  if (item.numericId) return `id:${item.numericId}`;
  if (item.username) return `un:${String(item.username).toLowerCase().replace(/^@+/, '')}`;
  if (item.phone) return `ph:${item.phone}`;
  if (item.identifier) return `raw:${String(item.identifier).toLowerCase()}`;
  return null;
}

function _normalizeUsername(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/^@+/, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return null;
  return s;
}

function _normalizeNumericId(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!/^-?\d+$/.test(s)) return null;
  return s;
}

function _normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!/^\+?\d{5,15}$/.test(s)) return null;
  return s.startsWith('+') ? s : `+${s}`;
}

function _pickUsernameFromItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (Array.isArray(item.candidates)) {
    for (const c of item.candidates) {
      if (typeof c === 'string' && c.startsWith('@')) {
        return _normalizeUsername(c);
      }
    }
  }
  if (item.username) return _normalizeUsername(item.username);
  if (item.user_name) return _normalizeUsername(item.user_name);
  if (item.handle) return _normalizeUsername(item.handle);
  return null;
}

function _pickNumericIdFromItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.numericId) return _normalizeNumericId(item.numericId);
  if (item.telegram_id) return _normalizeNumericId(item.telegram_id);
  if (item.telegramId) return _normalizeNumericId(item.telegramId);
  if (item.id) return _normalizeNumericId(item.id);
  if (Array.isArray(item.candidates)) {
    for (const c of item.candidates) {
      const n = _normalizeNumericId(c);
      if (n) return n;
    }
  }
  return null;
}

function _pickPhoneFromItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.phone) return _normalizePhone(item.phone);
  if (item.phone_number) return _normalizePhone(item.phone_number);
  if (Array.isArray(item.candidates)) {
    for (const c of item.candidates) {
      if (typeof c === 'string' && c.startsWith('+')) {
        return _normalizePhone(c);
      }
    }
  }
  return null;
}

/**
 * Build an `Api.InputUser` from a fully resolved GramJS User entity.
 * Returns null when the entity is missing or unusable so the caller
 * can fall through to the next resolution strategy.
 */
function _entityToInputUser(entity) {
  if (!entity) return null;
  if (entity.className === 'UserEmpty') return null;
  if (entity.className && entity.className !== 'User') return null;
  if (entity.id === undefined || entity.id === null) return null;
  if (entity.accessHash === undefined || entity.accessHash === null) {
    return null;
  }
  return new Api.InputUser({
    userId: entity.id,
    accessHash: entity.accessHash,
  });
}

/**
 * Extract a session-correct `User` entity from the GetParticipant
 * response. Telegram returns the channel participant wrapped inside
 * either `ChannelParticipantSelf`, `ChannelParticipantCreator`, ...,
 * and the matching `user` row in the top-level `users[]` array.
 */
function _userFromGetParticipantResp(resp, userIdStr) {
  if (!resp || !Array.isArray(resp.users)) return null;
  const want = String(userIdStr);
  for (const u of resp.users) {
    if (u && String(u.id) === want && u.className === 'User') {
      return u;
    }
  }
  return null;
}

class SessionResolverCache {
  /**
   * @param {object} opts
   * @param {Array<string>} [opts.sourceChannelIds]  Identifiers (numeric
   *   IDs, @usernames, t.me URLs) of source channels every working
   *   session has joined. Resolved lazily per-session on first use.
   * @param {object} [opts.telegramService]  Reference to the singleton
   *   telegramService; injected so this module stays pluggable in tests.
   * @param {number} [opts.cacheCap]  Max entries per session cache.
   */
  constructor(opts = {}) {
    const {
      sourceChannelIds = [],
      telegramService = null,
      cacheCap = MAX_CACHE_ENTRIES_PER_SESSION,
    } = opts;

    this._tg = telegramService;
    this._sourceChannelIds = Array.isArray(sourceChannelIds)
      ? sourceChannelIds.slice()
      : [];
    this._cacheCap = Math.max(1, Math.floor(cacheCap) || MAX_CACHE_ENTRIES_PER_SESSION);

    // Map<sessionId, Map<itemKey, InputUser>>
    this._cache = new Map();
    // Map<sessionId, Array<channel entity>>
    this._sourceChannelEntities = new Map();
    // Map<sessionId, boolean>  — true once we've given up resolving
    //                             the source channels for this session.
    this._sourceChannelFailures = new Map();
    // Map<sessionId, Set<deadKey>> — handles confirmed dead on this
    //                                 session.
    this._deadHandles = new Map();

    // Lightweight stats per-instance so callers can log them.
    this.stats = {
      memoHits: 0,
      usernameResolved: 0,
      getParticipantResolved: 0,
      phoneResolved: 0,
      legacyResolved: 0,
      misses: 0,
      sourceChannelJoins: 0,
    };
  }

  _cacheFor(sessionId) {
    const k = String(sessionId);
    let m = this._cache.get(k);
    if (!m) {
      m = new Map();
      this._cache.set(k, m);
    }
    return m;
  }

  _deadFor(sessionId) {
    const k = String(sessionId);
    let s = this._deadHandles.get(k);
    if (!s) {
      s = new Set();
      this._deadHandles.set(k, s);
    }
    return s;
  }

  _rememberInputUser(sessionId, key, inputUser) {
    if (!key || !inputUser) return;
    const m = this._cacheFor(sessionId);
    if (m.size >= this._cacheCap) {
      const oldest = m.keys().next().value;
      if (oldest !== undefined) m.delete(oldest);
    }
    m.set(key, inputUser);
  }

  _markDead(sessionId, key) {
    if (!key) return;
    this._deadFor(sessionId).add(key);
  }

  _isDead(sessionId, key) {
    if (!key) return false;
    return this._deadFor(sessionId).has(key);
  }

  /**
   * Best-effort connect + resolve of each operator-supplied source
   * channel for `sessionId`. Called lazily on first GetParticipant
   * attempt per session. After this call,
   * `_sourceChannelEntities.get(sessionId)` is either a non-empty
   * array of Channel entities or absent (with the failures bit set).
   *
   * @private
   */
  async _ensureSourceChannelsForSession(sessionId) {
    const k = String(sessionId);
    if (this._sourceChannelEntities.has(k)) return;
    if (this._sourceChannelFailures.get(k)) return;
    if (this._sourceChannelIds.length === 0) {
      this._sourceChannelFailures.set(k, true);
      return;
    }
    if (!this._tg) {
      this._sourceChannelFailures.set(k, true);
      return;
    }
    const entities = [];
    for (const cid of this._sourceChannelIds) {
      try {
        const ent = await this._tg._resolveEntity(sessionId, cid);
        if (ent && (ent.className === 'Channel' || ent.className === 'Chat')) {
          entities.push(ent);
          this.stats.sourceChannelJoins++;
        }
      } catch (err) {
        logger.debug(
          `sessionResolverCache: source channel ${cid} not resolvable on session ${sessionId}: ${err && err.message}`
        );
      }
    }
    if (entities.length > 0) {
      this._sourceChannelEntities.set(k, entities);
    } else {
      this._sourceChannelFailures.set(k, true);
    }
  }

  /**
   * Try `channels.GetParticipant(sourceChannel, userId)` on every
   * configured source channel for `session`. Returns an `InputUser`
   * with a session-correct access_hash, or null if none of the
   * channels could see this user (deactivated, never joined, etc.).
   *
   * @private
   */
  async _resolveViaGetParticipant(session, userIdStr) {
    const sid = String(session.id);
    await this._ensureSourceChannelsForSession(sid);
    const channels = this._sourceChannelEntities.get(sid);
    if (!channels || channels.length === 0) return null;
    if (!this._tg || !this._tg.clients) return null;
    const entry = this._tg.clients.get(sid);
    if (!entry || !entry.client) return null;
    const client = entry.client;

    for (const ch of channels) {
      try {
        const resp = await client.invoke(
          new Api.channels.GetParticipant({
            channel: ch.className === 'Channel'
              ? new Api.InputChannel({ channelId: ch.id, accessHash: ch.accessHash })
              : ch,
            participant: new Api.InputUser({
              userId: BigInt(userIdStr),
              accessHash: BigInt(0),
            }),
          })
        );
        const user = _userFromGetParticipantResp(resp, userIdStr);
        const iu = _entityToInputUser(user);
        if (iu) return iu;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        // USER_NOT_PARTICIPANT just means this channel can't see this
        // user, try the next configured source channel.
        if (/USER_NOT_PARTICIPANT/i.test(msg)) continue;
        // PARTICIPANT_ID_INVALID / USER_ID_INVALID — wrong user id
        // shape, no point retrying any channel.
        if (/PARTICIPANT_ID_INVALID|USER_ID_INVALID/i.test(msg)) return null;
        // Anything else (CHANNEL_PRIVATE, etc.) — drop this channel
        // from the candidate set for this session so we don't keep
        // hitting it.
        logger.debug(
          `sessionResolverCache: GetParticipant on session ${sid} channel ${ch && ch.id} failed: ${msg}`
        );
      }
    }
    return null;
  }

  /**
   * Resolve `item` into an `Api.InputUser` valid for `session`.
   *
   * Returns null when no resolution strategy worked. The caller is
   * expected to classify a null return as "could not resolve user
   * for this session" — typically a retry-on-different-session
   * candidate, NOT a hard user-side failure.
   *
   * @param {object} session  Session row ({ id, ... }).
   * @param {object} item     Prepared list-item.
   * @returns {Promise<Api.InputUser|null>}
   */
  async resolve(session, item) {
    if (!session || session.id === undefined || session.id === null) return null;
    if (!item) return null;
    const sid = String(session.id);

    const key = _itemKey(item);

    // 1. Per-session memo.
    if (key) {
      const m = this._cacheFor(sid);
      const cached = m.get(key);
      if (cached) {
        this.stats.memoHits++;
        return cached;
      }
    }

    // 2. contacts.ResolveUsername (cheapest auth_key-correct path).
    const username = _pickUsernameFromItem(item);
    if (username) {
      const unKey = `un:${username.toLowerCase()}`;
      if (!this._isDead(sid, unKey)) {
        try {
          const entry = this._tg && this._tg.clients.get(sid);
          if (entry && entry.client) {
            const entity = await entry.client.getEntity(username);
            const iu = _entityToInputUser(entity);
            if (iu) {
              this.stats.usernameResolved++;
              this._rememberInputUser(sid, key, iu);
              this._rememberInputUser(sid, unKey, iu);
              return iu;
            }
          }
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|No user has/i.test(msg)) {
            this._markDead(sid, unKey);
          } else {
            logger.debug(
              `sessionResolverCache: ResolveUsername(${username}) on session ${sid} failed: ${msg}`
            );
          }
        }
      }
    }

    // 3. channels.GetParticipant on the configured source channel(s).
    const numericId = _pickNumericIdFromItem(item);
    if (numericId && this._sourceChannelIds.length > 0) {
      const idKey = `id:${numericId}`;
      if (!this._isDead(sid, idKey)) {
        const iu = await this._resolveViaGetParticipant(session, numericId);
        if (iu) {
          this.stats.getParticipantResolved++;
          this._rememberInputUser(sid, key, iu);
          this._rememberInputUser(sid, idKey, iu);
          return iu;
        }
      }
    }

    // 4. contacts.ImportContacts for phone rows.
    const phone = _pickPhoneFromItem(item);
    if (phone) {
      try {
        const entry = this._tg && this._tg.clients.get(sid);
        if (entry && entry.client) {
          const resp = await entry.client.invoke(
            new Api.contacts.ImportContacts({
              contacts: [
                new Api.InputPhoneContact({
                  clientId: BigInt(0),
                  phone,
                  firstName: '',
                  lastName: '',
                }),
              ],
            })
          );
          if (resp && Array.isArray(resp.users)) {
            for (const u of resp.users) {
              const iu = _entityToInputUser(u);
              if (iu) {
                this.stats.phoneResolved++;
                this._rememberInputUser(sid, key, iu);
                return iu;
              }
            }
          }
        }
      } catch (err) {
        logger.debug(
          `sessionResolverCache: ImportContacts(${phone}) on session ${sid} failed: ${err && err.message}`
        );
      }
    }

    // 5. Legacy fall-back. Treat as best-effort; the legacy chain
    //    includes attempts that may waste a round-trip on an
    //    auth_key-foreign access_hash, but if it succeeds we still
    //    cache the result so this session never pays that cost again.
    if (this._tg && typeof this._tg._resolveEntity === 'function') {
      try {
        const legacyIdent = numericId || username || phone || item.identifier;
        if (legacyIdent) {
          const entity = await this._tg._resolveEntity(
            session.id,
            legacyIdent,
            // Pass any cached access_hash through as a *hint* — the
            // resolver will fall through cleanly when it's wrong.
            item && item.accessHash ? { accessHash: item.accessHash } : {}
          );
          const iu = _entityToInputUser(entity);
          if (iu) {
            this.stats.legacyResolved++;
            this._rememberInputUser(sid, key, iu);
            return iu;
          }
        }
      } catch (err) {
        // The legacy chain throws on permanent auth errors — let the
        // caller see them so it can mark the session dead.
        if (this._tg.isPermanentAuthError && this._tg.isPermanentAuthError(err)) {
          throw err;
        }
        // For target-side errors, fall through to "miss".
      }
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Drop all per-session caches. Tests call this between scenarios so
   * residual entries don't leak across asserts.
   */
  clear() {
    this._cache.clear();
    this._sourceChannelEntities.clear();
    this._sourceChannelFailures.clear();
    this._deadHandles.clear();
    this.stats = {
      memoHits: 0,
      usernameResolved: 0,
      getParticipantResolved: 0,
      phoneResolved: 0,
      legacyResolved: 0,
      misses: 0,
      sourceChannelJoins: 0,
    };
  }
}

module.exports = {
  SessionResolverCache,
  // Exported for tests.
  __internal: {
    _itemKey,
    _normalizeUsername,
    _normalizeNumericId,
    _normalizePhone,
    _pickUsernameFromItem,
    _pickNumericIdFromItem,
    _pickPhoneFromItem,
    _entityToInputUser,
    _userFromGetParticipantResp,
  },
  MAX_CACHE_ENTRIES_PER_SESSION,
};
