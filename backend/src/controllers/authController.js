const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const SAFE_USER_COLUMNS = `
  id, email, role, status, is_approved, approved_at,
  banned_at, banned_reason,
  subscription_plan, subscription_status, subscription_expires_at,
  subscription_features,
  notes, created_at, updated_at, last_login
`;

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    isApproved: row.is_approved,
    approvedAt: row.approved_at,
    bannedAt: row.banned_at,
    bannedReason: row.banned_reason,
    subscription: {
      plan: row.subscription_plan,
      status: row.subscription_status,
      expiresAt: row.subscription_expires_at,
      features: row.subscription_features || {},
    },
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLogin: row.last_login,
  };
}

function generateToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '7d' }
  );
}

const authController = {
  /**
   * Register a new user. Email + password only — no email OTP yet.
   * New accounts land in `status='pending'` and cannot use any feature
   * until an admin approves them via /api/admin/users/:id/approve.
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
      `INSERT INTO users (email, password_hash, role, status, is_approved,
                          subscription_status, created_at, updated_at)
       VALUES ($1, $2, 'user', 'pending', FALSE, 'inactive', NOW(), NOW())
       RETURNING ${SAFE_USER_COLUMNS}`,
      [email, passwordHash]
    );
    const user = result.rows[0];

    logger.info('User registered', { userId: user.id, email });

    const token = generateToken(user);
    return res.status(201).json({
      success: true,
      token,
      user: publicUser(user),
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

    const token = generateToken(user);
    logger.info('User logged in', { userId: user.id, email: user.email, role: user.role });

    return res.status(200).json({
      success: true,
      token,
      user: publicUser(user),
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
    const token = generateToken(user);
    return res.status(200).json({ success: true, token, user: publicUser(user) });
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
    return res.status(200).json({ success: true, user: publicUser(user) });
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
    return res.status(200).json({ success: true, user: publicUser(result.rows[0]) });
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
