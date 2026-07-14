const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');
const { applyPagination, applySorting, buildPagination } = require('../utils/pagination');
const trackingSessionInfoService = require('./trackingSessionInfoService');
const trackingSimInfoService = require('./trackingSimInfoService');
const trackingPurchaseService = require('./trackingPurchaseService');
const trackingTelegramMetaService = require('./trackingTelegramMetaService');

const VALID_STATUSES = ['available', 'reserved', 'sold', 'dead', 'banned', 'deleted', 'lost_access'];
const SORTABLE_FIELDS = [
  'created_at', 'updated_at', 'internal_code', 'phone_number', 'username',
  'country', 'status', 'sold_at', 'sale_price', 'purchase_price', 'last_seen_at',
];

// DB column -> camelCase request-body key. API request/response bodies use
// camelCase throughout (matching the rest of this codebase's controllers);
// only raw SQL column names are snake_case.
const BASIC_FIELD_MAP = {
  phone_number: 'phoneNumber',
  country: 'country',
  country_code: 'countryCode',
  telegram_user_id: 'telegramUserId',
  username: 'username',
  display_name: 'displayName',
  bio: 'bio',
  is_premium: 'isPremium',
  is_verified: 'isVerified',
  is_scam: 'isScam',
  is_fake: 'isFake',
  last_seen_at: 'lastSeenAt',
  estimated_value: 'estimatedValue',
};

function toAccountDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    internalCode: row.internal_code,
    platform: row.platform,
    phoneNumber: row.phone_number,
    country: row.country,
    countryCode: row.country_code,
    telegramUserId: row.telegram_user_id ? String(row.telegram_user_id) : null,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    isPremium: row.is_premium,
    isVerified: row.is_verified,
    isScam: row.is_scam,
    isFake: row.is_fake,
    lastSeenAt: row.last_seen_at,
    status: row.status,
    reservedUntil: row.reserved_until,
    assignedToUserId: row.assigned_to_user_id,
    assignedToEmail: row.assigned_to_email || null,
    purchasePrice: row.purchase_price !== null ? Number(row.purchase_price) : null,
    salePrice: row.sale_price !== null ? Number(row.sale_price) : null,
    soldAt: row.sold_at,
    estimatedValue: row.estimated_value !== null ? Number(row.estimated_value) : null,
    backupAvailable: row.backup_available,
    isDeleted: row.is_deleted,
    deletedAt: row.deleted_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: row.tags || undefined,
  };
}

function buildFilters(filters = {}) {
  const where = ['a.is_deleted = FALSE'];
  const params = [];
  let p = 1;

  if (filters.includeDeleted) {
    where.shift(); // drop the is_deleted guard entirely
  }
  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    where.push(`a.status = ANY($${p++})`);
    params.push(statuses);
  }
  if (filters.phone) {
    where.push(`a.phone_number ILIKE $${p++}`);
    params.push(`%${filters.phone}%`);
  }
  if (filters.username) {
    where.push(`a.username ILIKE $${p++}`);
    params.push(`%${filters.username}%`);
  }
  if (filters.telegramUserId) {
    where.push(`a.telegram_user_id = $${p++}`);
    params.push(filters.telegramUserId);
  }
  if (filters.country) {
    where.push(`a.country ILIKE $${p++}`);
    params.push(`%${filters.country}%`);
  }
  if (filters.premium !== undefined && filters.premium !== null && filters.premium !== '') {
    where.push(`a.is_premium = $${p++}`);
    params.push(filters.premium === true || filters.premium === 'true');
  }
  if (filters.assignedToUserId) {
    where.push(`a.assigned_to_user_id = $${p++}`);
    params.push(filters.assignedToUserId);
  }
  if (filters.salePriceMin !== undefined && filters.salePriceMin !== null && filters.salePriceMin !== '') {
    where.push(`a.sale_price >= $${p++}`);
    params.push(filters.salePriceMin);
  }
  if (filters.salePriceMax !== undefined && filters.salePriceMax !== null && filters.salePriceMax !== '') {
    where.push(`a.sale_price <= $${p++}`);
    params.push(filters.salePriceMax);
  }
  if (filters.purchasePriceMin !== undefined && filters.purchasePriceMin !== null && filters.purchasePriceMin !== '') {
    where.push(`a.purchase_price >= $${p++}`);
    params.push(filters.purchasePriceMin);
  }
  if (filters.purchasePriceMax !== undefined && filters.purchasePriceMax !== null && filters.purchasePriceMax !== '') {
    where.push(`a.purchase_price <= $${p++}`);
    params.push(filters.purchasePriceMax);
  }
  if (filters.dateFrom) {
    where.push(`a.created_at >= $${p++}`);
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    where.push(`a.created_at <= $${p++}`);
    params.push(filters.dateTo);
  }
  if (filters.buyer) {
    where.push(`EXISTS (
      SELECT 1 FROM tracking_account_sales s
       WHERE s.account_id = a.id
         AND (s.buyer_name ILIKE $${p} OR s.buyer_telegram_username ILIKE $${p})
    )`);
    params.push(`%${filters.buyer}%`);
    p++;
  }
  if (filters.supplier) {
    where.push(`EXISTS (
      SELECT 1 FROM tracking_account_purchase_info pi
       WHERE pi.account_id = a.id AND pi.supplier_name ILIKE $${p++}
    )`);
    params.push(`%${filters.supplier}%`);
  }
  if (filters.tagIds && filters.tagIds.length > 0) {
    where.push(`EXISTS (
      SELECT 1 FROM tracking_account_tags tt
       WHERE tt.account_id = a.id AND tt.tag_id = ANY($${p++})
    )`);
    params.push(filters.tagIds);
  }
  if (filters.search) {
    where.push(`(
      a.phone_number ILIKE $${p} OR a.username ILIKE $${p} OR a.display_name ILIKE $${p}
      OR a.internal_code ILIKE $${p} OR a.telegram_user_id::text ILIKE $${p}
    )`);
    params.push(`%${filters.search}%`);
    p++;
  }

  return { where, params, nextParamIndex: p };
}

