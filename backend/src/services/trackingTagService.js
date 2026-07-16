const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');

function toTagDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    isSuggested: row.is_suggested,
    usageCount: row.usage_count !== undefined ? Number(row.usage_count) : undefined,
    createdAt: row.created_at,
  };
}

const trackingTagService = {
  async listAllTags() {
    const { rows } = await pool.query(
      `SELECT t.*, COUNT(tt.account_id)::int AS usage_count
         FROM tracking_tags t
         LEFT JOIN tracking_account_tags tt ON tt.tag_id = t.id
        GROUP BY t.id
        ORDER BY t.is_suggested DESC, t.name ASC`
    );
    return rows.map(toTagDTO);
  },

  async createTag(userId, { name, color }) {
    if (!name || !name.trim()) {
      throw new AppError('Tag name is required', 400, 'MISSING_TAG_NAME');
    }
    const { rows } = await pool.query(
      `INSERT INTO tracking_tags (name, color, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET color = COALESCE(EXCLUDED.color, tracking_tags.color)
       RETURNING *`,
      [name.trim(), color || null, userId]
    );
    return toTagDTO(rows[0]);
  },

  async updateTag(tagId, { name, color }) {
    const sets = [];
    const values = [];
    let p = 1;
    if (name !== undefined) { sets.push(`name = $${p++}`); values.push(name.trim()); }
    if (color !== undefined) { sets.push(`color = $${p++}`); values.push(color); }
    if (!sets.length) {
      const { rows } = await pool.query('SELECT * FROM tracking_tags WHERE id = $1', [tagId]);
      return toTagDTO(rows[0]);
    }
    values.push(tagId);
    const { rows } = await pool.query(
      `UPDATE tracking_tags SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    if (!rows[0]) throw new AppError('Tag not found', 404, 'TRACKING_TAG_NOT_FOUND');
    return toTagDTO(rows[0]);
  },

  async deleteTag(tagId) {
    const { rowCount } = await pool.query('DELETE FROM tracking_tags WHERE id = $1', [tagId]);
    if (rowCount === 0) throw new AppError('Tag not found', 404, 'TRACKING_TAG_NOT_FOUND');
    return { deleted: true };
  },

  async getTagsForAccount(accountId) {
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.color FROM tracking_account_tags tt
         JOIN tracking_tags t ON t.id = tt.tag_id
        WHERE tt.account_id = $1
        ORDER BY t.name`,
      [accountId]
    );
    return rows;
  },

  async addTagsToAccount(accountId, userId, tagIds) {
    if (!Array.isArray(tagIds) || tagIds.length === 0) {
      throw new AppError('tagIds array is required', 400, 'MISSING_TAG_IDS');
    }
    const accountExists = await pool.query('SELECT id FROM tracking_accounts WHERE id = $1', [accountId]);
    if (!accountExists.rows[0]) {
      throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
    }
    const values = tagIds.map((_, i) => `($1, $${i + 2}, $${tagIds.length + 2})`).join(', ');
    await pool.query(
      `INSERT INTO tracking_account_tags (account_id, tag_id, tagged_by)
       VALUES ${values}
       ON CONFLICT (account_id, tag_id) DO NOTHING`,
      [accountId, ...tagIds, userId]
    );
    return this.getTagsForAccount(accountId);
  },

  async removeTagFromAccount(accountId, tagId) {
    await pool.query(
      'DELETE FROM tracking_account_tags WHERE account_id = $1 AND tag_id = $2',
      [accountId, tagId]
    );
    return this.getTagsForAccount(accountId);
  },
};

module.exports = trackingTagService;
