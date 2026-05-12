/**
 * ScrapeMonitorService - Period-bounded passive scraper for admin-only chats.
 *
 * Why this exists
 * ---------------
 * A subset of Telegram groups and broadcast channels are configured so that
 * only admins can read the participant roster. For these chats Telegram
 * answers `getParticipants` with `CHAT_ADMIN_REQUIRED` (or simply hides the
 * roster), which makes the regular ScrapeService impossible to use.
 *
 * The next-best signal of who is in the chat is who *interacts* with it.
 * This service lets the user pick a window (e.g. 2 days), and then attaches
 * a passive `NewMessage` handler to each of their selected sessions. Every
 * distinct sender we see during the window is upserted into
 * `scrape_monitor_users` with `UNIQUE(monitor_job_id, telegram_id)` so the
 * dedup is enforced by the database.
 *
 * Properties
 * ----------
 *   * Multi-session: every selected session listens; first session to see a
 *     given user is recorded as `via_session_id`. We keep working as long as
 *     at least one session stays connected (the others' listeners no-op).
 *   * Anti-detect / proxy aware: we rely on the GramJS clients that are
 *     already booted by sessionService through the per-session bound proxy.
 *     We do not generate any extra outgoing API calls — we only consume
 *     updates Telegram is already pushing to the connection.
 *   * Pause / Resume / Stop / Cancel: pause detaches the listeners and
 *     persists `remaining_seconds`; resume reattaches and recomputes
 *     `expires_at`. Stop / cancel is a hard close.
 *   * Cancel-all: a single endpoint stops every running monitor for the
 *     calling user.
 *   * Crash-safe: on boot we re-read every job whose `status='running'`
 *     and `expires_at>NOW()` and reattach listeners; expired jobs are
 *     rolled to `completed`.
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const telegramService = require('./telegramService');
const { AppError } = require('../utils/errorHandler');

const VALID_STATUSES = new Set([
  'pending', 'running', 'paused', 'completed', 'cancelled', 'failed',
]);
const MAX_DURATION_SECONDS = 60 * 60 * 24 * 30;   // 30 days hard cap
const MIN_DURATION_SECONDS = 60;                  // 1 minute lower bound
const MAX_SESSIONS_PER_JOB = 10;
const PROGRESS_EMIT_DEBOUNCE_MS = 500;
// v8: hard cap on simultaneously-running monitor jobs PER USER, to
// keep the WS event load and DB upsert load predictable at the
// 500–700 concurrent user target. A motivated user can still queue
// more jobs in `pending` and they'll start as running ones complete.
const MAX_RUNNING_MONITORS_PER_USER = parseInt(
  process.env.MAX_RUNNING_MONITORS_PER_USER || '20',
  10
);
// How often we tell the UI "you have X seconds left and Y users so
// far" even when nothing has happened. Lower = snappier countdown,
// higher = less WS chatter. 10s is a good default.
const TICK_INTERVAL_MS = 10_000;

function emit(userId, event, payload) {
  try {
    if (global.io) global.io.to(`user:${userId}`).emit(event, payload);
  } catch (err) {
    logger.debug(`emit ${event} failed: ${err.message}`);
  }
}

/**
 * Convert a GramJS BigInteger / number / string into a stable string
 * representation suitable for storing in `telegram_id`. Telegram IDs are
 * 64-bit ints; using `Number()` would lose precision for IDs > 2^53.
 */
function bigToString(v) {
  if (v === null || v === undefined) return null;
  // GramJS BigInteger objects expose either `.value` (BigInt) or
  // `.toString()`. big-integer objects expose `.toString()`. Plain
  // bigints/numbers/strings just stringify directly.
  if (typeof v === 'object') {
    if (v.value !== undefined) return String(v.value);
    if (typeof v.toString === 'function') {
      const s = v.toString();
      return s === '[object Object]' ? null : s;
    }
    return null;
  }
  return String(v);
}

/**
 * Pull `userId` out of any GramJS Peer-ish or fromId-ish object. Returns
 * a stable string or null.
 */
function extractUserIdFromPeer(peer) {
  if (!peer) return null;
  // PeerUser has `.userId`. fromId may itself be a PeerUser.
  if (peer.userId !== undefined && peer.userId !== null) {
    return bigToString(peer.userId);
  }
  // Some GramJS shapes just put the bigint directly.
  if (typeof peer === 'number' || typeof peer === 'bigint' || typeof peer === 'string') {
    const s = String(peer);
    return /^-?\d+$/.test(s) ? s : null;
  }
  return null;
}

/**
 * Enrich a profile object in-place with a cached sender entity if one is
 * available. Safe to call with nulls.
 */
function applySenderEntity(profile, entity) {
  if (!profile || !entity || entity.className !== 'User') return;
  profile.username = entity.username || profile.username || null;
  profile.firstName = entity.firstName || profile.firstName || null;
  profile.lastName = entity.lastName || profile.lastName || null;
  profile.phone = entity.phone || profile.phone || null;
  profile.isBot = !!(entity.bot || profile.isBot);
  profile.isPremium = !!(entity.premium || profile.isPremium);
  // v19: capture the rest of the User flags / scalars so monitor
  // exports can include verified/scam/lang/etc. Only overwrite fields
  // that are still unset on the profile so a more authoritative
  // enrichment doesn't get clobbered by a later piggy-backed event.
  profile.isVerified = !!(entity.verified || profile.isVerified);
  profile.isScam = !!(entity.scam || profile.isScam);
  profile.isFake = !!(entity.fake || profile.isFake);
  profile.isRestricted = !!(entity.restricted || profile.isRestricted);
  profile.isDeleted = !!(entity.deleted || profile.isDeleted);
  profile.isSupport = !!(entity.support || profile.isSupport);
  profile.isContact = !!(entity.contact || profile.isContact);
  profile.isMutualContact = !!(entity.mutualContact || profile.isMutualContact);
  profile.isCloseFriend = !!(entity.closeFriend || profile.isCloseFriend);
  profile.langCode = entity.langCode || profile.langCode || null;
  profile.accessHash = profile.accessHash
    || (entity.accessHash != null ? bigToString(entity.accessHash) : null);
  profile.status = (entity.status && entity.status.className) || profile.status || null;
  profile.hasProfilePhoto = profile.hasProfilePhoto
    || !!(entity.photo && (entity.photo.photoId || entity.photo.photoSmall));
  profile.dcId = profile.dcId
    || (entity.photo && typeof entity.photo.dcId === 'number' ? entity.photo.dcId : null);
  profile.restrictionReason = profile.restrictionReason
    || (Array.isArray(entity.restrictionReason) && entity.restrictionReason.length
      ? entity.restrictionReason.map((r) => `${r.platform || 'all'}:${r.reason}:${r.text || ''}`).join('; ')
      : null);
}

function blankProfile(telegramId) {
  return {
    telegramId,
    username: null,
    firstName: null,
    lastName: null,
    phone: null,
    isBot: false,
    isPremium: false,
    isVerified: false,
    isScam: false,
    isFake: false,
    isRestricted: false,
    isDeleted: false,
    isSupport: false,
    isContact: false,
    isMutualContact: false,
    isCloseFriend: false,
    langCode: null,
    accessHash: null,
    status: null,
    hasProfilePhoto: false,
    dcId: null,
    restrictionReason: null,
  };
}

/**
 * True when a profile only carries telegramId — username/first_name/
 * last_name/phone are all unknown. Used to decide whether to fire a
 * background enrichment lookup so the row gets filled in before the
 * CSV export.
 */
