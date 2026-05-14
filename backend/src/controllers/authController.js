const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');
const subscriptionService = require('../services/subscriptionService');
const authSessionService = require('../services/authSessionService');

const SAFE_USER_COLUMNS = `
  id, email, role, status, is_approved, approved_at,
  banned_at, banned_reason,
  subscription_plan, subscription_status, subscription_expires_at,
  subscription_features,
  trial_started_at, trial_expires_at, trial_used,
  notes, created_at, updated_at, last_login
`;

function publicUser(row, extras = {}) {
  if (!row) return null;
  // Build the canonical multi-platform snapshot from subscriptionService so
  // the response shape matches /billing/status. The legacy `subscription`
  // and `trial` keys mirror the telegram row for one release cycle.
  const snap = subscriptionService.userPublicSnapshot(row, extras.subsByPlatform);
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    isApproved: row.is_approved,
    approvedAt: row.approved_at,
    bannedAt: row.banned_at,
    bannedReason: row.banned_reason,
    subscription: snap?.subscription || {
      plan: row.subscription_plan,
      status: row.subscription_status,
      expiresAt: row.subscription_expires_at,
      features: row.subscription_features || {},
    },
    trial: snap?.trial || {
      startedAt: row.trial_started_at || null,
      expiresAt: row.trial_expires_at || null,
      used: !!row.trial_used,
    },
    subscriptions: snap?.subscriptions,
    // v8: tells the frontend whether to show the "set up your API ID
    // and Hash in Settings" popup. We always populate this — it's
    // computed in getProfile / login / refresh — so the AuthContext
    // doesn't have to fire a second request.
    apiCredentialsCount: extras.apiCredentialsCount ?? null,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLogin: row.last_login,
  };
}

