const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');

function toDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    assignedToUserId: row.assigned_to_user_id,
    assignedToEmail: row.assigned_to_email || undefined,
    assignedToName: row.assigned_to_name,
    assignedDate: row.assigned_date,
    returnedDate: row.returned_date,
    assignedBy: row.assigned_by,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

async function assertAccountExists(client, accountId) {
  const { rows } = await client.query('SELECT id FROM tracking_accounts WHERE id = $1', [accountId]);
  if (!rows[0]) throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
}

const trackingAssignmentService = {
  async listByAccount(accountId) {
    const { rows } = await pool.query(
      `SELECT ta.*, u.email AS assigned_to_email
         FROM tracking_assignments ta
         LEFT JOIN users u ON u.id = ta.assigned_to_user_id
        WHERE ta.account_id = $1
        ORDER BY ta.assigned_date DESC`,
      [accountId]
    );
    return rows.map(toDTO);
  },

  /**
   * Opens a new assignment. History rows are never deleted or overwritten
   * — if an assignment is already open for this account, it's closed
   * (returned_date = NOW()) rather than dropped, so the full holder
   * history stays intact.
   */
  async assign(userId, accountId, data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertAccountExists(client, accountId);

      await client.query(
        `UPDATE tracking_assignments SET returned_date = NOW()
          WHERE account_id = $1 AND returned_date IS NULL`,
        [accountId]
      );

      const inserted = await client.query(
        `INSERT INTO tracking_assignments (account_id, assigned_to_user_id, assigned_to_name, assigned_by, reason)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [accountId, data.assignedToUserId || null, data.assignedToName || null, userId, data.reason || null]
      );

      await client.query(
        'UPDATE tracking_accounts SET assigned_to_user_id = $1, updated_at = NOW() WHERE id = $2',
        [data.assignedToUserId || null, accountId]
      );

      await client.query('COMMIT');
      return toDTO(inserted.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async returnAssignment(userId, accountId, assignmentId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT * FROM tracking_assignments WHERE id = $1 AND account_id = $2',
        [assignmentId, accountId]
      );
      if (!existing.rows[0]) {
        throw new AppError('Assignment not found', 404, 'TRACKING_ASSIGNMENT_NOT_FOUND');
      }
      if (existing.rows[0].returned_date) {
        throw new AppError('Assignment already returned', 400, 'TRACKING_ASSIGNMENT_ALREADY_RETURNED');
      }

      const updated = await client.query(
        'UPDATE tracking_assignments SET returned_date = NOW() WHERE id = $1 RETURNING *',
        [assignmentId]
      );

      await client.query(
        'UPDATE tracking_accounts SET assigned_to_user_id = NULL, updated_at = NOW() WHERE id = $1',
        [accountId]
      );

      await client.query('COMMIT');
      return toDTO(updated.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

module.exports = trackingAssignmentService;