function isProfileBlank(profile) {
  if (!profile) return true;
  return (
    !profile.username &&
    !profile.firstName &&
    !profile.lastName &&
    !profile.phone
  );
}

/**
 * Try to harvest enriched user objects piggybacked on a raw GramJS
 * update / event. GramJS attaches `_entities` / `users` / `chats` on
 * the Updates envelope and on the dispatched event in a few places —
 * not always, but often enough to spare us a getEntity round-trip.
 *
 * Returns a plain object map { telegramId: User } so callers can
 * lookup by id.
 */
function harvestPiggybackedUsers(eventOrUpdate) {
  const out = {};
  if (!eventOrUpdate) return out;
  const buckets = [
    eventOrUpdate.users,            // Updates envelope
    eventOrUpdate._entities,        // GramJS dispatcher
    eventOrUpdate.message?._entities,
    eventOrUpdate.update?.users,    // raw .update wrapper
  ];
  for (const b of buckets) {
    if (!b) continue;
    if (b instanceof Map) {
      for (const [, u] of b) {
        if (u && u.className === 'User' && u.id !== undefined) {
          const id = bigToString(u.id);
          if (id) out[id] = u;
        }
      }
    } else if (Array.isArray(b)) {
      for (const u of b) {
        if (u && u.className === 'User' && u.id !== undefined) {
          const id = bigToString(u.id);
          if (id) out[id] = u;
        }
      }
    }
  }
  return out;
}

/**
 * Best-effort: extract the sender user ID and basic profile from a GramJS
 * NewMessage event. Returns `null` when the message has no user sender
 * (channel posts on behalf of the channel, etc).
 *
 * Service messages (joins/adds/leaves) are handled here too: the joining
 * user is taken from `msg.fromId` / `msg.action.users` so a "user joined"
 * event still records the user as having "performed an action".
 */
async function extractSenderProfile(event) {
  const msg = event?.message || event;
  if (!msg) return null;

  // Try senderId first (most reliable in modern GramJS).
  let telegramId = null;
  if (msg.senderId) {
    telegramId = bigToString(msg.senderId);
  }
  if (!telegramId && msg.fromId) {
    telegramId = extractUserIdFromPeer(msg.fromId);
  }
  if (!telegramId && msg.peerId && msg.peerId.userId !== undefined) {
    telegramId = extractUserIdFromPeer(msg.peerId);
  }

  // For MessageService(action=MessageActionChatAddUser/JoinedByLink/...) we
  // can fall back to the action's `userId` / `users` lists if the sender
  // wasn't otherwise obvious.
  const action = msg.action;
  if (!telegramId && action) {
    if (Array.isArray(action.users) && action.users.length > 0) {
      telegramId = bigToString(action.users[0]);
    } else if (action.userId !== undefined && action.userId !== null) {
      telegramId = bigToString(action.userId);
    } else if (action.fromId !== undefined && action.fromId !== null) {
      telegramId = extractUserIdFromPeer(action.fromId);
    }
  }
  if (!telegramId) return null;
  // Telegram channel-posts-as-channel produce IDs that look like a
  // user's but with the wrong sign / shape. We require positive
  // numeric ids for users.
  if (!/^\d+$/.test(telegramId)) return null;

  const profile = blankProfile(telegramId);

  // Try to enrich with the cached sender entity. GramJS attaches `_sender`
  // automatically when the event passes through its dispatcher.
  const cachedSender = msg._sender;
  if (cachedSender) {
    applySenderEntity(profile, cachedSender);
  } else if (typeof event.getSender === 'function') {
    try {
      const fetched = await event.getSender();
      applySenderEntity(profile, fetched);
    } catch {
      // Sender not in cache and we lack access_hash to fetch — that's OK,
      // we still capture the bare telegramId.
    }
  }

  return profile;
}

/**
 * Extract a user profile out of a Raw GramJS update (typing, reactions,
 * channel-participant changes). Returns `null` when the update doesn't
 * belong to a real user (channel-as-sender, system updates, etc).
 *
 * The shape of `update` depends on its className; this function knows the
 * specific update types we subscribe to.
 */
function extractSenderFromRawUpdate(update) {
  if (!update || !update.className) return null;
  switch (update.className) {
    // Typing: the user is "performing an action" without sending a msg.
    case 'UpdateUserTyping':
    case 'UpdateChatUserTyping':
    case 'UpdateChannelUserTyping': {
      const id = update.fromId
        ? extractUserIdFromPeer(update.fromId)
        : update.userId !== undefined
          ? bigToString(update.userId)
          : null;
      if (!id || !/^\d+$/.test(id)) return null;
      return blankProfile(id);
    }
    // Reactions on a single message in a group/supergroup. We can credit
    // the most recent reactor (anonymous reactions in big channels are
    // normally suppressed by Telegram — recentReactions is empty there).
    case 'UpdateMessageReactions':
    case 'UpdateChannelMessageReactions': {
      const recent =
        update.reactions && Array.isArray(update.reactions.recentReactions)
          ? update.reactions.recentReactions
          : [];
      // Return the LAST recent reactor — that's the user who just acted.
      for (let i = recent.length - 1; i >= 0; i--) {
        const r = recent[i];
        const id = extractUserIdFromPeer(r?.peerId);
        if (id && /^\d+$/.test(id)) return blankProfile(id);
      }
      return null;
    }
    // Admin-visible: user joined / was added / was banned / left.
    case 'UpdateChannelParticipant':
    case 'UpdateChatParticipant': {
      const id = update.userId !== undefined ? bigToString(update.userId) : null;
      if (!id || !/^\d+$/.test(id)) return null;
      return blankProfile(id);
    }
    case 'UpdateChatParticipantAdd': {
      const id = update.userId !== undefined ? bigToString(update.userId) : null;
      if (!id || !/^\d+$/.test(id)) return null;
      return blankProfile(id);
    }
    case 'UpdateChatParticipantDelete': {
      const id = update.userId !== undefined ? bigToString(update.userId) : null;
      if (!id || !/^\d+$/.test(id)) return null;
      return blankProfile(id);
    }
    default:
      return null;
  }
}

/**
 * GramJS Api.* update class names that the Raw handler subscribes to.
 * Kept as className strings so we can match without importing the Api
 * objects at module load time (the require chain pulls in tons of code).
 */
const RAW_UPDATE_CLASSNAMES = new Set([
  // The actual NewMessage/NewChannelMessage updates — we use these to
  // capture MessageService events (joins, adds, etc) that NewMessage's
  // build() filter rejects.
  'UpdateNewMessage',
  'UpdateNewChannelMessage',
  'UpdateShortChatMessage',
  'UpdateShortMessage',
  // Typing / interaction signals.
  'UpdateUserTyping',
  'UpdateChatUserTyping',
  'UpdateChannelUserTyping',
  // Reactions.
  'UpdateMessageReactions',
  'UpdateChannelMessageReactions',
  // Membership churn (delivered to admins for channel/supergroup; to all
  // members for basic chats via UpdateChatParticipantAdd/Delete).
  'UpdateChannelParticipant',
  'UpdateChatParticipant',
  'UpdateChatParticipantAdd',
  'UpdateChatParticipantDelete',
]);

class ScrapeMonitorService {
  constructor() {
    /** jobId -> { unsubs: Map<sessionId, () => void>, timer, userId, lastEmitAt } */
    this._active = new Map();
  }

