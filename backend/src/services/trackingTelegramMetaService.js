const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');

// DB column -> camelCase key (matches raw JSON keys from a session-info
// export loosely, but internal representation stays camelCase like every
// other tracking service).
const UPSERT_FIELDS = {
  telegram_role: 'telegramRole',
  date_of_birth: 'dateOfBirth',
  date_of_birth_verified: 'dateOfBirthVerified',
  premium_expires_at: 'premiumExpiresAt',
  spamblock_status: 'spamblockStatus',
  spamblock_until: 'spamblockUntil',
  has_profile_pic: 'hasProfilePic',
  stats_spam_count: 'statsSpamCount',
  stats_invites_count: 'statsInvitesCount',
  extra_params: 'extraParams',
};

async function assertAccountExists(accountId) {
  const { rows } = await pool.query('SELECT id FROM tracking_accounts WHERE id = $1', [accountId]);
  if (!rows[0]) throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
}

function toDTO(row) {
  if (!row) return null;
  return {
    telegramRole: row.telegram_role,
    dateOfBirth: row.date_of_birth,
    dateOfBirthVerified: row.date_of_birth_verified,
    premiumExpiresAt: row.premium_expires_at,
    spamblockStatus: row.spamblock_status,
    spamblockUntil: row.spamblock_until,
    hasProfilePic: row.has_profile_pic,
    statsSpamCount: row.stats_spam_count,
    statsInvitesCount: row.stats_invites_count,
    extraParams: row.extra_params,
    updatedAt: row.updated_at,
  };
}

const trackingTelegramMetaService = {
  async getByAccount(accountId) {
    const { rows } = await pool.query(
      'SELECT * FROM tracking_account_telegram_meta WHERE account_id = $1',
      [accountId]
    );
    return toDTO(rows[0]);
  },

  async upsert(accountId, data) {
    await assertAccountExists(accountId);
    const fields = ['account_id'];
    const values = [accountId];
    const updates = [];

    for (const [column, bodyKey] of Object.entries(UPSERT_FIELDS)) {
      if (data[bodyKey] !== undefined) {
        fields.push(column);
        values.push(column === 'extra_params' ? JSON.stringify(data[bodyKey]) : data[bodyKey]);
        updates.push(`${column} = EXCLUDED.${column}`);
      }
    }
    if (fields.length === 1) return this.getByAccount(accountId);

    await pool.query(
      `INSERT INTO tracking_account_telegram_meta (${fields.join(', ')})
       VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (account_id) DO UPDATE SET
         ${updates.join(', ')},
         updated_at = NOW()`,
      values
    );
    return this.getByAccount(accountId);
  },
};

module.exports = trackingTelegramMetaService;