const trackingAccountService = {
  VALID_STATUSES,
  // Exposed so trackingImportExportService can build a WHERE clause with
  // an alias `a.` for a custom column-set export query, without
  // duplicating the filter logic.
  buildFilters,

  async listAccounts(filters = {}, { page = 1, limit = 20, sort = 'created_at', order = 'DESC' } = {}) {
    const { field: sortField, order: sortOrder } = applySorting(sort, order, SORTABLE_FIELDS);
    const { offset, limit: pageSize } = applyPagination(null, page, limit);
    const { where, params, nextParamIndex } = buildFilters(filters);
    let p = nextParamIndex;

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM tracking_accounts a WHERE ${where.join(' AND ')}`,
      params
    );
    const total = countResult.rows[0].total;

    const { rows } = await pool.query(
      `SELECT a.*, u.email AS assigned_to_email,
              COALESCE(
                (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color))
                   FROM tracking_account_tags tt
                   JOIN tracking_tags t ON t.id = tt.tag_id
                  WHERE tt.account_id = a.id),
                '[]'
              ) AS tags
         FROM tracking_accounts a
         LEFT JOIN users u ON u.id = a.assigned_to_user_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.${sortField} ${sortOrder}
        LIMIT $${p++} OFFSET $${p++}`,
      [...params, pageSize, offset]
    );

    return {
      accounts: rows.map(toAccountDTO),
      pagination: buildPagination(page, limit, total),
    };
  },

  async getAccountRow(id) {
    const { rows } = await pool.query(
      `SELECT a.*, u.email AS assigned_to_email
         FROM tracking_accounts a
         LEFT JOIN users u ON u.id = a.assigned_to_user_id
        WHERE a.id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  /**
   * Full detail view: core account + joined 1:1 side tables + tags +
   * latest sale + current (open) assignment + notes/attachments counts.
   * Security fields are deliberately NOT included here — they're fetched
   * (and decrypted) only via the dedicated /security endpoint, gated by
   * the `security` permission.
   */
  async getAccountDetail(id) {
    const account = await this.getAccountRow(id);
    if (!account) {
      throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
    }

    const [session, sim, purchase, telegramMeta, latestSale, openAssignment, tags, noteCount, attachmentCount] = await Promise.all([
      trackingSessionInfoService.getByAccount(id),
      trackingSimInfoService.getByAccount(id),
      trackingPurchaseService.getByAccount(id),
      trackingTelegramMetaService.getByAccount(id),
      pool.query(
        'SELECT * FROM tracking_account_sales WHERE account_id = $1 ORDER BY sale_date DESC LIMIT 1',
        [id]
      ),
      pool.query(
        `SELECT ta.*, u.email AS assigned_to_email
           FROM tracking_assignments ta
           LEFT JOIN users u ON u.id = ta.assigned_to_user_id
          WHERE ta.account_id = $1 AND ta.returned_date IS NULL
          ORDER BY ta.assigned_date DESC LIMIT 1`,
        [id]
      ),
      pool.query(
        `SELECT t.id, t.name, t.color FROM tracking_account_tags tt
           JOIN tracking_tags t ON t.id = tt.tag_id
          WHERE tt.account_id = $1 ORDER BY t.name`,
        [id]
      ),
      pool.query('SELECT COUNT(*)::int AS n FROM tracking_notes WHERE account_id = $1', [id]),
      pool.query('SELECT COUNT(*)::int AS n FROM tracking_attachments WHERE account_id = $1', [id]),
    ]);

    const dto = toAccountDTO(account);
    dto.tags = tags.rows;
    dto.session = session;
    dto.sim = sim;
    dto.purchase = purchase;
    dto.telegramMeta = telegramMeta;
    dto.latestSale = latestSale.rows[0] || null;
    dto.currentAssignment = openAssignment.rows[0] || null;
    dto.notesCount = noteCount.rows[0].n;
    dto.attachmentsCount = attachmentCount.rows[0].n;
    return dto;
  },

  async createAccount(userId, data) {
    const fields = ['created_by', 'updated_by'];
    const values = [userId, userId];
    const placeholders = ['$1', '$2'];
    let p = 3;

    for (const [column, bodyKey] of Object.entries(BASIC_FIELD_MAP)) {
      if (data[bodyKey] !== undefined) {
        fields.push(column);
        values.push(data[bodyKey]);
        placeholders.push(`$${p++}`);
      }
    }
    if (data.status !== undefined) {
      if (!VALID_STATUSES.includes(data.status)) {
        throw new AppError(`Invalid status: ${data.status}`, 400, 'INVALID_STATUS');
      }
      fields.push('status');
      values.push(data.status);
      placeholders.push(`$${p++}`);
    }

    const { rows } = await pool.query(
      `INSERT INTO tracking_accounts (${fields.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING id`,
      values
    );
    const id = rows[0].id;

    const code = `TG-${String(id).padStart(6, '0')}`;
    await pool.query('UPDATE tracking_accounts SET internal_code = $1 WHERE id = $2', [code, id]);

    return this.getAccountDetail(id);
  },

  async updateAccount(userId, id, data) {
    const existing = await this.getAccountRow(id);
    if (!existing) {
      throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
    }

    const sets = ['updated_by = $1', 'updated_at = NOW()'];
    const values = [userId];
    let p = 2;

    for (const [column, bodyKey] of Object.entries(BASIC_FIELD_MAP)) {
      if (data[bodyKey] !== undefined) {
        sets.push(`${column} = $${p++}`);
        values.push(data[bodyKey]);
      }
    }

    values.push(id);
    await pool.query(
      `UPDATE tracking_accounts SET ${sets.join(', ')} WHERE id = $${p}`,
      values
    );
    return this.getAccountDetail(id);
  },

  async changeStatus(userId, id, status, { reservedUntil } = {}) {
    if (!VALID_STATUSES.includes(status)) {
      throw new AppError(`Invalid status: ${status}`, 400, 'INVALID_STATUS');
    }
    const existing = await this.getAccountRow(id);
    if (!existing) {
      throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
    }

    await pool.query(
      `UPDATE tracking_accounts
          SET status = $1,
              reserved_until = $2,
              updated_by = $3,
              updated_at = NOW()
        WHERE id = $4`,
      [status, status === 'reserved' ? reservedUntil || null : null, userId, id]
    );
    return this.getAccountDetail(id);
  },

  async softDeleteAccount(userId, id) {
    const existing = await this.getAccountRow(id);
    if (!existing) {
      throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
    }
    await pool.query(
      `UPDATE tracking_accounts
          SET is_deleted = TRUE, deleted_at = NOW(), updated_by = $1, updated_at = NOW()
        WHERE id = $2`,
      [userId, id]
    );
    return { deleted: true };
  },

  async restoreAccount(userId, id) {
    const { rowCount } = await pool.query(
      `UPDATE tracking_accounts
          SET is_deleted = FALSE, deleted_at = NULL, updated_by = $1, updated_at = NOW()
        WHERE id = $2`,
      [userId, id]
    );
    if (rowCount === 0) {
      throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
    }
    return this.getAccountDetail(id);
  },
};

module.exports = trackingAccountService;
