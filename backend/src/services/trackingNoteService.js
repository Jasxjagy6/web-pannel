const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');

function toDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    authorId: row.author_id,
    authorEmail: row.author_email || undefined,
    note: row.note,
    createdAt: row.created_at,
  };
}

const trackingNoteService = {
  async listByAccount(accountId) {
    const { rows } = await pool.query(
      `SELECT n.*, u.email AS author_email
         FROM tracking_notes n
         LEFT JOIN users u ON u.id = n.author_id
        WHERE n.account_id = $1
        ORDER BY n.created_at DESC`,
      [accountId]
    );
    return rows.map(toDTO);
  },

  async addNote(userId, accountId, note) {
    if (!note || !note.trim()) {
      throw new AppError('Note text is required', 400, 'MISSING_NOTE');
    }
    const accountExists = await pool.query('SELECT id FROM tracking_accounts WHERE id = $1', [accountId]);
    if (!accountExists.rows[0]) {
      throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
    }
    const { rows } = await pool.query(
      `INSERT INTO tracking_notes (account_id, author_id, note)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [accountId, userId, note.trim()]
    );
    return toDTO(rows[0]);
  },
};

module.exports = trackingNoteService;
