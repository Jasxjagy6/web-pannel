const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');

const UPSERT_FIELDS = {
  source: 'source',
  supplier_name: 'supplierName',
  supplier_contact: 'supplierContact',
  purchase_price: 'purchasePrice',
  purchase_date: 'purchaseDate',
  order_id: 'orderId',
  notes: 'notes',
};

async function assertAccountExists(accountId) {
  const { rows } = await pool.query('SELECT id FROM tracking_accounts WHERE id = $1', [accountId]);
  if (!rows[0]) throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
}

function toDTO(row) {
  if (!row) return null;
  return {
    source: row.source,
    supplierName: row.supplier_name,
    supplierContact: row.supplier_contact,
    purchasePrice: row.purchase_price !== null ? Number(row.purchase_price) : null,
    purchaseDate: row.purchase_date,
    orderId: row.order_id,
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}

const trackingPurchaseService = {
  async getByAccount(accountId) {
    const { rows } = await pool.query(
      'SELECT * FROM tracking_account_purchase_info WHERE account_id = $1',
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
        values.push(data[bodyKey]);
        updates.push(`${column} = EXCLUDED.${column}`);
      }
    }

    await pool.query(
      `INSERT INTO tracking_account_purchase_info (${fields.join(', ')})
       VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (account_id) DO UPDATE SET
         ${updates.length ? updates.join(', ') + ',' : ''}
         updated_at = NOW()`,
      values
    );

    // Keep the denormalized copy on tracking_accounts in sync so the
    // list page / dashboard can read purchase_price without a join.
    if (data.purchasePrice !== undefined) {
      await pool.query('UPDATE tracking_accounts SET purchase_price = $1 WHERE id = $2', [data.purchasePrice, accountId]);
    }

    return this.getByAccount(accountId);
  },
};

module.exports = trackingPurchaseService;
