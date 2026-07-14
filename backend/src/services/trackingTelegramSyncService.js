/**
 * trackingTelegramSyncService — pulls a COMPLETE snapshot of a logged-in
 * Telegram session into the Tracking panel: profile, avatar, bio, privacy
 * settings, live 2FA state, and the full list of active logins/devices.
 *
 * The snapshot is stored on the tracking side and PERSISTS after the
 * session is later logged out or deleted (source_session_id goes NULL via
 * ON DELETE SET NULL; the tracking row + all synced data stay).
 *
 * All the Telegram reads already exist on telegramClientService and are
 * ownership-checked, so this service is pure orchestration. It never
 * writes to the Telegram account — read-only.
 *
 * NOTE: Telegram's API does not return the plaintext 2FA password or full
 * recovery email for a logged-in session — only a hint + masked pattern.
 * Those masked values are stored here; plaintext stays in
 * tracking_account_security (from the session-info JSON / manual entry).
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const tcService = require('./telegramClientService');
const trackingAccountService = require('./trackingAccountService');
const trackingTelegramMetaService = require('./trackingTelegramMetaService');
const trackingLoginsService = require('./trackingLoginsService');

// Privacy keys we snapshot (must be supported by telegramClientService's
// _privacyInputKey map) → human-friendly label used by the UI.
const PRIVACY_KEYS = [
  'statusTimestamp', 'phoneNumber', 'profilePhoto', 'forwards',
  'phoneCall', 'phoneP2P', 'chatInvite', 'voiceMessages', 'addedByPhone', 'birthday',
];

const MAX_AVATAR_BYTES = 300 * 1024; // don't store absurd avatars in a data URI

/**
 * Reduce a set of Telegram privacy rules to a single display label.
 * Rules arrive as [{ type: 'PrivacyValueAllowAll' | ... }].
 */
function summarizePrivacy(rules) {
  const types = (rules || []).map((r) => r.type || r.className || '');
  if (types.some((t) => t.includes('AllowAll'))) return 'everybody';
  if (types.some((t) => t.includes('AllowCloseFriends'))) return 'close_friends';
  if (types.some((t) => t.includes('AllowContacts'))) return 'contacts';
  if (types.some((t) => t.includes('AllowPremium'))) return 'premium';
  if (types.some((t) => t.includes('DisallowAll'))) return 'nobody';
  if (types.length) return 'custom';
  return 'unknown';
}

async function getSessionRow(sessionId) {
  const { rows } = await pool.query(
    'SELECT id, user_id, phone, username, account_info, is_logged_in, platform FROM sessions WHERE id = $1',
    [sessionId]
  );
  return rows[0] || null;
}

