const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');

const UPSERT_FIELDS = {
  session_name: 'sessionName',
  session_version: 'sessionVersion',
  encryption_status: 'encryptionStatus',
  // Client/device fingerprint — usually populated from a paired
  // session-info JSON at ZIP-import time, but editable like any other
  // session field.
  app_id: 'appId',
  app_hash: 'appHash',
  device_model: 'deviceModel',
  system_version: 'systemVersion',
  client_app_version: 'clientAppVersion',
  lang_pack: 'langPack',
  system_lang_pack: 'systemLangPack',
  app_config_hash: 'appConfigHash',
  session_created_at: 'sessionCreatedAt',
};

async function assertAccountExists(accountId) {
  const { rows } = await pool.query('SELECT id FROM tracking_accounts WHERE id = $1', [accountId]);
  if (!rows[0]) throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
}

function toDTO(row) {
  if (!row) return null;
  return {
    sessionName: row.session_name,
    sessionFileAttachmentId: row.session_file_attachment_id,
    uploadedAt: row.uploaded_at,
    sessionSizeBytes: row.session_size_bytes !== null ? Number(row.session_size_bytes) : null,
    sessionVersion: row.session_version,
    encryptionStatus: row.encryption_status,
    lastUpdatedAt: row.last_updated_at,
    backupAvailable: row.backup_available,
    backupAttachmentId: row.backup_attachment_id,
    backupDate: row.backup_date,
    appId: row.app_id,
    appHash: row.app_hash,
    deviceModel: row.device_model,
    systemVersion: row.system_version,
    clientAppVersion: row.client_app_version,
    langPack: row.lang_pack,
    systemLangPack: row.system_lang_pack,
    appConfigHash: row.app_config_hash,
    sessionCreatedAt: row.session_created_at,
    updatedAt: row.updated_at,
  };
}

const trackingSessionInfoService = {
  async getByAccount(accountId) {
    const { rows } = await pool.query(
      'SELECT * FROM tracking_account_session_info WHERE account_id = $1',
      [accountId]
    );
    return toDTO(rows[0]);
  },

  async upsert(accountId, data) {
    await assertAccountExists(accountId);
    const fields = ['account_id'];
    const values = [accountId];
    const updates = [];
    let p = 2;

    for (const [column, bodyKey] of Object.entries(UPSERT_FIELDS)) {
      if (data[bodyKey] !== undefined) {
        fields.push(column);
        values.push(data[bodyKey]);
        updates.push(`${column} = EXCLUDED.${column}`);
        p++;
      }
    }

    await pool.query(
      `INSERT INTO tracking_account_session_info (${fields.join(', ')})
       VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (account_id) DO UPDATE SET
         ${updates.length ? updates.join(', ') + ',' : ''}
         updated_at = NOW()`,
      values
    );
    return this.getByAccount(accountId);
  },

  /**
   * Store an uploaded session file's metadata (never parses the file
   * content — it's opaque as far as this module is concerned).
   */
  async attachSessionFile(accountId, userId, file) {
    await assertAccountExists(accountId);
    const attachment = await pool.query(
      `INSERT INTO tracking_attachments (account_id, category, file_name, file_path, file_size_bytes, mime_type, uploaded_by)
       VALUES ($1, 'session_file', $2, $3, $4, $5, $6)
       RETURNING id`,
      [accountId, file.originalname, file.path, file.size, file.mimetype, userId]
    );
    const attachmentId = attachment.rows[0].id;

    await pool.query(
      `INSERT INTO tracking_account_session_info (account_id, session_file_attachment_id, uploaded_at, session_size_bytes, last_updated_at)
       VALUES ($1, $2, NOW(), $3, NOW())
       ON CONFLICT (account_id) DO UPDATE SET
         session_file_attachment_id = EXCLUDED.session_file_attachment_id,
         uploaded_at = NOW(),
         session_size_bytes = EXCLUDED.session_size_bytes,
         last_updated_at = NOW(),
         updated_at = NOW()`,
      [accountId, attachmentId, file.size]
    );
    return this.getByAccount(accountId);
  },

  async attachBackupFile(accountId, userId, file) {
    await assertAccountExists(accountId);
    const attachment = await pool.query(
      `INSERT INTO tracking_attachments (account_id, category, file_name, file_path, file_size_bytes, mime_type, uploaded_by)
       VALUES ($1, 'backup_file', $2, $3, $4, $5, $6)
       RETURNING id`,
      [accountId, file.originalname, file.path, file.size, file.mimetype, userId]
    );
    const attachmentId = attachment.rows[0].id;

    await pool.query(
      `INSERT INTO tracking_account_session_info (account_id, backup_attachment_id, backup_available, backup_date)
       VALUES ($1, $2, TRUE, NOW())
       ON CONFLICT (account_id) DO UPDATE SET
         backup_attachment_id = EXCLUDED.backup_attachment_id,
         backup_available = TRUE,
         backup_date = NOW(),
         updated_at = NOW()`,
      [accountId, attachmentId]
    );
    // Keep the denormalized flag on tracking_accounts in sync — it drives
    // the cheap list-page/dashboard "backup missing" queries.
    await pool.query('UPDATE tracking_accounts SET backup_available = TRUE WHERE id = $1', [accountId]);
    return this.getByAccount(accountId);
  },
};

module.exports = trackingSessionInfoService;
