/**
 * observationFunnel — shared sink for monitor-V2 listeners.
 *
 * ============================================================
 *   What it does
 * ============================================================
 *
 *   listener (NewMessage)  ─┐
 *                            ├─► observationFunnel.observe(...)
 *   listener (RawUpdate)   ─┘            │
 *                                        ├── stage 1: Redis dedup
 *                                        │     (skip DB write on repeats)
 *                                        ├── stage 2: enrich
 *                                        │     (in-mem cache → piggyback
 *                                        │      → background getEntity)
 *                                        ├── stage 3: persist
 *                                        │     (scrape_monitor_users
 *                                        │      INSERT or UPDATE,
 *                                        │      scrape_monitor_chats counters)
 *                                        └── stage 4: progress emit
 *                                              (debounced WS event)
 *
 * Many listeners (different sessions on the same chat during overlap)
 * can write through this one funnel. Dedup is per-chat, so two
 * witnesses crediting the same user once each only result in ONE row.
 *
 * Fatigue accounting also lives here — we track per-(session, chat)
 * events_observed in a Redis hash flushed to
 * `scrape_monitor_session_fatigue` periodically.
 */

'use strict';

const { pool } = require('../../config/database');
const logger = require('../../utils/logger');
const { redisClient } = require('../../config/redis');
const telegramService = require('../telegramService');

const DEDUP_TTL_SECONDS = 24 * 60 * 60;       // 24h is plenty; chat dies long before this
const PROGRESS_DEBOUNCE_MS = 500;
const FATIGUE_FLUSH_INTERVAL_MS = 30_000;     // 30s
const MAX_BG_ENRICH_PER_FUNNEL = 4;           // concurrent getEntity lookups

function emit(userId, event, payload) {
  try {
    if (global.io) global.io.to(`user:${userId}`).emit(event, payload);
  } catch (err) {
    logger.debug(`emit ${event} failed: ${err.message}`);
  }
}

function isProfileBlank(p) {
  if (!p) return true;
  return !p.username && !p.firstName && !p.lastName && !p.phone;
}