async function findTrackingAccountId(sessionId, telegramUserId, phone) {
  // 1. Already linked to this session.
  let r = await pool.query(
    'SELECT id FROM tracking_accounts WHERE source_session_id = $1 AND is_deleted = FALSE LIMIT 1',
    [sessionId]
  );
  if (r.rows[0]) return r.rows[0].id;
  // 2. Same Telegram user id.
  if (telegramUserId) {
    r = await pool.query(
      'SELECT id FROM tracking_accounts WHERE telegram_user_id = $1 AND is_deleted = FALSE ORDER BY id LIMIT 1',
      [telegramUserId]
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  // 3. Same phone number.
  if (phone) {
    const normalized = String(phone).replace(/[^0-9]/g, '');
    r = await pool.query(
      "SELECT id FROM tracking_accounts WHERE regexp_replace(COALESCE(phone_number,''), '[^0-9]', '', 'g') = $1 AND is_deleted = FALSE ORDER BY id LIMIT 1",
      [normalized]
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  return null;
}

const trackingTelegramSyncService = {
  /**
   * Fetch a full snapshot from a logged-in session and upsert it into the
   * tracking tables. Returns the synced tracking account detail, or null
   * if the session isn't a live/loggable Telegram session.
   *
   * Each Telegram read is best-effort: a failure on one (rate limit, etc.)
   * is logged and skipped so the rest of the snapshot still persists.
   */
  async syncFromSession(sessionId, { actorUserId } = {}) {
    const session = await getSessionRow(sessionId);
    if (!session) {
      logger.warn(`trackingSync: session ${sessionId} not found`);
      return null;
    }
    if (session.platform && session.platform !== 'telegram') {
      // Instagram sessions use a different client; not syncable here.
      return null;
    }
    const ownerId = session.user_id; // telegramClientService auth-checks by session owner
    const createdBy = actorUserId || ownerId;

    // --- 1. Profile (names, username, phone, bio, premium/verified/...) ---
    let profile = null;
    try {
      profile = await tcService.getSelfProfile(sessionId, ownerId);
    } catch (err) {
      logger.warn(`trackingSync: getSelfProfile failed for session ${sessionId}: ${err.message}`);
    }

    const ai = session.account_info || {};
    const telegramUserId = profile?.id ? Number(profile.id)
      : (ai.telegramId ? Number(ai.telegramId) : null);
    const phone = profile?.phone || session.phone || ai.phone || null;
    const username = profile?.username || session.username || ai.username || null;
    const displayName = [profile?.firstName ?? ai.firstName, profile?.lastName ?? ai.lastName]
      .filter(Boolean).join(' ').trim() || null;

    // --- 2. Resolve or create the tracking account ---
    let accountId = await findTrackingAccountId(sessionId, telegramUserId, phone);
    if (!accountId) {
      const created = await trackingAccountService.createAccount(createdBy, {
        phoneNumber: phone || undefined,
        telegramUserId: telegramUserId || undefined,
        username: username || undefined,
        displayName: displayName || undefined,
        bio: profile?.bio || undefined,
        isPremium: profile?.isPremium ?? undefined,
        isVerified: profile?.isVerified ?? undefined,
        isScam: profile?.isScam ?? undefined,
        isFake: profile?.isFake ?? undefined,
      });
      accountId = created.id;
    }

    // --- 3. Avatar (small) → data URI ---
    let avatarDataUri;
    try {
      if (telegramUserId && profile?.hasPhoto !== false) {
        const buf = await tcService.downloadProfilePhoto(sessionId, ownerId, 'user', String(telegramUserId), { large: false });
        if (buf && buf.length && buf.length <= MAX_AVATAR_BYTES) {
          avatarDataUri = `data:image/jpeg;base64,${buf.toString('base64')}`;
        }
      }
    } catch (err) {
      logger.warn(`trackingSync: avatar download failed for session ${sessionId}: ${err.message}`);
    }

    // --- 4. Update the core account row (basic profile + link + avatar) ---
    const sets = [
      'source_session_id = $1',
      'is_session_linked = TRUE',
      'session_synced_at = NOW()',
      'updated_by = $2',
      'updated_at = NOW()',
    ];
    const vals = [sessionId, createdBy];
    let p = 3;
    const setIf = (col, value) => {
      if (value !== undefined && value !== null) { sets.push(`${col} = $${p}`); vals.push(value); p++; }
    };
    setIf('phone_number', phone);
    setIf('telegram_user_id', telegramUserId);
    setIf('username', username);
    setIf('display_name', displayName);
    if (profile) {
      setIf('bio', profile.bio || null);
      setIf('is_premium', !!profile.isPremium);
      setIf('is_verified', !!profile.isVerified);
      setIf('is_scam', !!profile.isScam);
      setIf('is_fake', !!profile.isFake);
    }
    if (avatarDataUri !== undefined) setIf('avatar_thumb', avatarDataUri);
    vals.push(accountId);
    await pool.query(`UPDATE tracking_accounts SET ${sets.join(', ')} WHERE id = $${p}`, vals);

    // --- 5. 2FA state (live) ---
    const metaUpdate = { langCode: profile?.langCode || undefined };
    try {
      const twoFa = await tcService.get2FAState(sessionId, ownerId);
      if (twoFa) {
        metaUpdate.twoFaEnabledLive = !!twoFa.hasPassword;
        metaUpdate.twoFaHint = twoFa.hint || null;
        metaUpdate.hasRecoveryEmail = !!twoFa.hasRecovery;
        metaUpdate.maskedRecoveryEmail = twoFa.emailUnconfirmedPattern || null;
      }
    } catch (err) {
      logger.warn(`trackingSync: get2FAState failed for session ${sessionId}: ${err.message}`);
    }

    // --- 6. Privacy settings (per key) ---
    const privacy = {};
    for (const key of PRIVACY_KEYS) {
      try {
        const res = await tcService.getPrivacy(sessionId, ownerId, key);
        privacy[key] = summarizePrivacy(res?.rules);
      } catch (err) {
        // Some keys need premium / may be unsupported — skip quietly.
      }
    }
    if (Object.keys(privacy).length) metaUpdate.privacySettings = privacy;

    // --- 7. Active logins / authorizations ---
    let loginList = [];
    try {
      const auth = await tcService.listAuthorizations(sessionId, ownerId);
      loginList = (auth?.authorizations || []).map((a) => ({
        authHash: a.hash != null ? String(a.hash) : null,
        deviceModel: a.deviceModel || null,
        platform: a.platform || null,
        systemVersion: a.systemVersion || null,
        apiId: a.apiId != null ? Number(a.apiId) : null,
        appName: a.appName || null,
        appVersion: a.appVersion || null,
        officialApp: a.isOfficialApp ?? null,
        ip: a.ip || null,
        country: a.country || null,
        region: a.region || null,
        isCurrent: !!a.isCurrent,
        dateCreated: a.dateCreated ? new Date(Number(a.dateCreated) * 1000) : null,
        dateActive: a.dateActive ? new Date(Number(a.dateActive) * 1000) : null,
      }));
      metaUpdate.loginCount = loginList.length;
    } catch (err) {
      logger.warn(`trackingSync: listAuthorizations failed for session ${sessionId}: ${err.message}`);
    }

    await trackingTelegramMetaService.upsert(accountId, metaUpdate);
    await trackingLoginsService.replaceForAccount(accountId, loginList);

    logger.info(`trackingSync: synced session ${sessionId} → tracking account ${accountId} (${loginList.length} logins)`);
    return trackingAccountService.getAccountDetail(accountId);
  },

  /**
   * Best-effort fire-and-forget sync, safe to call from the login hook.
   * Never throws.
   */
  syncFromSessionSafe(sessionId, opts = {}) {
    this.syncFromSession(sessionId, opts).catch((err) => {
      logger.warn(`trackingSync: background sync failed for session ${sessionId}: ${err.message}`);
    });
  },

  /**
   * Sync every currently logged-in Telegram session. Used by the periodic
   * sweep and the "Sync all" action. Sequential to avoid hammering
   * Telegram; returns a small summary.
   */
  async syncAllLoggedIn({ actorUserId, staleMinutes = 0, limit = 200 } = {}) {
    const staleClause = staleMinutes > 0
      ? `AND (ta.session_synced_at IS NULL OR ta.session_synced_at < NOW() - INTERVAL '${parseInt(staleMinutes, 10)} minutes')`
      : '';
    const { rows } = await pool.query(
      `SELECT s.id
         FROM sessions s
         LEFT JOIN tracking_accounts ta ON ta.source_session_id = s.id
        WHERE s.is_logged_in = TRUE
          AND (s.platform = 'telegram' OR s.platform IS NULL)
          ${staleClause}
        ORDER BY s.id
        LIMIT $1`,
      [limit]
    );

    let synced = 0;
    const errors = [];
    for (const row of rows) {
      try {
        await this.syncFromSession(row.id, { actorUserId });
        synced++;
      } catch (err) {
        errors.push({ sessionId: row.id, error: err.message });
      }
    }
    return { candidates: rows.length, synced, errors };
  },
};

module.exports = trackingTelegramSyncService;
