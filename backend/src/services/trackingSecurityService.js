const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');
const sessionCrypto = require('../utils/sessionCrypto');

// DB column -> [request-body key, encrypted-at-rest]
const FIELD_MAP = {
  two_fa_password_encrypted: 'twoFaPassword',
  two_fa_hint_encrypted: 'twoFaHint',
  recovery_email_encrypted: 'recoveryEmail',
  security_notes_encrypted: 'securityNotes',
};

async function assertAccountExists(accountId) {
  const { rows } = await pool.query('SELECT id FROM tracking_accounts WHERE id = $1', [accountId]);
  if (!rows[0]) throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
}

function safeDecrypt(payload) {
  if (!payload) return null;
  try {
    return sessionCrypto.decrypt(payload);
  } catch (_err) {
    return null;
  }
}

const trackingSecurityService = {
  /**
   * Decrypts and returns the security row. Callers MUST have already
   * checked the `security` tracking permission — this service has no
   * awareness of permissions itself.
   */
  async getByAccount(accountId) {
    const { rows } = await pool.query(
      'SELECT * FROM tracking_account_security WHERE account_id = $1',
      [accountId]
    );
    const row = rows[0];
    if (!row) {
      return {
        twoFaPassword: null, twoFaHint: null, recoveryEmail: null,
        securityNotes: null, passwordChangedAt: null,
      };
    }
    return {
      twoFaPassword: safeDecrypt(row.two_fa_password_encrypted),
      twoFaHint: safeDecrypt(row.two_fa_hint_encrypted),
      recoveryEmail: safeDecrypt(row.recovery_email_encrypted),
      securityNotes: safeDecrypt(row.security_notes_encrypted),
      passwordChangedAt: row.password_changed_at,
      updatedAt: row.updated_at,
    };
  },

  async upsert(accountId, data) {
    await assertAccountExists(accountId);
    const fields = ['account_id'];
    const values = [accountId];
    const updates = [];

    for (const [column, bodyKey] of Object.entries(FIELD_MAP)) {
      if (data[bodyKey] !== undefined) {
        const plaintext = data[bodyKey];
        fields.push(column);
        values.push(plaintext === null || plaintext === '' ? null : sessionCrypto.encrypt(plaintext));
        updates.push(`${column} = EXCLUDED.${column}`);
      }
    }
    if (data.passwordChangedAt !== undefined) {
      fields.push('password_changed_at');
      values.push(data.passwordChangedAt);
      updates.push('password_changed_at = EXCLUDED.password_changed_at');
    }

    await pool.query(
      `INSERT INTO tracking_account_security (${fields.join(', ')})
       VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (account_id) DO UPDATE SET
         ${updates.length ? updates.join(', ') + ',' : ''}
         updated_at = NOW()`,
      values
    );
    return this.getByAccount(accountId);
  },
};

module.exports = trackingSecurityService;
