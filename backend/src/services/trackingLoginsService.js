const { pool } = require('../config/database');

const COLUMNS = [
  'auth_hash', 'device_model', 'platform', 'system_version', 'api_id',
  'app_name', 'app_version', 'official_app', 'ip', 'country', 'region',
  'is_current', 'date_created', 'date_active',
];

// camelCase key each COLUMN maps from on the incoming login object.
const KEY = {
  auth_hash: 'authHash', device_model: 'deviceModel', platform: 'platform',
  system_version: 'systemVersion', api_id: 'apiId', app_name: 'appName',
  app_version: 'appVersion', official_app: 'officialApp', ip: 'ip',
  country: 'country', region: 'region', is_current: 'isCurrent',
  date_created: 'dateCreated', date_active: 'dateActive',
};

function toDTO(row) {
  return {
    id: row.id,
    authHash: row.auth_hash,
    deviceModel: row.device_model,
    platform: row.platform,
    systemVersion: row.system_version,
    apiId: row.api_id,
    appName: row.app_name,
    appVersion: row.app_version,
    officialApp: row.official_app,
    ip: row.ip,
    country: row.country,
    region: row.region,
    isCurrent: row.is_current,
    dateCreated: row.date_created,
    dateActive: row.date_active,
    syncedAt: row.synced_at,
  };
}

const trackingLoginsService = {
  async listByAccount(accountId) {
    const { rows } = await pool.query(
      `SELECT * FROM tracking_account_logins WHERE account_id = $1
        ORDER BY is_current DESC, date_active DESC NULLS LAST`,
      [accountId]
    );
    return rows.map(toDTO);
  },

  /**
   * Snapshot-replace: delete the account's existing login rows and insert
   * the freshly-fetched list, all in one transaction. Called by the
   * session sync. Returns the new list.
   */
  async replaceForAccount(accountId, logins) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM tracking_account_logins WHERE account_id = $1', [accountId]);

      for (const login of logins || []) {
        const cols = ['account_id'];
        const vals = [accountId];
        const ph = ['$1'];
        let p = 2;
        for (const col of COLUMNS) {
          const v = login[KEY[col]];
          if (v !== undefined) {
            cols.push(col);
            vals.push(v);
            ph.push(`$${p++}`);
          }
        }
        await client.query(
          `INSERT INTO tracking_account_logins (${cols.join(', ')}) VALUES (${ph.join(', ')})`,
          vals
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return this.listByAccount(accountId);
  },
};

module.exports = trackingLoginsService;
