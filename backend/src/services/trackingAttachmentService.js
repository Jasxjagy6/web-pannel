const fs = require('fs');
const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');

const VALID_CATEGORIES = ['session_file', 'screenshot', 'document', 'backup_file', 'other'];

function toDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    category: row.category,
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes !== null ? Number(row.file_size_bytes) : null,
    mimeType: row.mime_type,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
  };
}

const trackingAttachmentService = {
  async listByAccount(accountId) {
    const { rows } = await pool.query(
      'SELECT * FROM tracking_attachments WHERE account_id = $1 ORDER BY created_at DESC',
      [accountId]
    );
    return rows.map(toDTO);
  },

  async upload(accountId, userId, file, category = 'other') {
    if (!VALID_CATEGORIES.includes(category)) {
      throw new AppError(`Invalid category: ${category}`, 400, 'INVALID_ATTACHMENT_CATEGORY');
    }
    const accountExists = await pool.query('SELECT id FROM tracking_accounts WHERE id = $1', [accountId]);
    if (!accountExists.rows[0]) {
      throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
    }
    const { rows } = await pool.query(
      `INSERT INTO tracking_attachments (account_id, category, file_name, file_path, file_size_bytes, mime_type, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [accountId, category, file.originalname, file.path, file.size, file.mimetype, userId]
    );
    return toDTO(rows[0]);
  },

  async getForDownload(accountId, attachmentId) {
    const { rows } = await pool.query(
      'SELECT * FROM tracking_attachments WHERE id = $1 AND account_id = $2',
      [attachmentId, accountId]
    );
    const row = rows[0];
    if (!row || !fs.existsSync(row.file_path)) {
      throw new AppError('Attachment not found', 404, 'TRACKING_ATTACHMENT_NOT_FOUND');
    }
    return row;
  },

  async remove(accountId, attachmentId) {
    const { rows } = await pool.query(
      'DELETE FROM tracking_attachments WHERE id = $1 AND account_id = $2 RETURNING *',
      [attachmentId, accountId]
    );
    const row = rows[0];
    if (!row) {
      throw new AppError('Attachment not found', 404, 'TRACKING_ATTACHMENT_NOT_FOUND');
    }
    // Best-effort disk cleanup — the DB row is the source of truth, so a
    // failure here shouldn't fail the request.
    fs.unlink(row.file_path, () => {});
    return { deleted: true };
  },
};

module.exports = trackingAttachmentService;
