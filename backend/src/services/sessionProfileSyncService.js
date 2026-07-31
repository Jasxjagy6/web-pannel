/**
 * sessionProfileSyncService — refresh the LIVE Telegram profile of
 * logged-in sessions and fan the fresh values out across the whole panel.
 *
 * Why this exists
 * ---------------
 * A session's display details (first name, last name, username, bio,
 * premium/verified flags, avatar) are captured once at upload/login time
 * and stored in `sessions.account_info` (+ the `sessions.username`
 * column). Everything else in the panel that shows "who is this session"
 * reads from there:
 *
 *   - AI Chat + AI Chat Tracking  (aiChatService: account_info->>'firstName')
 *   - Reply tracking              (replyTrackingService: account_info->>'firstName')
 *   - Sessions list / dashboards  (sessionService: account_info)
 *   - Tracking / CRM panel        (tracking_accounts, via trackingTelegramSyncService)
 *
 * So if an operator renames an account on Telegram, the panel keeps
 * showing the stale name until the session is re-logged-in. This service
 * pulls the current profile straight from Telegram (getMe + getFullUser)
 * and rewrites `sessions.account_info` / `sessions.username` in place.
 * Because those columns are the single source every other surface reads
 * from, the new details show up everywhere at once — no per-feature
 * backfill needed. It ALSO calls the existing tracking sync so the CRM
 * side (which keeps its own denormalised copy) is refreshed in the same
 * pass.
 *
 * Read-only against Telegram — it never writes to the account.
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const tcService = require('./telegramClientService');
const trackingTelegramSyncService = require('./trackingTelegramSyncService');

/**
 * Merge the freshly-fetched live profile into a session's existing
 * account_info blob (preserving unrelated keys like sessionType,
 * uploadedFrom, loginSuccess, …) and write it back, along with the
 * top-level `username` column.
 *
 * @param {object} sessionRow - { id, user_id, account_info, username }
 * @param {object} profile - shape returned by tcService.getSelfProfile
 * @returns {Promise<{ changed: boolean, before: object, after: object }>}
 * @private
 */
async function _persistSessionProfile(sessionRow, profile) {
  const prev =
    (sessionRow.account_info && typeof sessionRow.account_info === 'object')
      ? sessionRow.account_info
      : {};

  const nextUsername = profile.username || null;

  const merged = {
    ...prev,
    telegramId: profile.id != null ? Number(profile.id) : (prev.telegramId ?? null),
    firstName: profile.firstName || '',
    lastName: profile.lastName || '',
    username: nextUsername,
    bio: profile.bio || '',
    isPremium: !!profile.isPremium,
    isVerified: !!profile.isVerified,
    isScam: !!profile.isScam,
    isFake: !!profile.isFake,
    langCode: profile.langCode || prev.langCode || null,
    phone: profile.phone || prev.phone || null,
    profileSyncedAt: new Date().toISOString(),
  };

  // Detect whether the human-facing details actually changed so callers
  // can report "N updated" meaningfully.
  const changed =
    (prev.firstName || '') !== merged.firstName ||
    (prev.lastName || '') !== merged.lastName ||
    (prev.username || null) !== merged.username ||
    (prev.bio || '') !== merged.bio ||
    (!!prev.isPremium) !== merged.isPremium ||
    (!!prev.isVerified) !== merged.isVerified ||
    (sessionRow.username || null) !== merged.username;

  await pool.query(
    `UPDATE sessions
        SET account_info = $1,
            username = $2,
            updated_at = NOW()
      WHERE id = $3`,
    [JSON.stringify(merged), nextUsername, sessionRow.id]
  );

  return { changed, before: prev, after: merged };
}