  // --------------------------------------------------------------------
  // CRUD-like surface
  // --------------------------------------------------------------------

  /**
   * Create a monitor job. Validates ownership of the sessions and that the
   * target string is non-empty. Returns the inserted row plus the live job
   * lifecycle info.
   */
  async createJob({
    userId, sessionIds, targetId, targetType = 'group',
    targetTitle = null, durationSeconds, reason = null, options = {},
    autoStart = true, dedupEnabled,
  }) {
    if (!userId) throw new AppError('User id required', 400, 'MISSING_USER_ID');
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('Select at least one session', 400, 'NO_SESSIONS');
    }
    if (sessionIds.length > MAX_SESSIONS_PER_JOB) {
      throw new AppError(`At most ${MAX_SESSIONS_PER_JOB} sessions`, 400, 'TOO_MANY_SESSIONS');
    }
    if (!targetId) {
      throw new AppError('Target id required', 400, 'MISSING_TARGET');
    }
    const duration = Math.max(
      MIN_DURATION_SECONDS,
      Math.min(MAX_DURATION_SECONDS, Math.floor(Number(durationSeconds) || 0))
    );
    if (!duration) {
      throw new AppError('durationSeconds required', 400, 'MISSING_DURATION');
    }

    // v10: Resolve dedup mode. The frontend passes the toggle as either
    // a top-level `dedupEnabled` field on the request body, or nested
    // under options.dedupEnabled / options.allowDuplicates. We accept
    // all three to keep the surface forgiving for direct API users.
    const optsIn = (options && typeof options === 'object') ? options : {};
    let dedup = dedupEnabled;
    if (dedup === undefined && Object.prototype.hasOwnProperty.call(optsIn, 'dedupEnabled')) {
      dedup = optsIn.dedupEnabled;
    }
    if (dedup === undefined && Object.prototype.hasOwnProperty.call(optsIn, 'allowDuplicates')) {
      // `allowDuplicates: true`  → dedup OFF.
      dedup = !optsIn.allowDuplicates;
    }
    if (dedup === undefined) dedup = true;        // v6 default
    dedup = !!dedup;

    // Persist the resolved flag inside `options` too so it survives
    // existing tooling that only reads the JSONB blob, while the new
    // top-level column remains the source of truth for queries.
    const persistedOptions = { ...optsIn, dedupEnabled: dedup };

    const ids = sessionIds.map((s) => parseInt(s, 10)).filter(Number.isFinite);
    const owned = await pool.query(
      `SELECT id FROM sessions
       WHERE id = ANY($1::int[]) AND user_id = $2 AND is_logged_in = TRUE`,
      [ids, userId]
    );
    if (owned.rows.length === 0) {
      throw new AppError('No logged-in sessions selected', 400, 'NO_VALID_SESSIONS');
    }
    const validIds = owned.rows.map((r) => r.id);

    const insert = await pool.query(
      `INSERT INTO scrape_monitor_jobs
         (user_id, session_ids, target_id, target_type, target_title,
          status, duration_seconds, remaining_seconds, options, reason,
          dedup_enabled)
       VALUES ($1, $2::int[], $3, $4, $5,
               'pending', $6::int, $6::int, $7::jsonb, $8, $9)
       RETURNING *`,
      [
        userId, validIds, String(targetId), String(targetType),
        targetTitle, duration, JSON.stringify(persistedOptions), reason,
        dedup,
      ]
    );
    const job = insert.rows[0];
    logger.info(`Monitor job created`, {
      jobId: job.id, userId, sessionCount: validIds.length, durationSeconds: duration,
      dedupEnabled: dedup,
    });
    emit(userId, 'monitor:created', { jobId: job.id });

    if (autoStart) {
      try {
        await this.startJob(job.id, userId);
      } catch (err) {
        logger.error(`Monitor job ${job.id} autoStart failed`, { error: err.message });
        await pool.query(
          `UPDATE scrape_monitor_jobs SET status='failed', reason=$1, updated_at=NOW() WHERE id=$2`,
          [err.message.slice(0, 500), job.id]
        );
      }
    }

