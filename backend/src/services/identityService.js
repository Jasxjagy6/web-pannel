/**
 * IdentityService — Anti-Detect Layer
 * --------------------------------------------------------------------
 * Owns the per-session device fingerprint stored in
 *   sessions.device_identity (JSONB)
 *
 * Public API:
 *   loadOrCreate(sessionId, opts)       -> identity object, persisted
 *   load(sessionId)                     -> identity or null
 *   rotate(sessionId, opts)             -> new identity object, replaces old
 *   forUserId(userId)                   -> [{sessionId, identity}, ...]
 *   stats()                             -> aggregate stats for the panel
 *
 * Identity objects are validated through `deviceFingerprint.sanitizeIdentity`
 * on read so corrupt rows produce a fresh fingerprint rather than throwing.
 */

'use strict';

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const fingerprint = require('../utils/deviceFingerprint');

class IdentityService {
  /**
   * Read an identity straight from the DB. Returns null if the session
   * row is missing or the JSON is unusable.
   * @param {number|string} sessionId
   * @returns {Promise<object|null>}
   */
  async load(sessionId) {
    if (!sessionId) return null;
    try {
      const r = await pool.query(
        `SELECT device_identity FROM sessions WHERE id = $1`,
        [sessionId]
      );
      const row = r.rows[0];
      if (!row || !row.device_identity) return null;
      // Postgres returns JSONB as a parsed object already; defensive copy.
      const raw = typeof row.device_identity === 'string'
        ? JSON.parse(row.device_identity)
        : row.device_identity;
      const sanitized = fingerprint.sanitizeIdentity(raw);
      return sanitized;
    } catch (err) {
      logger.warn(`identityService.load failed for ${sessionId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Read the identity for a session; if none exists, generate one and
   * persist it deterministically.
   *
   * @param {number|string} sessionId
   * @param {object} [opts]
   * @param {string} [opts.country]   Lower-case ISO-2 country (for lang).
   * @param {string} [opts.lang]      Override lang code.
   * @param {string} [opts.platform]  Force a platform (android/ios/desktop/web).
   * @returns {Promise<object>}
   */
  async loadOrCreate(sessionId, opts = {}) {
    const existing = await this.load(sessionId);
    if (existing) return existing;
    return await this._generateAndStore(sessionId, opts);
  }

  /**
   * Replace whatever identity is stored for the session with a fresh one.
   * Use sparingly — Telegram notices when the same auth_key reports a
   * brand new device, and a re-roll should normally only happen when the
   * session is also re-bound to a different proxy.
   */
  async rotate(sessionId, opts = {}) {
    return await this._generateAndStore(sessionId, opts, true);
  }

  /**
   * Build & persist a new identity. When `forceRotate` is false, this
   * still only writes when the existing column is NULL (caller should
   * have already checked).
   */
  async _generateAndStore(sessionId, opts = {}, forceRotate = false) {
    const seedSource = String(sessionId);
    const platform = opts.platform || null;
    let profile = null;
    if (platform) {
      profile = fingerprint.PROFILES.find((p) => p.platform === platform) || null;
    }
    const identity = fingerprint.buildIdentity(profile, {
      seed: seedSource + (forceRotate ? `:${Date.now()}` : ''),
      country: opts.country,
      lang: opts.lang,
    });

    try {
      await pool.query(
        `UPDATE sessions
            SET device_identity = $1::jsonb
          WHERE id = $2`,
        [JSON.stringify(identity), sessionId]
      );
      logger.info(`Device identity ${forceRotate ? 'rotated' : 'assigned'}`, {
        sessionId,
        platform: identity.platform,
        deviceModel: identity.deviceModel,
        appVersion: identity.appVersion,
      });
    } catch (err) {
      logger.warn(
        `identityService failed to persist identity for ${sessionId}: ${err.message}`
      );
    }
    return identity;
  }

  /**
   * Persist an identity for a session that doesn't have a DB row yet.
   * Used by the create-session flow to associate the identity with the
   * row immediately after INSERT.
   */
  async store(sessionId, identity) {
    const sanitized = fingerprint.sanitizeIdentity(identity);
    if (!sanitized) {
      throw new Error('identityService.store: invalid identity');
    }
    await pool.query(
      `UPDATE sessions SET device_identity = $1::jsonb WHERE id = $2`,
      [JSON.stringify(sanitized), sessionId]
    );
    return sanitized;
  }

  /**
   * Fetch every (sessionId, identity) for a user. Mostly used by the
   * Anti-Detect page.
   */
  async forUserId(userId) {
    const r = await pool.query(
      `SELECT id, phone, device_identity, bound_proxy_id, status,
              is_logged_in, last_warmup_at, created_at
         FROM sessions
        WHERE user_id = $1
        ORDER BY id DESC`,
      [userId]
    );
    return r.rows.map((row) => {
      const identity = fingerprint.sanitizeIdentity(row.device_identity) || null;
      return {
        // snake_case for direct table-row consumption in the panel
        session_id: row.id,
        phone: row.phone,
        identity,
        has_identity: !!identity,
        bound_proxy_id: row.bound_proxy_id,
        status: row.status,
        is_logged_in: row.is_logged_in,
        last_warmup_at: row.last_warmup_at,
        created_at: row.created_at,
      };
    });
  }

  /**
   * Aggregate stats for the Anti-Detect dashboard.
   */
  async stats() {
    const total = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM sessions`
    )).rows[0].c;
    const withIdentity = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM sessions WHERE device_identity IS NOT NULL`
    )).rows[0].c;
    const platforms = await pool.query(
      `SELECT COALESCE(device_identity->>'platform', 'none') AS platform,
              COUNT(*)::int AS c
         FROM sessions
        GROUP BY 1
        ORDER BY 2 DESC`
    );
    return {
      totalSessions: total,
      withIdentity,
      missingIdentity: total - withIdentity,
      byPlatform: platforms.rows,
      profilePoolSize: fingerprint.listProfiles().length,
    };
  }
}

module.exports = new IdentityService();
