/**
 * UserApiCredentialsService — per-user Telegram API ID/Hash vault.
 *
 * Why this exists
 * ---------------
 * In v3 the panel moves from a single shared `TELEGRAM_API_ID` /
 * `TELEGRAM_API_HASH` (env-vars baked into the deployment) to a model
 * where every end-user registers their *own* Telegram API credentials.
 * Every session that user creates is bound to one of those credentials
 * for its entire lifetime, so all subsequent connections / scraping /
 * messaging happens under the user's own developer app.
 *
 * Two reasons:
 *   1. Account isolation — Telegram associates suspicious-activity
 *      heuristics with the API ID. Sharing a single API ID across
 *      hundreds of customers' accounts makes every customer fragile to
 *      one bad actor.
 *   2. Compliance — putting the API key on the customer means the panel
 *      operator no longer has to ship their key to the cloud workers.
 *
 * Rotation
 * --------
 * A user can register multiple credentials and configure
 * `max_sessions` per credential. When a new session is created the
 * service picks the credential with the lowest live `session_count`
 * that's still under its cap. If every credential is full, we surface
 * `NO_CREDENTIAL_CAPACITY` so the UI can prompt the user to either
 * raise `max_sessions` on an existing credential or register a new one.
 *
 * Storage
 * -------
 * `api_hash` is encrypted with the same AES-256-GCM helper that
 * encrypts uploaded session strings (`utils/crypto`). The hash is never
 * sent to the client in plain form — list/get endpoints return only
 * `api_hash_masked` with the last 4 chars visible.
 */

const { pool } = require('../config/database');
const { encrypt, decrypt } = require('../utils/crypto');
const { AppError } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const MAX_SESSIONS_FLOOR = 1;
const MAX_SESSIONS_CEIL = 50;
const MAX_LABEL_LEN = 100;
const MAX_NOTES_LEN = 500;

function maskHash(hashEnc) {
  if (!hashEnc) return null;
  try {
    const plain = decrypt(hashEnc);
    if (!plain || plain.length < 8) return '••••••••';
    // Fixed-width preview so the Settings grid stays tidy regardless
    // of the actual hash length. Eight bullets is enough to signal
    // the value is masked while leaving room for the last 4 chars
    // of the real hash for at-a-glance disambiguation.
    return `••••••••${plain.slice(-4)}`;
  } catch {
    return '••••••••';
  }
}

function publicRow(row, sessionCount) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label || `app ${row.api_id}`,
    apiId: Number(row.api_id),
    apiHashMasked: maskHash(row.api_hash_enc),
    maxSessions: row.max_sessions,
    isActive: row.is_active,
    notes: row.notes || null,
    sessionCount: sessionCount || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateApiId(apiId) {
  const n = Number(apiId);
  if (!Number.isFinite(n) || n <= 0) {
    throw new AppError(
      'API ID must be a positive integer (the numeric value from my.telegram.org).',
      400,
      'INVALID_API_ID'
    );
  }
  return Math.floor(n);
}

function validateApiHash(apiHash) {
  const s = String(apiHash || '').trim();
  if (s.length < 16) {
    throw new AppError(
      'API hash looks too short — it should be a 32-char hex string from my.telegram.org.',
      400,
      'INVALID_API_HASH'
    );
  }
  return s;
}

function validateMaxSessions(value, fallback = 3) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) {
    throw new AppError('max_sessions must be a number.', 400, 'INVALID_MAX_SESSIONS');
  }
  if (n < MAX_SESSIONS_FLOOR || n > MAX_SESSIONS_CEIL) {
    throw new AppError(
      `max_sessions must be between ${MAX_SESSIONS_FLOOR} and ${MAX_SESSIONS_CEIL}.`,
      400,
      'INVALID_MAX_SESSIONS'
    );
  }
  return n;
}

class UserApiCredentialsService {
  // -------------------------------------------------------------
  // Read helpers
  // -------------------------------------------------------------

