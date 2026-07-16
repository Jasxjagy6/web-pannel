const { pool } = require('../config/database');

const ACTIVE_STATUSES = ['available', 'reserved'];

function num(v) {
  return v !== null && v !== undefined ? Number(v) : 0;
}

const trackingDashboardService = {
  async getStats() {
    const [counts, values, sales] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE is_deleted = FALSE) AS total_accounts,
          COUNT(*) FILTER (WHERE is_deleted = FALSE AND status = ANY($1)) AS active_accounts,
          COUNT(*) FILTER (WHERE status = 'sold') AS sold_accounts,
          COUNT(*) FILTER (WHERE is_deleted = FALSE AND status = 'available') AS available_accounts,
          COUNT(*) FILTER (WHERE is_deleted = FALSE AND status = 'reserved') AS reserved_accounts,
          COUNT(*) FILTER (WHERE is_deleted = FALSE AND is_premium = TRUE) AS premium_accounts,
          COUNT(*) FILTER (WHERE is_deleted = FALSE AND is_premium = FALSE) AS non_premium_accounts,
          COUNT(*) FILTER (WHERE status = 'banned') AS banned_accounts,
          COUNT(*) FILTER (WHERE status = 'deleted') AS deleted_accounts,
          COUNT(*) FILTER (WHERE is_deleted = FALSE AND created_at >= date_trunc('day', NOW())) AS uploaded_today
        FROM tracking_accounts
      `, [ACTIVE_STATUSES]),
      pool.query(`
        SELECT
          COALESCE(SUM(COALESCE(estimated_value, purchase_price, 0)) FILTER (WHERE is_deleted = FALSE AND status <> 'sold'), 0) AS unsold_inventory_value,
          COALESCE(SUM(sale_price) FILTER (WHERE status = 'sold'), 0) AS sold_inventory_value,
          COALESCE(SUM(sale_price) FILTER (WHERE status = 'sold'), 0) AS total_sales_value,
          COALESCE(SUM(sale_price - purchase_price) FILTER (WHERE status = 'sold' AND purchase_price IS NOT NULL), 0) AS total_profit,
          COALESCE(AVG(sale_price) FILTER (WHERE status = 'sold'), 0) AS avg_selling_price,
          COALESCE(MAX(sale_price) FILTER (WHERE status = 'sold'), 0) AS highest_sale,
          COALESCE(MIN(sale_price) FILTER (WHERE status = 'sold'), 0) AS lowest_sale
        FROM tracking_accounts
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE payment_status = 'pending') AS pending_payments,
          COALESCE(SUM(sale_price) FILTER (WHERE sale_date >= date_trunc('day', NOW())), 0) AS daily_earnings,
          COALESCE(SUM(sale_price) FILTER (WHERE sale_date >= date_trunc('week', NOW())), 0) AS weekly_earnings,
          COALESCE(SUM(sale_price) FILTER (WHERE sale_date >= date_trunc('month', NOW())), 0) AS monthly_earnings
        FROM tracking_account_sales
      `),
    ]);

    const c = counts.rows[0];
    const v = values.rows[0];
    const s = sales.rows[0];

    return {
      totalAccounts: num(c.total_accounts),
      activeAccounts: num(c.active_accounts),
      soldAccounts: num(c.sold_accounts),
      availableAccounts: num(c.available_accounts),
      reservedAccounts: num(c.reserved_accounts),
      premiumAccounts: num(c.premium_accounts),
      nonPremiumAccounts: num(c.non_premium_accounts),
      bannedAccounts: num(c.banned_accounts),
      deletedAccounts: num(c.deleted_accounts),
      uploadedToday: num(c.uploaded_today),
      totalEstimatedInventoryValue: num(v.unsold_inventory_value),
      unsoldInventoryValue: num(v.unsold_inventory_value),
      soldInventoryValue: num(v.sold_inventory_value),
      totalSalesValue: num(v.total_sales_value),
      totalProfit: num(v.total_profit),
      averageSellingPrice: num(v.avg_selling_price),
      highestSale: num(v.highest_sale),
      lowestSale: num(v.lowest_sale),
      pendingPayments: num(s.pending_payments),
      dailyEarnings: num(s.daily_earnings),
      weeklyEarnings: num(s.weekly_earnings),
      monthlyEarnings: num(s.monthly_earnings),
    };
  },

  /**
   * Monthly series for the last `months` months: uploads, sales count,
   * revenue, and profit. Profit joins each sale back to its account's
   * denormalized purchase_price (an approximation — good enough for a
   * dashboard trend chart, not a ledger).
   */
  async getCharts(months = 12) {
    const [uploads, sales] = await Promise.all([
      pool.query(`
        SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, COUNT(*)::int AS count
          FROM tracking_accounts
         WHERE created_at >= date_trunc('month', NOW()) - ($1 || ' months')::interval
           AND is_deleted = FALSE
         GROUP BY 1 ORDER BY 1
      `, [months]),
      pool.query(`
        SELECT to_char(date_trunc('month', s.sale_date), 'YYYY-MM') AS month,
               COUNT(*)::int AS count,
               COALESCE(SUM(s.sale_price), 0) AS revenue,
               COALESCE(SUM(s.sale_price - a.purchase_price), 0) AS profit
          FROM tracking_account_sales s
          JOIN tracking_accounts a ON a.id = s.account_id
         WHERE s.sale_date >= date_trunc('month', NOW()) - ($1 || ' months')::interval
         GROUP BY 1 ORDER BY 1
      `, [months]),
    ]);

    return {
      uploads: uploads.rows.map((r) => ({ month: r.month, count: Number(r.count) })),
      sales: sales.rows.map((r) => ({ month: r.month, count: Number(r.count), revenue: Number(r.revenue), profit: Number(r.profit) })),
    };
  },

  async getRecent(limit = 10) {
    const [uploads, sales, activity] = await Promise.all([
      pool.query(
        `SELECT id, internal_code, username, display_name, status, created_at
           FROM tracking_accounts WHERE is_deleted = FALSE
          ORDER BY created_at DESC LIMIT $1`,
        [limit]
      ),
      pool.query(
        `SELECT s.id, s.account_id, a.internal_code, s.buyer_name, s.sale_price, s.payment_status, s.sale_date
           FROM tracking_account_sales s
           JOIN tracking_accounts a ON a.id = s.account_id
          ORDER BY s.sale_date DESC LIMIT $1`,
        [limit]
      ),
      pool.query(
        `SELECT al.id, al.user_id, u.email, al.action, al.entity_type, al.entity_id, al.details, al.created_at
           FROM activity_logs al
           LEFT JOIN users u ON u.id = al.user_id
          WHERE al.entity_type IN ('tracking_account', 'tracking_tag')
          ORDER BY al.created_at DESC LIMIT $1`,
        [limit]
      ),
    ]);

    return {
      recentUploads: uploads.rows,
      recentSales: sales.rows.map((r) => ({ ...r, sale_price: num(r.sale_price) })),
      recentActivity: activity.rows,
    };
  },

  /**
   * Live, computed-on-read alerts — no persisted notification table.
   * Recomputed fresh every dashboard load.
   */
  async getAlerts() {
    const [expiring, pending, missingBackup] = await Promise.all([
      pool.query(`
        SELECT id, internal_code, username, reserved_until
          FROM tracking_accounts
         WHERE is_deleted = FALSE AND status = 'reserved'
           AND reserved_until IS NOT NULL
           AND reserved_until <= NOW() + INTERVAL '24 hours'
           AND reserved_until > NOW()
         ORDER BY reserved_until ASC
      `),
      pool.query(`
        SELECT s.id AS sale_id, s.account_id, a.internal_code, s.sale_price, s.sale_date
          FROM tracking_account_sales s
          JOIN tracking_accounts a ON a.id = s.account_id
         WHERE s.payment_status = 'pending'
         ORDER BY s.sale_date ASC
      `),
      pool.query(`
        SELECT id, internal_code, username
          FROM tracking_accounts
         WHERE is_deleted = FALSE AND backup_available = FALSE
           AND status NOT IN ('dead', 'banned', 'deleted', 'lost_access')
         ORDER BY created_at DESC
         LIMIT 50
      `),
    ]);

    return {
      reservationsExpiringSoon: expiring.rows,
      paymentsPending: pending.rows.map((r) => ({ ...r, sale_price: num(r.sale_price) })),
      backupMissing: missingBackup.rows,
    };
  },
};

module.exports = trackingDashboardService;