async function countApiCredentials(userId) {
  if (!userId) return 0;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM user_api_credentials
        WHERE user_id = $1 AND deleted_at IS NULL AND is_active = TRUE`,
      [userId]
    );
    return r.rows[0]?.n || 0;
  } catch {
    // If the table doesn't exist yet (migrations haven't run),
    // return 0 so we don't break login.
    return 0;
  }
}

/**
 * Issue a fresh JWT for `user` and record the matching auth_sessions row
 * so it can be revoked later (logout, env rotation, admin force-logout).
 *
 * The jti claim embedded in the JWT is the auth_sessions.jti UUID; the
 * middleware looks it up on every authenticated request. Sessions whose
 * row has been revoked stop authenticating immediately even though the
 * JWT itself is still cryptographically valid.
 */
async function generateToken(user, req) {
  const session = await authSessionService.createSession(user.id, req);
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role, jti: session.jti },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '7d' }
  );
}

const authController = {
  /**
   * Register a new user. Email + password only.
   *
   * v8: admin approval is removed — new accounts land in
   * `status='approved', is_approved=TRUE` immediately and the
   * frontend redirects them to /billing where they can either start
   * the free trial or pay. Subscription / API-credentials gating is
   * still applied by `requireApproved` so they can't actually use
   * any feature route until they finish billing + add their
   * Telegram API ID / Hash in Settings.
   */
  register: asyncHandler(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
      throw new AppError('Email and password are required', 400, 'BAD_REQUEST');
    }
    if (password.length < 8) {
      throw new AppError('Password must be at least 8 characters', 400, 'WEAK_PASSWORD');
    }

    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
    if (existing.rows.length > 0) {
      throw new AppError('An account with that email already exists', 409, 'EMAIL_TAKEN');
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role, status, is_approved, approved_at,
                          subscription_status, created_at, updated_at)
       VALUES ($1, $2, 'user', 'approved', TRUE, NOW(), 'inactive', NOW(), NOW())
       RETURNING ${SAFE_USER_COLUMNS}`,
      [email, passwordHash]
    );
    const user = result.rows[0];

    logger.info('User registered', { userId: user.id, email });

    const token = await generateToken(user, req);
    // Brand-new user has 0 credentials by definition; skip the count
    // query and ship the response immediately. No subscriptions yet either.
    const subsByPlatform = await subscriptionService.loadSubscriptions(user.id);
    return res.status(201).json({
      success: true,
      token,
      user: publicUser(user, { apiCredentialsCount: 0, subsByPlatform }),
    });
  }),

  /**
   * Login. Accepts admin and regular users alike — both go through the
   * same bcrypt + DB lookup path so a banned user's existing JWT stops
   * working as soon as they try the next request.
   */
  login: asyncHandler(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
      throw new AppError('Email and password are required', 400, 'BAD_REQUEST');
    }

    const result = await pool.query(
      `SELECT id, email, password_hash, role, status, is_approved
         FROM users WHERE LOWER(email) = $1`,
      [email]
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    if (row.status === 'banned') {
      throw new AppError('Account is banned', 403, 'ACCOUNT_BANNED');
    }

    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [row.id]);

    // Reload full row for the public payload.
    const fullResult = await pool.query(
      `SELECT ${SAFE_USER_COLUMNS} FROM users WHERE id = $1`,
      [row.id]
    );
    const user = fullResult.rows[0];

    const token = await generateToken(user, req);
    const apiCredentialsCount = await countApiCredentials(user.id);
    const subsByPlatform = await subscriptionService.loadSubscriptions(user.id);
    logger.info('User logged in', { userId: user.id, email: user.email, role: user.role });

    return res.status(200).json({
      success: true,
      token,
      user: publicUser(user, { apiCredentialsCount, subsByPlatform }),
    });
  }),

  /**
   * Refresh the current JWT token.
   */
  refreshToken: asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT ${SAFE_USER_COLUMNS} FROM users WHERE id = $1`,
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) {
      throw new AppError('User not found', 401, 'USER_NOT_FOUND');
    }
    if (user.status === 'banned') {
      throw new AppError('Account is banned', 403, 'ACCOUNT_BANNED');
    }
    // Revoke the previous session row before issuing the refreshed one
    // so refresh isn't a vector for stockpiling active sessions.
    if (req.authSession?.jti) {
      await authSessionService.revokeByJti(req.authSession.jti, 'refresh');
    }
    const token = await generateToken(user, req);
    const apiCredentialsCount = await countApiCredentials(user.id);
    const subsByPlatform = await subscriptionService.loadSubscriptions(user.id);
    return res.status(200).json({
      success: true,
      token,
      user: publicUser(user, { apiCredentialsCount, subsByPlatform }),
    });
  }),

  /**
   * Revoke the current JWT's auth_sessions row. After this call the
   * same JWT will fail authentication on subsequent requests with
   * INVALID_TOKEN, which is what the frontend's response interceptor
   * uses to redirect the user to /login.
   */
  logout: asyncHandler(async (req, res) => {
    if (req.authSession?.jti) {
      await authSessionService.revokeByJti(req.authSession.jti, 'logout');
    }
    return res.status(200).json({ success: true });
  }),

  /**
   * Return the profile of the currently authenticated user.
   */
  getProfile: asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT ${SAFE_USER_COLUMNS} FROM users WHERE id = $1`,
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) {
      throw new AppError('User not found', 401, 'USER_NOT_FOUND');
    }
    const apiCredentialsCount = await countApiCredentials(user.id);
    const subsByPlatform = await subscriptionService.loadSubscriptions(user.id);
    return res.status(200).json({
      success: true,
      user: publicUser(user, { apiCredentialsCount, subsByPlatform }),
    });
  }),

  /**
   * Update profile (currently just notes/email change for self).
   */
  updateProfile: asyncHandler(async (req, res) => {
    const updates = [];
    const values = [];
    let i = 1;

    if (typeof req.body.email === 'string' && req.body.email.trim()) {
      const newEmail = req.body.email.trim().toLowerCase();
      const taken = await pool.query(
        'SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2',
        [newEmail, req.user.id]
      );
      if (taken.rows.length > 0) {
        throw new AppError('Email already in use', 409, 'EMAIL_TAKEN');
      }
      updates.push(`email = $${i++}`);
      values.push(newEmail);
    }

    if (updates.length === 0) {
      throw new AppError('Nothing to update', 400, 'BAD_REQUEST');
    }
    updates.push(`updated_at = NOW()`);
    values.push(req.user.id);

    await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i}`,
      values
    );

    const result = await pool.query(
      `SELECT ${SAFE_USER_COLUMNS} FROM users WHERE id = $1`,
      [req.user.id]
    );
    const apiCredentialsCount = await countApiCredentials(req.user.id);
    const subsByPlatform = await subscriptionService.loadSubscriptions(req.user.id);
    return res.status(200).json({
      success: true,
      user: publicUser(result.rows[0], { apiCredentialsCount, subsByPlatform }),
    });
  }),

  /**
   * Change own password.
   */
  changePassword: asyncHandler(async (req, res) => {
    const oldPassword = String(req.body.oldPassword || '');
    const newPassword = String(req.body.newPassword || '');
    if (!oldPassword || !newPassword) {
      throw new AppError('Old and new password required', 400, 'BAD_REQUEST');
    }
    if (newPassword.length < 8) {
      throw new AppError('Password must be at least 8 characters', 400, 'WEAK_PASSWORD');
    }

    const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!r.rows[0]) {
      throw new AppError('User not found', 401, 'USER_NOT_FOUND');
    }
    const ok = await bcrypt.compare(oldPassword, r.rows[0].password_hash);
    if (!ok) {
      throw new AppError('Old password is incorrect', 401, 'INVALID_CREDENTIALS');
    }
    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, req.user.id]
    );
    return res.status(200).json({ success: true });
  }),
};

module.exports = authController;
module.exports.publicUser = publicUser;
module.exports.generateToken = generateToken;
module.exports.SAFE_USER_COLUMNS = SAFE_USER_COLUMNS;