  async list(userId) {
    const r = await pool.query(
      `SELECT c.*,
              COALESCE(s.cnt, 0) AS session_count
         FROM user_api_credentials c
         LEFT JOIN (
           SELECT user_api_credential_id, COUNT(*)::int AS cnt
             FROM sessions
            WHERE user_api_credential_id IS NOT NULL
              AND status <> 'deleted'
            GROUP BY user_api_credential_id
         ) s ON s.user_api_credential_id = c.id
        WHERE c.user_id = $1
          AND c.deleted_at IS NULL
        ORDER BY c.created_at ASC`,
      [userId]
    );
    return r.rows.map((row) => publicRow(row, row.session_count));
  }

  async getById(userId, id) {
    const r = await pool.query(
      `SELECT c.*,
              COALESCE((
                SELECT COUNT(*)::int FROM sessions
                 WHERE user_api_credential_id = c.id AND status <> 'deleted'
              ), 0) AS session_count
         FROM user_api_credentials c
        WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL`,
      [id, userId]
    );
    if (!r.rows[0]) {
      throw new AppError('Credential not found', 404, 'CREDENTIAL_NOT_FOUND');
    }
    return publicRow(r.rows[0], r.rows[0].session_count);
  }

  /**
   * Whether the user has at least one usable (active, not deleted)
   * credential. Used by the auth gate to decide whether the panel is
   * locked behind the "set up your API ID/Hash" wall.
   */
  async userHasUsable(userId) {
    const r = await pool.query(
      `SELECT 1 FROM user_api_credentials
        WHERE user_id = $1
          AND deleted_at IS NULL
          AND is_active = TRUE
        LIMIT 1`,
      [userId]
    );
    return r.rows.length > 0;
  }

  /**
   * Decrypted credential lookup — used internally by services when a
   * session row already carries a `user_api_credential_id`. Throws if
   * the credential has been deleted or deactivated.
   */
  async loadDecrypted(credentialId) {
    if (!credentialId) return null;
    const r = await pool.query(
      `SELECT id, user_id, api_id, api_hash_enc, max_sessions, is_active
         FROM user_api_credentials
        WHERE id = $1 AND deleted_at IS NULL`,
      [credentialId]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      apiId: Number(row.api_id),
      apiHash: decrypt(row.api_hash_enc),
      maxSessions: row.max_sessions,
      isActive: row.is_active,
    };
  }

  /**
   * Picks the credential a brand-new session should be minted under.
   *
   * Rules:
   *  - active=true AND deleted_at IS NULL
   *  - live `session_count < max_sessions`
   *  - tie-break by `(session_count ASC, created_at ASC)` so we pack
   *    the oldest credential first, leaving the newest for headroom.
   *  - if every credential is at capacity, throw NO_CREDENTIAL_CAPACITY
   *  - if the user has no credentials at all, throw API_CREDENTIALS_REQUIRED
   *
   * Returns { id, apiId, apiHash, maxSessions } with `apiHash` decrypted.
   */
  async pickForNewSession(userId) {
    const r = await pool.query(
      `SELECT c.id, c.api_id, c.api_hash_enc, c.max_sessions,
              COALESCE(s.cnt, 0) AS session_count
         FROM user_api_credentials c
         LEFT JOIN (
           SELECT user_api_credential_id, COUNT(*)::int AS cnt
             FROM sessions
            WHERE user_api_credential_id IS NOT NULL
              AND status <> 'deleted'
            GROUP BY user_api_credential_id
         ) s ON s.user_api_credential_id = c.id
        WHERE c.user_id = $1
          AND c.deleted_at IS NULL
          AND c.is_active = TRUE
        ORDER BY COALESCE(s.cnt, 0) ASC, c.created_at ASC`,
      [userId]
    );
    if (r.rows.length === 0) {
      throw new AppError(
        'No Telegram API credentials configured. Add one in Settings → Telegram API Credentials before creating a session.',
        412,
        'API_CREDENTIALS_REQUIRED'
      );
    }
    const pick = r.rows.find((row) => row.session_count < row.max_sessions);
    if (!pick) {
      throw new AppError(
        'All your Telegram API credentials are at their max_sessions cap. Raise the cap on an existing credential, or add a new credential in Settings.',
        409,
        'NO_CREDENTIAL_CAPACITY'
      );
    }
    return {
      id: pick.id,
      apiId: Number(pick.api_id),
      apiHash: decrypt(pick.api_hash_enc),
      maxSessions: pick.max_sessions,
      sessionCount: pick.session_count,
    };
  }

