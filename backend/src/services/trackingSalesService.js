const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');

const FIELD_MAP = {
  buyer_name: 'buyerName',
  buyer_telegram_username: 'buyerTelegramUsername',
  buyer_telegram_id: 'buyerTelegramId',
  buyer_contact: 'buyerContact',
  sale_date: 'saleDate',
  sale_price: 'salePrice',
  payment_method: 'paymentMethod',
  payment_status: 'paymentStatus',
  invoice_number: 'invoiceNumber',
  notes: 'notes',
};

function toDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    buyerName: row.buyer_name,
    buyerTelegramUsername: row.buyer_telegram_username,
    buyerTelegramId: row.buyer_telegram_id ? String(row.buyer_telegram_id) : null,
    buyerContact: row.buyer_contact,
    saleDate: row.sale_date,
    salePrice: row.sale_price !== null ? Number(row.sale_price) : null,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    invoiceNumber: row.invoice_number,
    notes: row.notes,
    soldBy: row.sold_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertAccountExists(client, accountId) {
  const { rows } = await client.query('SELECT id FROM tracking_accounts WHERE id = $1', [accountId]);
  if (!rows[0]) throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
}

const trackingSalesService = {
  async listByAccount(accountId) {
    const { rows } = await pool.query(
      'SELECT * FROM tracking_account_sales WHERE account_id = $1 ORDER BY sale_date DESC',
      [accountId]
    );
    return rows.map(toDTO);
  },

  /**
   * Records a sale and flips the account to 'sold', syncing the
   * denormalized sale_price/sold_at on tracking_accounts. Both writes
   * happen in one transaction so the account status can never end up
   * out of sync with its own sales history.
   */
  async recordSale(userId, accountId, data) {
    if (data.salePrice === undefined || data.salePrice === null) {
      throw new AppError('salePrice is required', 400, 'MISSING_SALE_PRICE');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertAccountExists(client, accountId);

      const fields = ['account_id', 'sold_by'];
      const values = [accountId, userId];
      const placeholders = ['$1', '$2'];
      let p = 3;
      for (const [column, bodyKey] of Object.entries(FIELD_MAP)) {
        if (data[bodyKey] !== undefined) {
          fields.push(column);
          values.push(data[bodyKey]);
          placeholders.push(`$${p++}`);
        }
      }

      const inserted = await client.query(
        `INSERT INTO tracking_account_sales (${fields.join(', ')})
         VALUES (${placeholders.join(', ')})
         RETURNING *`,
        values
      );
      const sale = inserted.rows[0];

      await client.query(
        `UPDATE tracking_accounts
            SET status = 'sold', sold_at = $1, sale_price = $2, updated_by = $3, updated_at = NOW()
          WHERE id = $4`,
        [sale.sale_date, sale.sale_price, userId, accountId]
      );

      await client.query('COMMIT');
      return toDTO(sale);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async updateSale(userId, accountId, saleId, data) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT * FROM tracking_account_sales WHERE id = $1 AND account_id = $2',
        [saleId, accountId]
      );
      if (!existing.rows[0]) {
        throw new AppError('Sale not found', 404, 'TRACKING_SALE_NOT_FOUND');
      }

      const sets = [];
      const values = [];
      let p = 1;
      for (const [column, bodyKey] of Object.entries(FIELD_MAP)) {
        if (data[bodyKey] !== undefined) {
          sets.push(`${column} = $${p++}`);
          values.push(data[bodyKey]);
        }
      }
      sets.push('updated_at = NOW()');
      values.push(saleId);

      const updated = await client.query(
        `UPDATE tracking_account_sales SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
        values
      );
      const sale = updated.rows[0];

      // If this is the account's most recent sale, keep the denormalized
      // copy on tracking_accounts in sync.
      const latest = await client.query(
        'SELECT id FROM tracking_account_sales WHERE account_id = $1 ORDER BY sale_date DESC LIMIT 1',
        [accountId]
      );
      if (latest.rows[0]?.id === sale.id) {
        await client.query(
          `UPDATE tracking_accounts
              SET sale_price = $1, sold_at = $2, updated_by = $3, updated_at = NOW()
            WHERE id = $4`,
          [sale.sale_price, sale.sale_date, userId, accountId]
        );
      }

      await client.query('COMMIT');
      return toDTO(sale);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

module.exports = trackingSalesService;