const sessionProfileSyncService = {
  /**
   * Refresh one session's live profile and fan it out.
   *
   * @param {number|string} sessionId
   * @param {number|string} userId - ownership guard (session must belong to user)
   * @param {object} [opts]
   * @param {boolean} [opts.syncTracking=true] - also refresh the CRM/tracking copy
   * @returns {Promise<{
   *   sessionId: number, ok: boolean, changed: boolean, reason?: string,
   *   profile?: { firstName, lastName, username, bio, isPremium, isVerified }
   * }>}
   */
  async syncSession(sessionId, userId, opts = {}) {
    const sid = Number(sessionId);
    const syncTracking = opts.syncTracking !== false;

    const { rows } = await pool.query(
      `SELECT id, user_id, phone, username, account_info, is_logged_in, platform,
              COALESCE(spam_status, 'unknown') AS spam_status
         FROM sessions
        WHERE id = $1 AND user_id = $2`,
      [sid, userId]
    );
    const session = rows[0];
    if (!session) {
      return { sessionId: sid, ok: false, changed: false, reason: 'not_found' };
    }
    if (session.platform && session.platform !== 'telegram') {
      return { sessionId: sid, ok: false, changed: false, reason: 'not_telegram' };
    }
    if (!session.is_logged_in) {
      return { sessionId: sid, ok: false, changed: false, reason: 'not_logged_in' };
    }
    if (session.spam_status === 'frozen') {
      return { sessionId: sid, ok: false, changed: false, reason: 'frozen' };
    }

    // Pull the CURRENT profile from Telegram (getMe + getFullUser for bio).
    let profile;
    try {
      profile = await tcService.getSelfProfile(sid, session.user_id);
    } catch (err) {
      logger.warn(`profileSync: getSelfProfile failed for session ${sid}: ${err.message}`);
      return { sessionId: sid, ok: false, changed: false, reason: `fetch_failed: ${err.message}` };
    }

    const { changed } = await _persistSessionProfile(session, profile);

    // Fan out to the tracking / CRM panel, which keeps its own copy of the
    // profile (display_name, username, bio, avatar, …). Best-effort — a
    // tracking failure must not fail the session refresh.
    if (syncTracking) {
      try {
        await trackingTelegramSyncService.syncFromSession(sid, { actorUserId: userId });
      } catch (err) {
        logger.warn(`profileSync: tracking sync failed for session ${sid}: ${err.message}`);
      }
    }

    logger.info(
      `profileSync: session ${sid} refreshed (changed=${changed}) → ` +
      `${[profile.firstName, profile.lastName].filter(Boolean).join(' ')}` +
      `${profile.username ? ' @' + profile.username : ''}`
    );

    return {
      sessionId: sid,
      ok: true,
      changed,
      profile: {
        firstName: profile.firstName || '',
        lastName: profile.lastName || '',
        username: profile.username || null,
        bio: profile.bio || '',
        isPremium: !!profile.isPremium,
        isVerified: !!profile.isVerified,
      },
    };
  },

  /**
   * Refresh every logged-in Telegram session owned by the user.
   *
   * Sequential to avoid hammering Telegram (each does a getMe +
   * getFullUser round-trip). Returns a per-session breakdown plus totals
   * the UI can surface in a toast.
   *
   * @param {number|string} userId
   * @param {object} [opts]
   * @param {boolean} [opts.syncTracking=true]
   * @param {number} [opts.limit=500]
   * @returns {Promise<{
   *   total:number, synced:number, updated:number, failed:number,
   *   results: Array<object>
   * }>}
   */
  async syncAllForUser(userId, opts = {}) {
    const limit = Math.max(1, Math.min(1000, parseInt(opts.limit, 10) || 500));
    const { rows } = await pool.query(
      `SELECT id
         FROM sessions
        WHERE user_id = $1
           AND is_logged_in = TRUE
           AND (platform = 'telegram' OR platform IS NULL)
           AND COALESCE(spam_status, 'unknown') <> 'frozen'
        ORDER BY id
        LIMIT $2`,
      [userId, limit]
    );

    const results = [];
    let synced = 0;
    let updated = 0;
    let failed = 0;

    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      const res = await this.syncSession(row.id, userId, opts);
      results.push(res);
      if (res.ok) {
        synced++;
        if (res.changed) updated++;
      } else {
        failed++;
      }
    }

    logger.info(
      `profileSync: syncAllForUser user=${userId} total=${rows.length} ` +
      `synced=${synced} updated=${updated} failed=${failed}`
    );

    return { total: rows.length, synced, updated, failed, results };
  },
};

module.exports = sessionProfileSyncService;