  // -------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------

  async create(userId, { label, apiId, apiHash, maxSessions, notes } = {}) {
    const cleanApiId = validateApiId(apiId);
    const cleanApiHash = validateApiHash(apiHash);
    const cleanMaxSessions = validateMaxSessions(maxSessions, 3);

    // Reject duplicates explicitly so the user gets a meaningful 409 instead
    // of a Postgres unique-constraint error message.
    const existing = await pool.query(
      `SELECT id FROM user_api_credentials
        WHERE user_id = $1 AND api_id = $2 AND deleted_at IS NULL`,
      [userId, cleanApiId]
    );
    if (existing.rows.length > 0) {
      throw new AppError(
        'You already have a credential for this API ID — edit it instead of adding a duplicate.',
        409,
        'CREDENTIAL_DUPLICATE'
      );
    }

    const enc = encrypt(cleanApiHash);
    const insert = await pool.query(
      `INSERT INTO user_api_credentials
         (user_id, label, api_id, api_hash_enc, max_sessions, notes,
          is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
       RETURNING *`,
      [
        userId,
        (label || '').slice(0, MAX_LABEL_LEN) || null,
        cleanApiId,
        enc,
        cleanMaxSessions,
        (notes || '').slice(0, MAX_NOTES_LEN) || null,
      ]
    );
    logger.info('user_api_credential created', {
      userId, credentialId: insert.rows[0].id, apiId: cleanApiId,
    });
    return publicRow(insert.rows[0], 0);
  }

  async update(userId, id, { label, apiHash, maxSessions, isActive, notes } = {}) {
    const owned = await pool.query(
      `SELECT id FROM user_api_credentials
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [id, userId]
    );
    if (!owned.rows[0]) {
      throw new AppError('Credential not found', 404, 'CREDENTIAL_NOT_FOUND');
    }
    const sets = [];
    const params = [];
    let i = 1;
    if (label !== undefined) {
      sets.push(`label = $${i++}`);
      params.push((label || '').slice(0, MAX_LABEL_LEN) || null);
    }
    if (apiHash !== undefined) {
      const cleanHash = validateApiHash(apiHash);
      sets.push(`api_hash_enc = $${i++}`);
      params.push(encrypt(cleanHash));
    }
    if (maxSessions !== undefined) {
      sets.push(`max_sessions = $${i++}`);
      params.push(validateMaxSessions(maxSessions, 3));
    }
    if (isActive !== undefined) {
      sets.push(`is_active = $${i++}`);
      params.push(!!isActive);
    }
    if (notes !== undefined) {
      sets.push(`notes = $${i++}`);
      params.push((notes || '').slice(0, MAX_NOTES_LEN) || null);
    }
    if (sets.length === 0) return await this.getById(userId, id);
    sets.push(`updated_at = NOW()`);
    params.push(id, userId);

    await pool.query(
      `UPDATE user_api_credentials
          SET ${sets.join(', ')}
        WHERE id = $${i++} AND user_id = $${i}`,
      params
    );
    return await this.getById(userId, id);
  }

  /**
   * Soft-delete the credential. Refuses if any session is still bound
   * to it — the UI is expected to surface "this credential has X live
   * sessions, log them out first" so the user picks an explicit choice.
   */
  async remove(userId, id) {
    const owned = await pool.query(
      `SELECT c.id,
              (SELECT COUNT(*)::int FROM sessions
                WHERE user_api_credential_id = c.id AND status <> 'deleted')
                AS session_count
         FROM user_api_credentials c
        WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL`,
      [id, userId]
    );
    const row = owned.rows[0];
    if (!row) {
      throw new AppError('Credential not found', 404, 'CREDENTIAL_NOT_FOUND');
    }
    if (row.session_count > 0) {
      throw new AppError(
        `Cannot delete: ${row.session_count} session(s) still tied to this credential. Log them out first.`,
        409,
        'CREDENTIAL_IN_USE'
      );
    }
    await pool.query(
      `UPDATE user_api_credentials
          SET deleted_at = NOW(), is_active = FALSE, updated_at = NOW()
        WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    logger.info('user_api_credential deleted', { userId, credentialId: id });
  }
}

module.exports = new UserApiCredentialsService();
