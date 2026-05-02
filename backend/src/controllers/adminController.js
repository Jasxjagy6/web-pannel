const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');
const { publicUser, SAFE_USER_COLUMNS } = require('./authController');

const VALID_PLANS = new Set(['trial', 'basic', 'pro', 'enterprise', 'admin']);

async function recordAdminAction(adminUserId, targetUserId, action, details = {}, reason = null) {
  await pool.query(
    `INSERT INTO admin_actions (admin_user_id, target_user_id, action, reason, details, performed_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [adminUserId, targetUserId, action, reason, details]
  );
}

const adminController = {
  /**
   * GET /api/admin/users
   *
   * Paged list of all users with quick-stats (sessions, jobs).
   * Search by email substring; filter by status / role.
   */
  listUsers: asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const search = (req.query.search || '').trim().toLowerCase();
    const status = req.query.status;
    const role = req.query.role;

    const where = [];
    const values = [];
    let i = 1;

    if (search) {
      where.push(`LOWER(email) LIKE $${i++}`);
      values.push(`%${search}%`);
    }
    if (status && ['pending', 'approved', 'banned'].includes(status)) {
      where.push(`status = $${i++}`);
      values.push(status);
    }
    if (role && ['user', 'admin'].includes(role)) {
      where.push(`role = $${i++}`);
      values.push(role);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalRes = await pool.query(`SELECT COUNT(*)::int AS n FROM users ${whereSql}`, values);

    const listRes = await pool.query(
      `SELECT u.id, u.email, u.role, u.status, u.is_approved, u.approved_at,
              u.banned_at, u.banned_reason,
              u.subscription_plan, u.subscription_status,
              u.subscription_expires_at, u.subscription_features,
              u.notes, u.created_at, u.updated_at, u.last_login,
              (SELECT COUNT(*)::int FROM sessions s WHERE s.user_id = u.id) AS sessions_count,
              (SELECT COUNT(*)::int FROM sessions s WHERE s.user_id = u.id AND s.is_logged_in = TRUE) AS active_sessions_count
         FROM users u
         ${whereSql}
         ORDER BY u.created_at DESC
         LIMIT $${i++} OFFSET $${i++}`,
      [...values, limit, offset]
    );

    return res.status(200).json({
      success: true,
      data: {
        total: totalRes.rows[0].n,
        users: listRes.rows.map((row) => ({
          ...publicUser(row),
          sessionsCount: row.sessions_count,
          activeSessionsCount: row.active_sessions_count,
        })),
      },
    });
  }),

  /**
   * GET /api/admin/users/:id
   */
  getUser: asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      throw new AppError('Invalid user id', 400, 'BAD_ID');
    }
    const r = await pool.query(
      `SELECT ${SAFE_USER_COLUMNS} FROM users WHERE id = $1`,
      [userId]
    );
    if (!r.rows[0]) throw new AppError('User not found', 404, 'NOT_FOUND');

    const stats = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM sessions WHERE user_id = $1) AS sessions,
         (SELECT COUNT(*)::int FROM sessions WHERE user_id = $1 AND is_logged_in = TRUE) AS active_sessions,
         (SELECT COUNT(*)::int FROM scraping_jobs WHERE user_id = $1) AS scrape_jobs,
         (SELECT COUNT(*)::int FROM messaging_jobs WHERE user_id = $1) AS messaging_jobs,
         (SELECT COUNT(*)::int FROM privacy_jobs WHERE user_id = $1) AS privacy_jobs,
         (SELECT COUNT(*)::int FROM lists WHERE user_id = $1) AS lists`,
      [userId]
    );

    const recentActions = await pool.query(
      `SELECT a.id, a.action, a.reason, a.details, a.performed_at,
              au.email AS admin_email
         FROM admin_actions a
         JOIN users au ON au.id = a.admin_user_id
         WHERE a.target_user_id = $1
         ORDER BY a.performed_at DESC
         LIMIT 50`,
      [userId]
    );

    return res.status(200).json({
      success: true,
      data: {
        user: publicUser(r.rows[0]),
        stats: stats.rows[0],
        recentActions: recentActions.rows,
      },
    });
  }),

  /**
   * POST /api/admin/users/:id/approve
   */
  approveUser: asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) throw new AppError('Invalid user id', 400, 'BAD_ID');
    if (userId === req.user.id) {
      throw new AppError('Cannot act on yourself', 400, 'BAD_REQUEST');
    }

    const result = await pool.query(
      `UPDATE users
          SET status = 'approved',
              is_approved = TRUE,
              approved_at = NOW(),
              approved_by = $2,
              banned_at = NULL,
              banned_reason = NULL,
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${SAFE_USER_COLUMNS}`,
      [userId, req.user.id]
    );
    if (!result.rows[0]) throw new AppError('User not found', 404, 'NOT_FOUND');
    await recordAdminAction(req.user.id, userId, 'approve');
    logger.info('admin: user approved', { admin: req.user.id, target: userId });
    return res.status(200).json({ success: true, user: publicUser(result.rows[0]) });
  }),

  /**
   * POST /api/admin/users/:id/ban
   */
  banUser: asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) throw new AppError('Invalid user id', 400, 'BAD_ID');
    if (userId === req.user.id) {
      throw new AppError('Cannot act on yourself', 400, 'BAD_REQUEST');
    }

    const target = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    if (!target.rows[0]) throw new AppError('User not found', 404, 'NOT_FOUND');
    if (target.rows[0].role === 'admin') {
      throw new AppError('Cannot ban an admin', 400, 'BAD_REQUEST');
    }

    const reason = (req.body && req.body.reason) ? String(req.body.reason).slice(0, 500) : null;
    const result = await pool.query(
      `UPDATE users
          SET status = 'banned',
              is_approved = FALSE,
              banned_at = NOW(),
              banned_reason = $2,
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${SAFE_USER_COLUMNS}`,
      [userId, reason]
    );
    await recordAdminAction(req.user.id, userId, 'ban', {}, reason);
    logger.info('admin: user banned', { admin: req.user.id, target: userId, reason });
    return res.status(200).json({ success: true, user: publicUser(result.rows[0]) });
  }),

  /**
   * POST /api/admin/users/:id/unban
   *
   * Returns the user to their previous approval state. We reset to
   * `pending` rather than auto-approving, to make admins consciously
   * re-approve the account.
   */
  unbanUser: asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) throw new AppError('Invalid user id', 400, 'BAD_ID');

    const result = await pool.query(
      `UPDATE users
          SET status = 'pending',
              is_approved = FALSE,
              banned_at = NULL,
              banned_reason = NULL,
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${SAFE_USER_COLUMNS}`,
      [userId]
    );
    if (!result.rows[0]) throw new AppError('User not found', 404, 'NOT_FOUND');
    await recordAdminAction(req.user.id, userId, 'unban');
    return res.status(200).json({ success: true, user: publicUser(result.rows[0]) });
  }),

  /**
   * PUT /api/admin/users/:id/subscription
   *
   * Set the user's subscription. No payment system yet — admin grants
   * directly. Body: { plan, status, expiresAt, features }
   */
  setSubscription: asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) throw new AppError('Invalid user id', 400, 'BAD_ID');

    const { plan, status, expiresAt, features } = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;

    if (typeof plan === 'string') {
      if (!VALID_PLANS.has(plan)) throw new AppError('Invalid plan', 400, 'BAD_PLAN');
      updates.push(`subscription_plan = $${i++}`);
      values.push(plan);
    }
    if (typeof status === 'string') {
      if (!['inactive', 'active', 'expired', 'cancelled'].includes(status)) {
        throw new AppError('Invalid subscription status', 400, 'BAD_STATUS');
      }
      updates.push(`subscription_status = $${i++}`);
      values.push(status);
    }
    if (expiresAt === null) {
      updates.push('subscription_expires_at = NULL');
    } else if (typeof expiresAt === 'string' && expiresAt) {
      const d = new Date(expiresAt);
      if (Number.isNaN(d.getTime())) throw new AppError('Invalid expiresAt', 400, 'BAD_DATE');
      updates.push(`subscription_expires_at = $${i++}`);
      values.push(d.toISOString());
    }
    if (features && typeof features === 'object') {
      updates.push(`subscription_features = $${i++}::jsonb`);
      values.push(JSON.stringify(features));
    }

    if (updates.length === 0) {
      throw new AppError('Nothing to update', 400, 'BAD_REQUEST');
    }
    updates.push('updated_at = NOW()');
    values.push(userId);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i} RETURNING ${SAFE_USER_COLUMNS}`,
      values
    );
    if (!result.rows[0]) throw new AppError('User not found', 404, 'NOT_FOUND');

    await recordAdminAction(req.user.id, userId, 'subscription_update', {
      plan, status, expiresAt, features,
    });

    return res.status(200).json({ success: true, user: publicUser(result.rows[0]) });
  }),

  /**
   * GET /api/admin/users/:id/subscriptions
   *
   * Return all per-platform subscriptions for a user, plus a default
   * row for any platform the user doesn't have a row in yet.
   */
  listUserSubscriptions: asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) throw new AppError('Invalid user id', 400, 'BAD_ID');

    const r = await pool.query(
      `SELECT id, user_id, platform, plan, status, expires_at, features,
              trial_started_at, trial_expires_at, trial_used,
              created_at, updated_at
         FROM user_subscriptions
        WHERE user_id = $1
        ORDER BY platform`,
      [userId]
    );

    const byPlatform = {};
    for (const row of r.rows) byPlatform[row.platform] = row;

    const platforms = ['telegram', 'instagram'];
    const subs = platforms.map((p) => byPlatform[p] || {
      user_id: userId, platform: p, plan: null, status: 'inactive',
      expires_at: null, features: {}, trial_used: false,
    });

    return res.status(200).json({ success: true, subscriptions: subs });
  }),

  /**
   * PUT /api/admin/users/:id/subscriptions/:platform
   *
   * Upsert one platform's subscription row.
   * Body: { plan, status, expiresAt, features }
   */
  setUserPlatformSubscription: asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const platform = String(req.params.platform || '').toLowerCase();
    if (!Number.isFinite(userId)) throw new AppError('Invalid user id', 400, 'BAD_ID');
    if (!['telegram', 'instagram'].includes(platform)) {
      throw new AppError('Invalid platform', 400, 'BAD_PLATFORM');
    }
    const { plan, status, expiresAt, features } = req.body || {};
    if (plan != null && typeof plan === 'string' && !VALID_PLANS.has(plan)) {
      throw new AppError('Invalid plan', 400, 'BAD_PLAN');
    }
    if (status != null && !['inactive', 'active', 'expired', 'cancelled'].includes(status)) {
      throw new AppError('Invalid subscription status', 400, 'BAD_STATUS');
    }
    let expiresIso = null;
    if (expiresAt) {
      const d = new Date(expiresAt);
      if (Number.isNaN(d.getTime())) throw new AppError('Invalid expiresAt', 400, 'BAD_DATE');
      expiresIso = d.toISOString();
    }

    const featObj = (features && typeof features === 'object') ? features : {};

    const result = await pool.query(
      `INSERT INTO user_subscriptions
         (user_id, platform, plan, status, expires_at, features, created_at, updated_at)
       VALUES ($1, $2::platform_type, $3, $4, $5, $6::jsonb, NOW(), NOW())
       ON CONFLICT (user_id, platform) DO UPDATE
         SET plan        = EXCLUDED.plan,
             status      = EXCLUDED.status,
             expires_at  = EXCLUDED.expires_at,
             features    = EXCLUDED.features,
             updated_at  = NOW()
       RETURNING id, user_id, platform, plan, status, expires_at, features,
                 trial_started_at, trial_expires_at, trial_used, created_at, updated_at`,
      [userId, platform, plan || null, status || 'inactive', expiresIso, JSON.stringify(featObj)]
    );

    await recordAdminAction(req.user.id, userId, 'subscription_update', {
      platform, plan, status, expiresAt, features,
    });

    return res.status(200).json({ success: true, subscription: result.rows[0] });
  }),

  /**
   * DELETE /api/admin/users/:id
   *
   * Hard-delete: cascades to sessions, jobs etc. via FK.
   */
  deleteUser: asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) throw new AppError('Invalid user id', 400, 'BAD_ID');
    if (userId === req.user.id) {
      throw new AppError('Cannot delete yourself', 400, 'BAD_REQUEST');
    }
    const target = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    if (!target.rows[0]) throw new AppError('User not found', 404, 'NOT_FOUND');
    if (target.rows[0].role === 'admin') {
      throw new AppError('Cannot delete an admin', 400, 'BAD_REQUEST');
    }

    await recordAdminAction(req.user.id, userId, 'delete');
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    return res.status(200).json({ success: true });
  }),

  /**
   * GET /api/admin/stats
   */
  systemStats: asyncHandler(async (_req, res) => {
    const r = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM users) AS total_users,
         (SELECT COUNT(*)::int FROM users WHERE status = 'pending') AS pending_users,
         (SELECT COUNT(*)::int FROM users WHERE status = 'approved') AS approved_users,
         (SELECT COUNT(*)::int FROM users WHERE status = 'banned') AS banned_users,
         (SELECT COUNT(*)::int FROM users WHERE subscription_status = 'active') AS active_subscriptions,
         (SELECT COUNT(*)::int FROM sessions) AS total_sessions,
         (SELECT COUNT(*)::int FROM sessions WHERE is_logged_in = TRUE) AS active_sessions`
    );
    return res.status(200).json({ success: true, data: r.rows[0] });
  }),

  /**
   * GET /api/admin/actions  (recent admin audit log)
   */
  recentActions: asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const r = await pool.query(
      `SELECT a.id, a.action, a.reason, a.details, a.performed_at,
              au.email AS admin_email,
              tu.email AS target_email, tu.id AS target_user_id
         FROM admin_actions a
         JOIN users au ON au.id = a.admin_user_id
         JOIN users tu ON tu.id = a.target_user_id
         ORDER BY a.performed_at DESC
         LIMIT $1`,
      [limit]
    );
    return res.status(200).json({ success: true, data: { actions: r.rows } });
  }),
};

module.exports = adminController;