function bucketStart(now = new Date()) {
  // Hourly bucket UTC.
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

function isRedisReady() {
  return Boolean(redisClient && redisClient.isReady);
}

class ObservationFunnel {
  constructor() {
    // chatId → context. Each chat has its own dedup namespace, its own
    // enrich queue, its own debounce clock, and its own buffered
    // fatigue counters.
    this._ctx = new Map();
    this._flushTimer = null;
  }

  _ensureCtx(monitorChatId, jobId, userId) {
    const key = String(monitorChatId);
    let ctx = this._ctx.get(key);
    if (!ctx) {
      ctx = {
        monitorChatId: Number(monitorChatId),
        monitorJobId: Number(jobId),
        userId: Number(userId),
        lastEmitAt: 0,
        // Profile enrichment caches (per-chat — sessions on the same
        // chat share their participant warm cache).
        enrich: {
          profileCache: new Map(),
          inflight: new Set(),
          queue: [],
          activeLookups: 0,
          participantCache: new Map(),
          sessionIds: [],
        },
        // Fatigue accounting: { 'sessionId:targetId' → { events, seconds } }.
        fatigueBuf: new Map(),
        eventsPerMinSamples: [],
      };
      this._ctx.set(key, ctx);
    }
    return ctx;
  }

  registerSession(monitorChatId, sessionId) {
    const ctx = this._ensureCtx(monitorChatId);
    if (!ctx) return;
    const sid = String(sessionId);
    if (!ctx.enrich.sessionIds.includes(sid)) {
      ctx.enrich.sessionIds.push(sid);
    }
  }

  unregisterSession(monitorChatId, sessionId) {
    const key = String(monitorChatId);
    const ctx = this._ctx.get(key);
    if (!ctx) return;
    const sid = String(sessionId);
    ctx.enrich.sessionIds = ctx.enrich.sessionIds.filter((x) => x !== sid);
    if (ctx.enrich.sessionIds.length === 0) {
      // No more listeners — drop the chat ctx so we don't leak.
      this._ctx.delete(key);
    }
  }

  /**
   * Observation pipeline entry point. Returns the action taken so the
   * shift accounting can credit the right counters.
   *
   * @returns {Promise<{inserted: boolean, deduped: boolean}>}
   */
  async observe({
    monitorChatId, monitorJobId, userId, sessionId, targetId,
    profile, kind = 'message', piggybackUsers = null,
  }) {
    if (!profile || !profile.telegramId) return { inserted: false, deduped: false };

    const ctx = this._ensureCtx(monitorChatId, monitorJobId, userId);

    // Fatigue accounting: every observed event bumps the (session,
    // target) counter regardless of dedup outcome.
    this._bumpFatigue(ctx, sessionId, targetId, 1);

    // ---- stage 1: Redis dedup short-circuit -------------------------
    const dedupKey = `mscrape:dedup:${monitorChatId}:${profile.telegramId}`;
    let firstSeen = true;
    if (isRedisReady()) {
      try {
        // SET key 1 NX EX <ttl>. Returns null when the key already
        // existed, otherwise 'OK'. We use NX semantics so concurrent
        // listeners on the same chat both see it as a dedup hit.
        const reply = await redisClient.set(
          dedupKey, '1', { NX: true, EX: DEDUP_TTL_SECONDS }
        );
        firstSeen = reply !== null && reply !== undefined;
      } catch (err) {
        // Redis down → fall through to the DB path; safe but slower.
        logger.debug(`dedup redis error: ${err.message}`);
      }
    }

    // ---- stage 2: enrich --------------------------------------------
    if (isProfileBlank(profile) && piggybackUsers) {
      this._enrichInline(ctx, profile, piggybackUsers);
    }
    if (isProfileBlank(profile)) {
      this._scheduleEnrich(ctx, sessionId, profile.telegramId);
    }

    // ---- stage 3: persist -------------------------------------------
    // Even on dedup hits we still need to bump scrape_monitor_chats
    // events_observed and scrape_monitor_users last_seen_at /
    // message_count. Updates are cheap.
    const inserted = await this._persist({
      ctx, sessionId, profile, firstSeen, kind,
    });

    // ---- stage 4: progress -------------------------------------------
    this._maybeEmitProgress(ctx, inserted ? profile : null, kind);

    return { inserted, deduped: !firstSeen };
  }

  // ----- INTERNAL -------------------------------------------------------

  _bumpFatigue(ctx, sessionId, targetId, events) {
    if (!sessionId || !targetId) return;
    const key = `${sessionId}::${targetId}`;
    const cur = ctx.fatigueBuf.get(key) || { events: 0 };
    cur.events += events;
    ctx.fatigueBuf.set(key, cur);

    // Maintain a 1-minute rolling window per chat to drive the
    // events-per-minute estimate that the planner reads.
    const nowMs = Date.now();
    ctx.eventsPerMinSamples.push(nowMs);
    const cutoff = nowMs - 60_000;
    while (ctx.eventsPerMinSamples.length > 0
        && ctx.eventsPerMinSamples[0] < cutoff) {
      ctx.eventsPerMinSamples.shift();
    }
  }

  /** Cheap synchronous enrichment from in-memory caches (no network). */
  _enrichInline(ctx, profile, piggybacked) {
    const ec = ctx.enrich;

    // 1. Positive cache from prior lookups.
    const cached = ec.profileCache.get(profile.telegramId);
    if (cached) {
      profile.username  = cached.username  || profile.username;
      profile.firstName = cached.firstName || profile.firstName;
      profile.lastName  = cached.lastName  || profile.lastName;
      profile.phone     = cached.phone     || profile.phone;
      profile.isBot     = !!(cached.isBot     || profile.isBot);
      profile.isPremium = !!(cached.isPremium || profile.isPremium);
      profile.accessHash = profile.accessHash || cached.accessHash;
    }

    // 2. Piggybacked user from the originating event/update.
    if (piggybacked && piggybacked[profile.telegramId]) {
      const u = piggybacked[profile.telegramId];
      profile.username  = profile.username  || u.username  || null;
      profile.firstName = profile.firstName || u.firstName || null;
      profile.lastName  = profile.lastName  || u.lastName  || null;
      profile.phone     = profile.phone     || u.phone     || null;
      profile.isBot     = !!(profile.isBot     || u.bot);
      profile.isPremium = !!(profile.isPremium || u.premium);
      profile.accessHash = profile.accessHash
        || (u.accessHash != null ? String(u.accessHash) : null);
    }

    // 3. Participant cache (prefetched once per chat).
    const part = ec.participantCache.get(profile.telegramId);
    if (part) {
      profile.username  = profile.username  || part.username  || null;
      profile.firstName = profile.firstName || part.firstName || null;
      profile.lastName  = profile.lastName  || part.lastName  || null;
      profile.phone     = profile.phone     || part.phone     || null;
    }

    if (!isProfileBlank(profile)) {
      ec.profileCache.set(profile.telegramId, {
        username: profile.username,
        firstName: profile.firstName,
        lastName: profile.lastName,
        phone: profile.phone,
        isBot: profile.isBot,
        isPremium: profile.isPremium,
        accessHash: profile.accessHash,
      });
    }
  }

  _scheduleEnrich(ctx, sessionId, telegramId) {
    const ec = ctx.enrich;
    if (ec.profileCache.has(telegramId)) return;
    if (ec.inflight.has(telegramId)) return;
    if (ec.queue.length > 10000) return;
    ec.queue.push({ telegramId, sessionId: String(sessionId) });
    this._pumpEnrichQueue(ctx);
  }

  _pumpEnrichQueue(ctx) {
    const ec = ctx.enrich;
    while (ec.activeLookups < MAX_BG_ENRICH_PER_FUNNEL && ec.queue.length > 0) {
      const item = ec.queue.shift();
      if (ec.inflight.has(item.telegramId)) continue;
      ec.inflight.add(item.telegramId);
      ec.activeLookups += 1;
      this._runEnrichLookup(ctx, item.sessionId, item.telegramId)
        .catch((e) => logger.debug(`enrich lookup error: ${e.message}`))
        .finally(() => {
          ec.activeLookups -= 1;
          ec.inflight.delete(item.telegramId);
          // Drain anything that arrived during this lookup.
          if (ec.queue.length > 0) this._pumpEnrichQueue(ctx);
        });
    }
  }

  async _runEnrichLookup(ctx, sessionId, telegramId) {
    const ec = ctx.enrich;
    // Try originating session first, then everyone else in the chat's
    // listener pool, so a session that has access_hash for the user
    // resolves it without bouncing through DC migrations.
    const order = [
      String(sessionId),
      ...ec.sessionIds.filter((s) => s !== String(sessionId)),
    ];
    let entity = null;
    for (const sid of order) {
      try {
        const e = await telegramService._resolveEntity(sid, telegramId);
        if (e && e.className === 'User') {
          entity = e;
          ec.participantCache.set(telegramId, e);
          break;
        }
      } catch (err) {
        logger.debug(`enrich via ${sid}: ${err.message}`);
      }
    }
    if (!entity) return;

    const enriched = {
      telegramId,
      username: entity.username || null,
      firstName: entity.firstName || null,
      lastName: entity.lastName || null,
      phone: entity.phone || null,
      isBot: !!entity.bot,
      isPremium: !!entity.premium,
      accessHash: entity.accessHash != null ? String(entity.accessHash) : null,
      hasProfilePhoto: !!(entity.photo && (entity.photo.photoId || entity.photo.photoSmall)),
      dcId: entity.photo && typeof entity.photo.dcId === 'number' ? entity.photo.dcId : null,
      isVerified: !!entity.verified,
      isScam: !!entity.scam,
      isFake: !!entity.fake,
      isRestricted: !!entity.restricted,
      isDeleted: !!entity.deleted,
      langCode: entity.langCode || null,
      status: entity.status && entity.status.className || null,
    };
    ec.profileCache.set(telegramId, enriched);

    // Back-fill every existing row for this user in this chat that's
    // still missing fields. COALESCE preserves anything we already had.
    try {
      await pool.query(
        `UPDATE scrape_monitor_users
            SET username    = COALESCE(username, $3),
                first_name  = COALESCE(first_name, $4),
                last_name   = COALESCE(last_name, $5),
                phone       = COALESCE(phone, $6),
                is_bot      = is_bot OR $7,
                is_premium  = is_premium OR $8,
                access_hash = COALESCE(access_hash, $9),
                has_profile_photo = has_profile_photo OR $10,
                dc_id       = COALESCE(dc_id, $11),
                is_verified = is_verified OR $12,
                is_scam     = is_scam OR $13,
                is_fake     = is_fake OR $14,
                is_restricted = is_restricted OR $15,
                is_deleted  = is_deleted OR $16,
                lang_code   = COALESCE(lang_code, $17),
                status      = COALESCE(status, $18)
          WHERE monitor_job_id = $1
            AND telegram_id    = $2`,
        [
          ctx.monitorJobId, telegramId,
          enriched.username, enriched.firstName, enriched.lastName,
          enriched.phone,
          enriched.isBot, enriched.isPremium,
          enriched.accessHash, enriched.hasProfilePhoto,
          enriched.dcId,
          enriched.isVerified, enriched.isScam, enriched.isFake,
          enriched.isRestricted, enriched.isDeleted,
          enriched.langCode, enriched.status,
        ]
      );
    } catch (err) {
      logger.debug(`enrich backfill failed: ${err.message}`);
    }
  }

  async _persist({ ctx, sessionId, profile, firstSeen, kind }) {
    // The job-level events_observed counter is the operator's "how
    // much chatter happened in the window". Bump it on EVERY observation.
    try {
      await pool.query(
        `UPDATE scrape_monitor_chats
            SET events_observed = events_observed + 1,
                last_event_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [ctx.monitorChatId]
      );
      // Mirror onto the parent job too so legacy UI keeps working.
      await pool.query(
        `UPDATE scrape_monitor_jobs
            SET events_observed = events_observed + 1,
                updated_at = NOW()
          WHERE id = $1`,
        [ctx.monitorJobId]
      );
    } catch (err) {
      logger.debug(`bump events_observed: ${err.message}`);
    }

    if (!firstSeen) {
      // Repeat sender — just touch the existing row's last_seen_at /
      // counter. Worth it because operators sort by activity volume.
      try {
        await pool.query(
          `UPDATE scrape_monitor_users
              SET message_count = message_count + 1,
                  last_seen_at  = NOW(),
                  username      = COALESCE($3, username),
                  first_name    = COALESCE($4, first_name),
                  last_name     = COALESCE($5, last_name),
                  phone         = COALESCE($6, phone)
            WHERE monitor_job_id = $1 AND telegram_id = $2`,
          [
            ctx.monitorJobId, profile.telegramId,
            profile.username, profile.firstName, profile.lastName,
            profile.phone,
          ]
        );
      } catch (err) {
        logger.debug(`update existing user row: ${err.message}`);
      }
      return false;
    }

    // First time we've seen this user in this chat (per Redis dedup).
    // The DB-side composite index (v10) means a parallel listener that
    // raced past the Redis NX will still UPDATE-on-conflict cleanly.
    try {
      // Race-safe upsert. If a parallel listener inserted the row in
      // the gap between our Redis NX and this INSERT, we degrade to UPDATE.
      const result = await pool.query(
        `INSERT INTO scrape_monitor_users
            (monitor_job_id, monitor_chat_id, telegram_id, username,
             first_name, last_name, phone, is_bot, is_premium,
             message_count, first_seen_at, last_seen_at, via_session_id,
             access_hash, has_profile_photo, dc_id,
             is_verified, is_scam, is_fake, is_restricted, is_deleted,
             lang_code, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, NOW(), NOW(), $10,
                  $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
          ON CONFLICT (monitor_chat_id, telegram_id) DO UPDATE
            SET message_count = scrape_monitor_users.message_count + 1,
                last_seen_at  = NOW(),
                username      = COALESCE(EXCLUDED.username,   scrape_monitor_users.username),
                first_name    = COALESCE(EXCLUDED.first_name, scrape_monitor_users.first_name),
                last_name     = COALESCE(EXCLUDED.last_name,  scrape_monitor_users.last_name),
                phone         = COALESCE(EXCLUDED.phone,      scrape_monitor_users.phone)
          RETURNING (xmax = 0) AS inserted`,
        [
          ctx.monitorJobId, ctx.monitorChatId, profile.telegramId,
          profile.username, profile.firstName, profile.lastName,
          profile.phone, !!profile.isBot, !!profile.isPremium, sessionId,
          profile.accessHash != null ? String(profile.accessHash) : null,
          !!profile.hasProfilePhoto,
          profile.dcId != null ? Number(profile.dcId) : null,
          !!profile.isVerified, !!profile.isScam, !!profile.isFake,
          !!profile.isRestricted, !!profile.isDeleted,
          profile.langCode || null,
          profile.status || null,
        ]
      );
      const insertedFlag = result.rows[0]?.inserted === true;
      if (insertedFlag) {
        await pool.query(
          `UPDATE scrape_monitor_chats
              SET scraped_count = scraped_count + 1,
                  updated_at = NOW()
            WHERE id = $1`,
          [ctx.monitorChatId]
        );
        await pool.query(
          `UPDATE scrape_monitor_jobs
              SET scraped_count = scraped_count + 1,
                  updated_at = NOW()
            WHERE id = $1`,
          [ctx.monitorJobId]
        );
      }
      return insertedFlag;
    } catch (err) {
      logger.warn(`scrape_monitor_users insert failed: ${err.message}`);
      return false;
    }
  }

  _maybeEmitProgress(ctx, newUser, kind) {
    const now = Date.now();
    if (now - ctx.lastEmitAt < PROGRESS_DEBOUNCE_MS) return;
    ctx.lastEmitAt = now;
    emit(ctx.userId, 'monitor:progress', {
      jobId: ctx.monitorJobId,
      chatId: ctx.monitorChatId,
      newUser: newUser ? {
        telegramId: String(newUser.telegramId),
        username: newUser.username,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        source: kind,
      } : null,
    });
  }

  /**
   * Flush all in-memory per-(session, chat) fatigue counters to
   * `scrape_monitor_session_fatigue`. Called by a periodic timer in
   * the orchestrator and also explicitly from `unregisterSession`.
   */
  async flushFatigue() {
    const bucket = bucketStart();
    for (const [, ctx] of this._ctx) {
      if (ctx.fatigueBuf.size === 0) continue;
      const buf = ctx.fatigueBuf;
      ctx.fatigueBuf = new Map();
      for (const [key, val] of buf) {
        const [sessionId, targetId] = key.split('::');
        if (!sessionId || !targetId) continue;
        try {
          await pool.query(
            `INSERT INTO scrape_monitor_session_fatigue
                (session_id, target_id, window_start, events_observed)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (session_id, target_id, window_start) DO UPDATE
                SET events_observed = scrape_monitor_session_fatigue.events_observed + EXCLUDED.events_observed`,
            [Number(sessionId), String(targetId), bucket, val.events]
          );
        } catch (err) {
          logger.debug(`fatigue flush failed: ${err.message}`);
        }
      }
    }
  }

  /**
   * Get current events/minute estimate for a chat. Read by the
   * orchestrator before each plan() call.
   */
  getEventsPerMinute(monitorChatId) {
    const ctx = this._ctx.get(String(monitorChatId));
    if (!ctx) return 0;
    const cutoff = Date.now() - 60_000;
    let n = 0;
    for (const t of ctx.eventsPerMinSamples) {
      if (t >= cutoff) n += 1;
    }
    return n;
  }

  /**
   * Wire up a periodic fatigue flush. The orchestrator calls this once
   * on boot. Safe to call multiple times; later calls are no-ops.
   */
  startBackgroundFlusher() {
    if (this._flushTimer) return;
    this._flushTimer = setInterval(() => {
      this.flushFatigue().catch((e) =>
        logger.debug(`fatigue flush timer error: ${e.message}`)
      );
    }, FATIGUE_FLUSH_INTERVAL_MS);
    this._flushTimer.unref?.();
  }

  stopBackgroundFlusher() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }

  /**
   * Prime per-chat participant cache. Best-effort; admin-only chats
   * will simply fail this silently and we fall back to per-event
   * `getEntity` lookups.
   */
  async primeParticipantCache(monitorChatId, sessionIds, targetId) {
    const ctx = this._ensureCtx(monitorChatId);
    if (!ctx) return;
    for (const sid of sessionIds) {
      try {
        const sidStr = String(sid);
        const entity = await telegramService._resolveEntity(sidStr, targetId);
        if (!entity) continue;
        const client = telegramService.clients?.get(sidStr)?.client;
        if (!client) continue;
        let count = 0;
        try {
          for await (const u of client.iterParticipants(entity, { limit: 5000 })) {
            if (!u || u.className !== 'User' || u.id === undefined) continue;
            const id = String(u.id);
            if (!ctx.enrich.participantCache.has(id)) {
              ctx.enrich.participantCache.set(id, u);
            }
            count += 1;
          }
        } catch (inner) {
          logger.debug(`primeParticipantCache stopped on ${sid}: ${inner.message}`);
        }
        if (count > 0) {
          logger.debug(`Monitor chat ${monitorChatId} primed ${count} participants via ${sid}`);
          return;
        }
      } catch (err) {
        logger.debug(`primeParticipantCache via ${sid} failed: ${err.message}`);
      }
    }
  }
}

module.exports = new ObservationFunnel();
