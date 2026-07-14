const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');

const UPSERT_FIELDS = {
  phone_number: 'phoneNumber',
  sim_provider: 'simProvider',
  sim_country: 'simCountry',
  sim_type: 'simType',
  two_fa_enabled: 'twoFaEnabled',
  recovery_status: 'recoveryStatus',
  sim_status: 'simStatus',
  notes: 'notes',
};

async function assertAccountExists(accountId) {
  const { rows } = await pool.query('SELECT id FROM tracking_accounts WHERE id = $1', [accountId]);
  if (!rows[0]) throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
}

function toDTO(row, recoveryEmailConfigured) {
  if (!row) return { recoveryEmailConfigured };
  return {
    phoneNumber: row.phone_number,
    simProvider: row.sim_provider,
    simCountry: row.sim_country,
    simType: row.sim_type,
    twoFaEnabled: row.two_fa_enabled,
    recoveryStatus: row.recovery_status,
    simStatus: row.sim_status,
    notes: row.notes,
    // The actual recovery email lives only in tracking_account_security
    // (encrypted) — this is a same-PII-once computed flag, not a value.
    recoveryEmailConfigured,
    updatedAt: row.updated_at,
  };
}

const trackingSimInfoService = {
  async getByAccount(accountId) {
    const [simResult, securityResult] = await Promise.all([
      pool.query('SELECT * FROM tracking_account_sim_info WHERE account_id = $1', [accountId]),
      pool.query(
        'SELECT recovery_email_encrypted IS NOT NULL AS configured FROM tracking_account_security WHERE account_id = $1',
        [accountId]
      ),
    ]);
    const recoveryEmailConfigured = !!securityResult.rows[0]?.configured;
    return toDTO(simResult.rows[0], recoveryEmailConfigured);
  },

  async upsert(accountId, data) {
    await assertAccountExists(accountId);
    const fields = ['account_id'];
    const values = [accountId];
    const updates = [];

    for (const [column, bodyKey] of Object.entries(UPSERT_FIELDS)) {
      if (data[bodyKey] !== undefined) {
        fields.push(column);
        values.push(data[bodyKey]);
        updates.push(`${column} = EXCLUDED.${column}`);
      }
    }

    await pool.query(
      `INSERT INTO tracking_account_sim_info (${fields.join(', ')})
       VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (account_id) DO UPDATE SET
         ${updates.length ? updates.join(', ') + ',' : ''}
         updated_at = NOW()`,
      values
    );
    return this.getByAccount(accountId);
  },
};

module.exports = trackingSimInfoService;