    return await this.getJob(job.id, userId);
  }

  async startJob(jobId, userId) {
    const job = await this._loadOwned(jobId, userId);
    if (!['pending', 'paused'].includes(job.status)) {
      throw new AppError(
        `Cannot start a job in status '${job.status}'`, 400, 'INVALID_STATE'
      );
    }
    // Per-user running cap. We only enforce on transition from
    // pending -> running so resume-from-pause is never blocked (the
    // user has already paid the slot).
    if (job.status === 'pending') {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS n FROM scrape_monitor_jobs
          WHERE user_id = $1 AND status = 'running'`,
        [userId]
      );
      if (r.rows[0].n >= MAX_RUNNING_MONITORS_PER_USER) {
        throw new AppError(
          `You already have ${r.rows[0].n} running monitor jobs. Wait for one to finish or stop it before starting another.`,
          429,
          'TOO_MANY_RUNNING_MONITORS'
        );
      }
    }
    const remaining = Math.max(
      MIN_DURATION_SECONDS,
      Number(job.remaining_seconds || job.duration_seconds || 0)
    );
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + remaining * 1000);

    await pool.query(
      `UPDATE scrape_monitor_jobs
         SET status='running',
             started_at = COALESCE(started_at, NOW()),
             paused_at = NULL,
             remaining_seconds = $1,
             expires_at = $2,
             updated_at = NOW()
       WHERE id = $3`,
      [remaining, expiresAt, jobId]
    );

    await this._attach(
      jobId, userId, job.session_ids, remaining, job.target_id,
      { dedupEnabled: !!job.dedup_enabled }
    );
    emit(userId, 'monitor:started', { jobId, expiresAt });
    return await this.getJob(jobId, userId);
  }

  async pauseJob(jobId, userId) {
    const job = await this._loadOwned(jobId, userId);
    if (job.status !== 'running') {
      throw new AppError(`Cannot pause a job in status '${job.status}'`, 400, 'INVALID_STATE');
    }
    const remaining = job.expires_at
      ? Math.max(0, Math.floor((new Date(job.expires_at).getTime() - Date.now()) / 1000))
      : 0;

    await this._detach(jobId);
    await pool.query(
      `UPDATE scrape_monitor_jobs
         SET status='paused', paused_at=NOW(),
             remaining_seconds=$1, updated_at=NOW()
       WHERE id=$2`,
      [remaining, jobId]
    );
    emit(userId, 'monitor:paused', { jobId, remainingSeconds: remaining });
    return await this.getJob(jobId, userId);
  }

  async resumeJob(jobId, userId) {
    return await this.startJob(jobId, userId);
  }

  async stopJob(jobId, userId, status = 'cancelled') {
    const job = await this._loadOwned(jobId, userId);
    if (['completed', 'cancelled', 'failed'].includes(job.status)) {
      return await this.getJob(jobId, userId);
    }
    if (!VALID_STATUSES.has(status)) status = 'cancelled';

    await this._detach(jobId);
    await pool.query(
      `UPDATE scrape_monitor_jobs
         SET status=$1, completed_at=NOW(), updated_at=NOW()
       WHERE id=$2`,
      [status, jobId]
    );
    emit(userId, 'monitor:stopped', { jobId, status });
    return await this.getJob(jobId, userId);
  }

  async cancelAll(userId) {
    const r = await pool.query(
      `SELECT id FROM scrape_monitor_jobs
       WHERE user_id=$1 AND status IN ('pending', 'running', 'paused')`,
      [userId]
    );
    let cancelled = 0;
    for (const row of r.rows) {
      try {
        await this.stopJob(row.id, userId, 'cancelled');
        cancelled++;
      } catch (err) {
        logger.warn(`cancelAll: skip ${row.id}: ${err.message}`);
      }
    }
    emit(userId, 'monitor:cancel-all', { cancelled });
    return { cancelled };
  }

  // --------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------

  async listJobs(userId, { page = 1, limit = 20, status, search } = {}) {
    const where = ['user_id = $1'];
    const values = [userId];
    let i = 2;
    if (status && VALID_STATUSES.has(status)) {
      where.push(`status = $${i++}`);
      values.push(status);
    }
    if (search) {
      where.push(`(target_id ILIKE $${i} OR COALESCE(target_title,'') ILIKE $${i})`);
      values.push(`%${search}%`);
      i++;
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = await pool.query(
      `SELECT COUNT(*)::int AS n FROM scrape_monitor_jobs ${whereSql}`,
      values
    );
    const offset = Math.max(0, (page - 1) * limit);
    // We re-namespace the WHERE clause columns to the `j.` alias for
    // the joined-style SELECT below.  All other tables in this query
    // are correlated subqueries so no other column references collide.
    const whereSqlAliased = whereSql
      .replace(/\buser_id\b/g, 'j.user_id')
      .replace(/\bstatus\b/g, 'j.status')
      .replace(/\btarget_id\b/g, 'j.target_id')
      .replace(/\btarget_title\b/g, 'j.target_title');

    const list = await pool.query(
      `SELECT j.*,
              (SELECT COUNT(*)::int FROM scrape_monitor_chats c
                WHERE c.monitor_job_id = j.id) AS chat_count
         FROM scrape_monitor_jobs j ${whereSqlAliased}
         ORDER BY j.created_at DESC
         LIMIT $${i} OFFSET $${i + 1}`,
      [...values, limit, offset]
    );
    return {
      jobs: list.rows.map((r) => this._toPublic(r)),
      pagination: {
        page, limit,
        total: total.rows[0].n,
        pages: Math.max(1, Math.ceil(total.rows[0].n / limit)),
      },
    };
  }

  async getJob(jobId, userId) {
    const r = await pool.query(
      `SELECT * FROM scrape_monitor_jobs WHERE id=$1 AND user_id=$2`,
      [jobId, userId]
    );
    if (!r.rows[0]) throw new AppError('Monitor job not found', 404, 'JOB_NOT_FOUND');
    return this._toPublic(r.rows[0]);
  }

  async listScrapedUsers(jobId, userId, { page = 1, limit = 50, search } = {}) {
    await this._loadOwned(jobId, userId); // authorize
    const where = ['monitor_job_id = $1'];
    const values = [jobId];
    let i = 2;
    if (search) {
      where.push(`(
        username ILIKE $${i} OR first_name ILIKE $${i}
        OR last_name ILIKE $${i} OR CAST(telegram_id AS TEXT) ILIKE $${i}
      )`);
      values.push(`%${search}%`);
      i++;
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = await pool.query(
      `SELECT COUNT(*)::int AS n FROM scrape_monitor_users ${whereSql}`,
      values
    );
    const offset = Math.max(0, (page - 1) * limit);
    const list = await pool.query(
      `SELECT * FROM scrape_monitor_users ${whereSql}
       ORDER BY last_seen_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...values, limit, offset]
    );
    return {
      users: list.rows,
      pagination: {
        page, limit,
        total: total.rows[0].n,
        pages: Math.max(1, Math.ceil(total.rows[0].n / limit)),
      },
    };
  }

  // --------------------------------------------------------------------
  // Boot-time recovery
  // --------------------------------------------------------------------

  /**
   * On startup, re-attach listeners for monitor jobs that were running
   * before the process restarted and whose window hasn't expired. Jobs
   * whose window already elapsed get rolled to `completed`.
   */
  async resumeActiveJobs() {
    const r = await pool.query(
      `SELECT id, user_id, session_ids, target_id, expires_at, dedup_enabled
         FROM scrape_monitor_jobs
        WHERE status = 'running'`
    );
    for (const job of r.rows) {
      const remaining = job.expires_at
        ? Math.floor((new Date(job.expires_at).getTime() - Date.now()) / 1000)
        : 0;
      if (remaining <= 0) {
        await this._finishJob(job.id, job.user_id);
        continue;
      }
      try {
        await this._attach(
          job.id, job.user_id, job.session_ids, remaining, job.target_id,
          { dedupEnabled: job.dedup_enabled !== false }
        );
        logger.info(`Resumed monitor job ${job.id} (${remaining}s remaining)`);
      } catch (err) {
        logger.warn(`Failed to resume monitor job ${job.id}: ${err.message}`);
      }
    }
  }

  // --------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------

  async _loadOwned(jobId, userId) {
    const r = await pool.query(
      `SELECT * FROM scrape_monitor_jobs WHERE id=$1 AND user_id=$2`,
      [jobId, userId]
    );
    if (!r.rows[0]) throw new AppError('Monitor job not found', 404, 'JOB_NOT_FOUND');
    return r.rows[0];
  }

  async _attach(jobId, userId, sessionIds, remainingSeconds, targetId, attachOpts = {}) {
    // Idempotent: replace any existing listeners for this job.
    await this._detach(jobId);

    const dedupEnabled = attachOpts.dedupEnabled !== false; // v6 default = TRUE

    // Build an allow-list of every chat id form we recognise for the
    // target. _resolveEntity warms each session's peer cache so future
    // `getSender()` / `getInputEntity()` calls during dispatch hit the
    // cache instead of going to the network. The allow list is then
    // used by `_eventMatchesTarget` to keep cross-talk events from
    // other chats out of this monitor job.
    //
    // History note: previous versions of this service ALSO passed a
    // `chats` filter into GramJS's NewMessage builder. That turned out
    // to be the dominant cause of the "10 active users, only 2-3
    // captured" symptom: GramJS resolves the filter lazily on the first
    // event by calling `getInputEntity()` on every entry, and any
    // single failure (URL form, transient FloodWait, anything) rejects
    // the resolve and leaves `builder.resolved=false`, so EVERY
    // subsequent event is dropped at the dispatcher. We now skip the
    // GramJS filter entirely and rely on our own allow-list check.
    const allowedChatIds = new Set();
    const rawTarget = String(targetId).trim();
    allowedChatIds.add(rawTarget);
    if (rawTarget.startsWith('@')) allowedChatIds.add(rawTarget.slice(1));
    // Strip any t.me/<x> URL form down to the bare username so the
    // self-warming match in _eventMatchesTarget can match on it.
    const urlMatch = rawTarget.match(/(?:t\.me|telegram\.me)\/(?:s\/)?(@?[\w_+]+)/i);
    if (urlMatch && urlMatch[1]) {
      const stripped = urlMatch[1].replace(/^@/, '');
      if (stripped) allowedChatIds.add(stripped);
    }

    const unsubs = new Map();
    for (const sid of sessionIds) {
      // Try to resolve the entity on this session and harvest every
      // numeric form of its id. Failures are non-fatal — when we miss
      // the entity here, _eventMatchesTarget will self-warm on the
      // first event whose chat we recognise.
      let resolved = null;
      try {
        resolved = await telegramService._resolveEntity(String(sid), rawTarget);
      } catch (err) {
        logger.debug(`Monitor job ${jobId} session ${sid} could not pre-resolve target: ${err.message}`);
      }
      if (resolved && resolved.id !== undefined && resolved.id !== null) {
        const idStr = bigToString(resolved.id);
        if (idStr) {
          allowedChatIds.add(idStr);
          // Bot-API form ("-100" prefix) for channels / supergroups,
          // because that's the chatId form NewMessage events carry.
          if (resolved.className === 'Channel' || resolved.className === 'ChannelForbidden') {
            allowedChatIds.add(`-100${idStr}`);
          } else if (resolved.className === 'Chat') {
            allowedChatIds.add(`-${idStr}`);
          }
        }
      }
      if (resolved && resolved.username) {
        allowedChatIds.add(String(resolved.username));
        allowedChatIds.add(`@${resolved.username}`);
      }

      // Attach the regular NewMessage handler. We deliberately do NOT
      // pass a `chats` filter — see comment above.
      try {
        const off = await telegramService.addNewMessageHandler(
          String(sid),
          (event) => this._onEvent(jobId, userId, sid, event),
        );
        unsubs.set(`nm:${sid}`, off);
      } catch (err) {
        logger.warn(`Monitor job ${jobId} could not attach NewMessage to session ${sid}: ${err.message}`);
      }

      // Also attach a Raw update handler so we can record interactions
      // beyond the regular text-message path: typing indicators,
      // reactions, channel-participant changes, and MessageService
      // events (joins / adds / leaves) that NewMessage's build() filter
      // rejects. Each of these counts as the user "performing an action"
      // in the chat, which is the user-facing contract for this job.
      try {
        const offRaw = await telegramService.addRawUpdateHandler(
          String(sid),
          (update) => this._onRawUpdate(jobId, userId, sid, update),
        );
        unsubs.set(`raw:${sid}`, offRaw);
      } catch (err) {
        logger.warn(`Monitor job ${jobId} could not attach Raw handler to session ${sid}: ${err.message}`);
      }
    }

    if (unsubs.size === 0) {
      // No sessions could attach; mark job as failed so the user notices.
      await pool.query(
        `UPDATE scrape_monitor_jobs
           SET status='failed', reason=$1, completed_at=NOW(), updated_at=NOW()
         WHERE id=$2`,
        ['no sessions could attach (all disconnected?)', jobId]
      );
      emit(userId, 'monitor:failed', { jobId });
      return;
    }

    const timer = setTimeout(
      () => this._finishJob(jobId, userId).catch((e) =>
        logger.error(`Monitor job ${jobId} finishJob error: ${e.message}`)
      ),
      remainingSeconds * 1000
    );

    // v8: periodic tick so the UI gets a steady "remaining" countdown
    // and per-window scrape rate even on quiet chats.
    let lastTickScraped = 0;
    const ticker = setInterval(async () => {
      try {
        const r = await pool.query(
          `SELECT scraped_count, events_observed, expires_at
             FROM scrape_monitor_jobs
            WHERE id = $1`,
          [jobId]
        );
        const row = r.rows[0];
        if (!row) return;
        const remaining = row.expires_at
          ? Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000))
          : 0;
        const scraped = row.scraped_count || 0;
        const delta = Math.max(0, scraped - lastTickScraped);
        lastTickScraped = scraped;
        emit(userId, 'monitor:tick', {
          jobId,
          scrapedCount: scraped,
          eventsObserved: row.events_observed || 0,
          remainingSeconds: remaining,
          // events / TICK_INTERVAL_MS, normalized to events/min for UI
          ratePerMinute: Math.round((delta / TICK_INTERVAL_MS) * 60_000),
        });
      } catch (err) {
        logger.debug(`monitor:tick ${jobId} error: ${err.message}`);
      }
    }, TICK_INTERVAL_MS);

    // Profile-enrichment context — see _enrichProfile().
    //   profileCache:   telegramId → enriched profile (positive cache)
    //   inflight:       Set<telegramId> currently being looked up
    //   queue:          Array<{ telegramId, sessionId }> waiting for a slot
    //   activeLookups:  current concurrent getEntity() calls
    //   sessionIds:     the sessions attached to this job, in attach order
    //                   (used as a round-robin fallback when the event-
    //                   originating session can't resolve the entity).
    const enrichCtx = {
      profileCache: new Map(),
      inflight: new Set(),
      queue: [],
      activeLookups: 0,
      sessionIds: sessionIds.map(String),
      participantCache: new Map(), // telegramId → User (prefetched)
    };
    this._active.set(jobId, {
      unsubs, timer, ticker, userId, lastEmitAt: 0,
      dedupEnabled,
      allowedChatIds,
      enrich: enrichCtx,
    });

    // Best-effort: prime the participant cache. For chats where the
    // session is an admin (or the chat is small enough that the
    // server returns the participant list), this gives us a hot
    // username/first_name/last_name/phone map keyed by telegram_id.
    // For admin-only / very large supergroups this is a no-op and we
    // fall back to per-event `client.getEntity()` lookups.
    this._primeParticipantCache(jobId, sessionIds, rawTarget).catch((err) =>
      logger.debug(`Monitor job ${jobId} participant prefetch error: ${err.message}`)
    );
  }

  /**
   * Best-effort prefetch of the target chat's participants — populates
   * `ctx.enrich.participantCache` so blank profiles surfaced from
   * typing / reactions / membership updates can be enriched without a
   * round-trip. Failures are silent.
   */
  async _primeParticipantCache(jobId, sessionIds, rawTarget) {
    const ctx = this._active.get(jobId);
    if (!ctx) return;
    for (const sid of sessionIds) {
      try {
        const sidStr = String(sid);
        const entity = await telegramService._resolveEntity(sidStr, rawTarget);
        if (!entity) continue;
        const client = telegramService.clients.get(sidStr)?.client;
        if (!client) continue;
        // iterParticipants is async-iter. Cap to 5k to keep us bounded
        // for very large groups; admin-only roster fetch will throw
        // (CHAT_ADMIN_REQUIRED) and we just bail.
        let count = 0;
        try {
          for await (const u of client.iterParticipants(entity, { limit: 5000 })) {
            if (!u || u.className !== 'User' || u.id === undefined) continue;
            const id = bigToString(u.id);
            if (id && !ctx.enrich.participantCache.has(id)) {
              ctx.enrich.participantCache.set(id, u);
            }
            count += 1;
          }
        } catch (innerErr) {
          logger.debug(`Monitor job ${jobId} session ${sid} iterParticipants stopped: ${innerErr.message}`);
        }
        if (count > 0) {
          logger.debug(`Monitor job ${jobId} primed ${count} participants from session ${sid}`);
          // First successful prefetch is enough.
          return;
        }
      } catch (err) {
        logger.debug(`Monitor job ${jobId} prefetch via session ${sid} failed: ${err.message}`);
      }
    }
  }

  /**
   * Inline (synchronous) enrichment from in-memory caches only — no
   * network. Mutates the profile in-place. Used to fill in fields on
   * the FIRST observation of a given telegram_id whenever we already
   * have the User entity hot. Returns true when the profile was
   * actually upgraded.
   */
  _enrichInline(jobId, profile, piggybacked) {
    if (!profile || !profile.telegramId || !isProfileBlank(profile)) return false;
    const ctx = this._active.get(jobId);
    if (!ctx || !ctx.enrich) return false;
    const ec = ctx.enrich;

    // 1. Cached enriched profile from a previous lookup.
    const cached = ec.profileCache.get(profile.telegramId);
    if (cached) {
      profile.username = cached.username || profile.username;
      profile.firstName = cached.firstName || profile.firstName;
      profile.lastName = cached.lastName || profile.lastName;
      profile.phone = cached.phone || profile.phone;
      profile.isBot = !!(cached.isBot || profile.isBot);
      profile.isPremium = !!(cached.isPremium || profile.isPremium);
      return !isProfileBlank(profile);
    }

    // 2. Piggybacked User entity on the originating event/update.
    if (piggybacked && piggybacked[profile.telegramId]) {
      applySenderEntity(profile, piggybacked[profile.telegramId]);
      if (!isProfileBlank(profile)) {
        ec.profileCache.set(profile.telegramId, { ...profile });
        return true;
      }
    }

    // 3. Pre-fetched participant cache.
    const participant = ec.participantCache.get(profile.telegramId);
    if (participant) {
      applySenderEntity(profile, participant);
      if (!isProfileBlank(profile)) {
        ec.profileCache.set(profile.telegramId, { ...profile });
        return true;
      }
    }
    return false;
  }

  /**
   * Background enrichment. Looks up the user via
   * `client.getEntity(telegramId)` on any of the job's attached
   * sessions, then back-fills every existing `scrape_monitor_users`
   * row for this job that's missing the basic fields. Concurrency-
   * limited so a chat with thousands of unique typers can't hammer
   * Telegram.
   *
   * The back-fill UPDATE works for both dedup-on (one row per user)
   * and dedup-off (many rows per user) jobs.
   */
  async _enrichProfile(jobId, userId, sessionId, telegramId) {
    if (!telegramId) return;
    const ctx = this._active.get(jobId);
    if (!ctx || !ctx.enrich) return;
    const ec = ctx.enrich;

    if (ec.profileCache.has(telegramId)) return;
    if (ec.inflight.has(telegramId)) return;

    const MAX_CONCURRENT_LOOKUPS = 2;
    const QUEUE_CAP = 1000;

    const runLookup = async () => {
      ec.inflight.add(telegramId);
      ec.activeLookups += 1;
      try {
        // Try originating session first, then every other attached
        // session. Cold IDs without an access_hash will fail on
        // most sessions; but any session that's seen the user in
        // any cached dialog will resolve.
        const order = [String(sessionId), ...ec.sessionIds.filter((s) => s !== String(sessionId))];
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
            logger.debug(`Monitor job ${jobId} enrich ${telegramId} via ${sid}: ${err.message}`);
          }
        }
        if (!entity) return;

        const enriched = blankProfile(telegramId);
        applySenderEntity(enriched, entity);
        if (isProfileBlank(enriched)) return;

        ec.profileCache.set(telegramId, enriched);

        // Back-fill EVERY scrape_monitor_users row for this job
        // that matches this telegram_id and is missing fields.
        // COALESCE preserves any value already in the row, but the
        // boolean flag-or'ing latches a flag once any source has
        // observed it as true.
        await pool.query(
          `UPDATE scrape_monitor_users
              SET username           = COALESCE(username,           $3),
                  first_name         = COALESCE(first_name,         $4),
                  last_name          = COALESCE(last_name,          $5),
                  phone              = COALESCE(phone,              $6),
                  is_bot             = is_bot OR $7,
                  is_premium         = is_premium OR $8,
                  is_verified        = is_verified OR $9,
                  is_scam            = is_scam OR $10,
                  is_fake            = is_fake OR $11,
                  is_restricted      = is_restricted OR $12,
                  is_deleted         = is_deleted OR $13,
                  is_support         = is_support OR $14,
                  is_contact         = is_contact OR $15,
                  is_mutual_contact  = is_mutual_contact OR $16,
                  is_close_friend    = is_close_friend OR $17,
                  lang_code          = COALESCE(lang_code,          $18),
                  status             = COALESCE(status,             $19),
                  access_hash        = COALESCE(access_hash,        $20),
                  has_profile_photo  = has_profile_photo OR $21,
                  dc_id              = COALESCE(dc_id,              $22),
                  restriction_reason = COALESCE(restriction_reason, $23)
            WHERE monitor_job_id = $1
              AND telegram_id = $2`,
          [
            jobId, telegramId,
            enriched.username, enriched.firstName,
            enriched.lastName, enriched.phone,
            !!enriched.isBot, !!enriched.isPremium,
            !!enriched.isVerified, !!enriched.isScam, !!enriched.isFake,
            !!enriched.isRestricted, !!enriched.isDeleted, !!enriched.isSupport,
            !!enriched.isContact, !!enriched.isMutualContact, !!enriched.isCloseFriend,
            enriched.langCode, enriched.status,
            enriched.accessHash != null ? String(enriched.accessHash) : null,
            !!enriched.hasProfilePhoto,
            enriched.dcId != null ? Number(enriched.dcId) : null,
            enriched.restrictionReason || null,
          ]
        );
        // Tell the UI a known user got fleshed out — useful for the
        // monitor table to refresh in place.
        emit(userId, 'monitor:user-enriched', {
          jobId,
          telegramId,
          username: enriched.username,
          firstName: enriched.firstName,
          lastName: enriched.lastName,
        });
      } finally {
        ec.activeLookups -= 1;
        ec.inflight.delete(telegramId);
        const next = ec.queue.shift();
        if (next) {
          setImmediate(() =>
            this._enrichProfile(jobId, userId, next.sessionId, next.telegramId)
              .catch((err) => logger.debug(`enrich queue drain: ${err.message}`))
          );
        }
      }
    };

    if (ec.activeLookups >= MAX_CONCURRENT_LOOKUPS) {
      // Queued — drained when the next active lookup finishes.
      ec.queue.push({ telegramId, sessionId });
      if (ec.queue.length > QUEUE_CAP) {
        ec.queue.splice(0, ec.queue.length - QUEUE_CAP);
      }
      return;
    }
    runLookup().catch((err) =>
      logger.debug(`Monitor job ${jobId} runLookup ${telegramId}: ${err.message}`)
    );
  }

  async _detach(jobId) {
    const ctx = this._active.get(jobId);
    if (!ctx) return;
    try { clearTimeout(ctx.timer); } catch { /* ignore */ }
    try { clearInterval(ctx.ticker); } catch { /* ignore */ }
    for (const off of ctx.unsubs.values()) {
      try { off(); } catch { /* ignore */ }
    }
    this._active.delete(jobId);
  }

  async _finishJob(jobId, userId) {
    await this._detach(jobId);
    await pool.query(
      `UPDATE scrape_monitor_jobs
         SET status='completed', completed_at=NOW(), updated_at=NOW(),
             remaining_seconds = 0
       WHERE id=$1 AND status NOT IN ('cancelled','failed','completed')`,
      [jobId]
    );
    emit(userId, 'monitor:completed', { jobId });
  }

  /**
   * Collect every chat-id form carried by a GramJS event/update, returned
   * as an array of strings. Used by `_eventMatchesTarget` and the Raw
   * update path. Defensively handles BigInts (`.value`) and plain
   * numbers/strings.
   */
  _eventChatCandidates(eventOrUpdate) {
    const candidates = [];
    const seen = new Set();
    const push = (v) => {
      if (v === null || v === undefined) return;
      const s = bigToString(v);
      if (!s || seen.has(s)) return;
      seen.add(s);
      candidates.push(s);
    };

    const msg = eventOrUpdate?.message || eventOrUpdate;
    push(eventOrUpdate?.chatId);
    push(eventOrUpdate?.channelId);
    if (msg && msg !== eventOrUpdate) {
      push(msg.chatId);
    }
    const peerSrc = msg?.peerId || eventOrUpdate?.peer;
    if (peerSrc) {
      push(peerSrc.channelId);
      push(peerSrc.chatId);
      push(peerSrc.userId);
    }
    // _chat cached by GramJS for NewMessage events.
    const cachedChat = eventOrUpdate?._chat || msg?._chat;
    if (cachedChat) {
      push(cachedChat.id);
      if (cachedChat.username) push(cachedChat.username);
    }
    return candidates;
  }

  /**
   * Defense-in-depth chat filter. GramJS's NewMessage `chats` filter is
   * fragile (see comments in `_attach`) so we do our own match against
   * the allow list. As a side effect, the first time we recognise a
   * chat by one form (e.g. via the cached `_chat.username`) we add the
   * other forms (raw id, `-100` form) into the allow list, so matching
   * speeds up for subsequent events even if pre-resolve never ran.
   */
  _eventMatchesTarget(eventOrUpdate, allowedChatIds) {
    if (!allowedChatIds || allowedChatIds.size === 0) return true;
    const candidates = this._eventChatCandidates(eventOrUpdate);

    let matchedCandidate = null;
    for (const c of candidates) {
      if (allowedChatIds.has(c)) { matchedCandidate = c; break; }
      if (allowedChatIds.has(`-${c}`)) { matchedCandidate = c; break; }
      if (allowedChatIds.has(`-100${c}`)) { matchedCandidate = c; break; }
      if (c.startsWith('-100') && allowedChatIds.has(c.slice(4))) {
        matchedCandidate = c; break;
      }
      if (c.startsWith('-') && allowedChatIds.has(c.slice(1))) {
        matchedCandidate = c; break;
      }
    }
    if (!matchedCandidate) return false;

    // Self-warm: we just saw the chat for the first time. Adding all
    // candidate forms to the allow list lets future events match in
    // O(1) without re-running the prefix logic.
    for (const c of candidates) {
      allowedChatIds.add(c);
      if (c.startsWith('-100')) allowedChatIds.add(c.slice(4));
      else if (/^\d+$/.test(c)) allowedChatIds.add(`-100${c}`);
    }
    return true;
  }

  /**
   * Insert / update a single observation into the database. Shared by
   * the NewMessage and Raw event paths. The `kind` param is purely for
   * logging.
   */
  async _recordProfile(jobId, userId, sessionId, profile, kind = 'message') {
    if (!profile || !profile.telegramId) return;
    const ctx = this._active.get(jobId);
    const dedupEnabled = ctx ? ctx.dedupEnabled !== false : true;

    // Every accepted observation contributes to events_observed so the
    // operator can compare "events heard" vs "distinct users recorded".
    await pool.query(
      `UPDATE scrape_monitor_jobs
          SET events_observed = events_observed + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [jobId]
    );

    let inserted = false;
    if (dedupEnabled) {
      const existing = await pool.query(
        `SELECT id FROM scrape_monitor_users
          WHERE monitor_job_id = $1 AND telegram_id = $2
          LIMIT 1`,
        [jobId, profile.telegramId]
      );
      if (existing.rows[0]) {
        await pool.query(
          `UPDATE scrape_monitor_users
              SET message_count    = message_count + 1,
                  last_seen_at     = NOW(),
                  username         = COALESCE($3, username),
                  first_name       = COALESCE($4, first_name),
                  last_name        = COALESCE($5, last_name),
                  phone            = COALESCE($6, phone),
                  is_premium       = is_premium OR $7,
                  is_bot           = is_bot OR $8,
                  is_verified      = is_verified OR $9,
                  is_scam          = is_scam OR $10,
                  is_fake          = is_fake OR $11,
                  is_restricted    = is_restricted OR $12,
                  is_deleted       = is_deleted OR $13,
                  is_support       = is_support OR $14,
                  is_contact       = is_contact OR $15,
                  is_mutual_contact = is_mutual_contact OR $16,
                  is_close_friend  = is_close_friend OR $17,
                  lang_code        = COALESCE($18, lang_code),
                  status           = COALESCE($19, status),
                  access_hash      = COALESCE($20, access_hash),
                  has_profile_photo = has_profile_photo OR $21,
                  dc_id            = COALESCE($22, dc_id),
                  restriction_reason = COALESCE($23, restriction_reason)
            WHERE id = $1 AND monitor_job_id = $2`,
          [
            existing.rows[0].id, jobId, profile.username,
            profile.firstName, profile.lastName, profile.phone,
            !!profile.isPremium, !!profile.isBot,
            !!profile.isVerified, !!profile.isScam, !!profile.isFake,
            !!profile.isRestricted, !!profile.isDeleted, !!profile.isSupport,
            !!profile.isContact, !!profile.isMutualContact, !!profile.isCloseFriend,
            profile.langCode, profile.status,
            profile.accessHash != null ? String(profile.accessHash) : null,
            !!profile.hasProfilePhoto,
            profile.dcId != null ? Number(profile.dcId) : null,
            profile.restrictionReason || null,
          ]
        );
        inserted = false;
      } else {
        await pool.query(
          `INSERT INTO scrape_monitor_users
             (monitor_job_id, telegram_id, username, first_name, last_name,
              phone, is_bot, is_premium, message_count,
              first_seen_at, last_seen_at, via_session_id,
              is_verified, is_scam, is_fake, is_restricted, is_deleted,
              is_support, is_contact, is_mutual_contact, is_close_friend,
              lang_code, status, access_hash, has_profile_photo, dc_id,
              restriction_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, NOW(), NOW(), $9,
                   $10, $11, $12, $13, $14, $15, $16, $17, $18,
                   $19, $20, $21, $22, $23, $24)`,
          [
            jobId, profile.telegramId, profile.username,
            profile.firstName, profile.lastName, profile.phone,
            !!profile.isBot, !!profile.isPremium, sessionId,
            !!profile.isVerified, !!profile.isScam, !!profile.isFake,
            !!profile.isRestricted, !!profile.isDeleted, !!profile.isSupport,
            !!profile.isContact, !!profile.isMutualContact, !!profile.isCloseFriend,
            profile.langCode, profile.status,
            profile.accessHash != null ? String(profile.accessHash) : null,
            !!profile.hasProfilePhoto,
            profile.dcId != null ? Number(profile.dcId) : null,
            profile.restrictionReason || null,
          ]
        );
        inserted = true;
      }
    } else {
      // dedup OFF: every observation is its own row, even from the same
      // user. The user explicitly opted in to a raw activity log, so
      // we MUST NOT skip anything here.
      await pool.query(
        `INSERT INTO scrape_monitor_users
           (monitor_job_id, telegram_id, username, first_name, last_name,
            phone, is_bot, is_premium, message_count,
            first_seen_at, last_seen_at, via_session_id,
            is_verified, is_scam, is_fake, is_restricted, is_deleted,
            is_support, is_contact, is_mutual_contact, is_close_friend,
            lang_code, status, access_hash, has_profile_photo, dc_id,
            restriction_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, NOW(), NOW(), $9,
                 $10, $11, $12, $13, $14, $15, $16, $17, $18,
                 $19, $20, $21, $22, $23, $24)`,
        [
          jobId, profile.telegramId, profile.username,
          profile.firstName, profile.lastName, profile.phone,
          !!profile.isBot, !!profile.isPremium, sessionId,
          !!profile.isVerified, !!profile.isScam, !!profile.isFake,
          !!profile.isRestricted, !!profile.isDeleted, !!profile.isSupport,
          !!profile.isContact, !!profile.isMutualContact, !!profile.isCloseFriend,
          profile.langCode, profile.status,
          profile.accessHash != null ? String(profile.accessHash) : null,
          !!profile.hasProfilePhoto,
          profile.dcId != null ? Number(profile.dcId) : null,
          profile.restrictionReason || null,
        ]
      );
      inserted = true;
    }

    if (inserted) {
      await pool.query(
        `UPDATE scrape_monitor_jobs SET scraped_count = scraped_count + 1, updated_at=NOW() WHERE id=$1`,
        [jobId]
      );
    }

    // Debounced WS emit so a flood of messages doesn't drown the channel.
    const now = Date.now();
    if (ctx && (now - ctx.lastEmitAt) >= PROGRESS_EMIT_DEBOUNCE_MS) {
      ctx.lastEmitAt = now;
      const r = await pool.query(
        `SELECT scraped_count, events_observed FROM scrape_monitor_jobs WHERE id=$1`, [jobId]
      );
      emit(userId, 'monitor:progress', {
        jobId,
        scrapedCount: r.rows[0]?.scraped_count || 0,
        eventsObserved: r.rows[0]?.events_observed || 0,
        newUser: inserted ? {
          telegramId: String(profile.telegramId),
          username: profile.username,
          firstName: profile.firstName,
          lastName: profile.lastName,
          source: kind,
        } : null,
      });
    }
  }

  async _onEvent(jobId, userId, sessionId, event) {
    try {
      const ctx = this._active.get(jobId);
      if (!ctx) return;
      const allowed = ctx.allowedChatIds;

      if (allowed && allowed.size > 0 && !this._eventMatchesTarget(event, allowed)) {
        // Cross-talk from a different chat the session is also in.
        return;
      }

      const profile = await extractSenderProfile(event);
      if (!profile) return;

      // Inline enrichment from hot caches (free, no network).
      const piggy = harvestPiggybackedUsers(event);
      this._enrichInline(jobId, profile, piggy);

      await this._recordProfile(jobId, userId, sessionId, profile, 'message');

      // Still bare? Schedule a background lookup that back-fills the
      // row(s) once the entity resolves. Works for dedup on/off.
      if (isProfileBlank(profile)) {
        this._enrichProfile(jobId, userId, sessionId, profile.telegramId)
          .catch((err) => logger.debug(`enrich after _onEvent: ${err.message}`));
      }
    } catch (err) {
      logger.warn(`Monitor job ${jobId} event error: ${err.message}`);
    }
  }

  /**
   * Raw GramJS update handler. Captures interactions that NewMessage
   * misses: typing indicators, reactions, channel-participant changes,
   * and MessageService events.
   *
   * To avoid double-counting, regular Api.Message updates inside
   * UpdateNewMessage / UpdateNewChannelMessage are SKIPPED here — the
   * NewMessage handler already credited them.
   */
  async _onRawUpdate(jobId, userId, sessionId, update) {
    try {
      if (!update || !update.className) return;
      if (!RAW_UPDATE_CLASSNAMES.has(update.className)) return;

      const ctx = this._active.get(jobId);
      if (!ctx) return;
      const allowed = ctx.allowedChatIds;

      // Special-case: UpdateNew*Message — extract `update.message` and
      // delegate. NewMessage already handled Api.Message; we only act
      // on Api.MessageService here.
      if (
        update.className === 'UpdateNewMessage'
        || update.className === 'UpdateNewChannelMessage'
      ) {
        const m = update.message;
        if (!m) return;
        if (m.className !== 'MessageService') {
          // Regular Api.Message — already handled by NewMessage.
          return;
        }
        // Filter by chat using a synthetic event-like object.
        if (allowed && allowed.size > 0
            && !this._eventMatchesTarget({ message: m }, allowed)) {
          return;
        }
        const profile = await extractSenderProfile({ message: m });
        if (!profile) return;
        const piggyMsg = harvestPiggybackedUsers(update);
        this._enrichInline(jobId, profile, piggyMsg);
        await this._recordProfile(jobId, userId, sessionId, profile, 'service');
        if (isProfileBlank(profile)) {
          this._enrichProfile(jobId, userId, sessionId, profile.telegramId)
            .catch((err) => logger.debug(`enrich after service msg: ${err.message}`));
        }
        return;
      }

      // For everything else (typing, reactions, participant changes)
      // the chat-id forms live on the update itself.
      if (allowed && allowed.size > 0
          && !this._eventMatchesTarget(update, allowed)) {
        return;
      }

      const profile = extractSenderFromRawUpdate(update);
      if (!profile) return;

      let kind = 'raw';
      if (update.className.includes('Typing')) kind = 'typing';
      else if (update.className.includes('Reaction')) kind = 'reaction';
      else if (update.className.includes('Participant')) kind = 'membership';

      // Inline enrichment from hot caches first.
      const piggy = harvestPiggybackedUsers(update);
      this._enrichInline(jobId, profile, piggy);

      await this._recordProfile(jobId, userId, sessionId, profile, kind);

      // Raw updates almost never carry the originating User object —
      // schedule a background lookup that back-fills past + future
      // rows for this user via UPDATE.
      if (isProfileBlank(profile)) {
        this._enrichProfile(jobId, userId, sessionId, profile.telegramId)
          .catch((err) => logger.debug(`enrich after raw update: ${err.message}`));
      }
    } catch (err) {
      logger.warn(`Monitor job ${jobId} raw update error: ${err.message}`);
    }
  }

  _toPublic(row) {
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      sessionIds: row.session_ids || [],
      targetId: row.target_id,
      targetType: row.target_type,
      targetTitle: row.target_title,
      status: row.status,
      durationSeconds: row.duration_seconds,
      remainingSeconds: row.remaining_seconds,
      scrapedCount: row.scraped_count,
      eventsObserved: row.events_observed || 0,
      dedupEnabled: row.dedup_enabled !== false,
      reason: row.reason,
      options: row.options || {},
      startedAt: row.started_at,
      pausedAt: row.paused_at,
      expiresAt: row.expires_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      schedulerVersion: row.scheduler_version || 'legacy',
      chatCount: row.chat_count || 1,
    };
  }
}

const _singleton = new ScrapeMonitorService();

// V2 monitor (services/monitor/*) reuses the helpers from this module
// rather than forking them.  Exposed deliberately and explicitly so
// the coupling shows up in grep.
_singleton.__internals = {
  RAW_UPDATE_CLASSNAMES,
  extractSenderProfile,
  extractSenderFromRawUpdate,
  harvestPiggybackedUsers,
  bigToString,
  extractUserIdFromPeer,
  applySenderEntity,
  blankProfile,
  isProfileBlank,
  // Event matching uses an allowlist Set; we expose a static version
  // so the V2 listenerWorker can reuse it without an instance method.
  eventChatCandidates: (eventOrUpdate) =>
    _singleton._eventChatCandidates(eventOrUpdate),
  eventMatchesTarget: (eventOrUpdate, allowedChatIds) =>
    _singleton._eventMatchesTarget(eventOrUpdate, allowedChatIds),
};

module.exports = _singleton;
