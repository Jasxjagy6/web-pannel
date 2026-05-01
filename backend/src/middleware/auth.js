const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');

/**
 * Verify the JWT, hydrate req.user from the live `users` row.
 *
 * We always re-read the database so a banned / un-approved user can't
 * keep using a JWT that was issued before the admin's action.
 */
const authenticate = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError('No token provided', 401, 'AUTH_REQUIRED');
  }
  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError('Token expired', 401, 'TOKEN_EXPIRED');
    }
    throw new AppError('Invalid token', 401, 'INVALID_TOKEN');
  }

  const result = await pool.query(
    `SELECT id, email, role, status, is_approved,
            subscription_plan, subscription_status, subscription_expires_at,
            subscription_features
       FROM users
      WHERE id = $1`,
    [decoded.userId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('User not found', 401, 'USER_NOT_FOUND');
  }

  req.user = {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    isApproved: row.is_approved,
    subscriptionPlan: row.subscription_plan,
    subscriptionStatus: row.subscription_status,
    subscriptionExpiresAt: row.subscription_expires_at,
    subscriptionFeatures: row.subscription_features || {},
  };
  next();
});

/**
 * Allow only the listed roles to proceed.
 */
const authorize = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    throw new AppError('Insufficient permissions', 403, 'FORBIDDEN');
  }
  next();
};

const requireAdmin = (req, _res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    throw new AppError('Admin access required', 403, 'ADMIN_REQUIRED');
  }
  next();
};

/**
 * Block any non-admin user that hasn't been approved by an admin yet,
 * or whose account is banned. Mounted on every "feature" route family
 * (sessions, scrape, messaging, …) so the same check exists on the
 * server even if the frontend forgets to gate the page.
 */
const requireApproved = (req, _res, next) => {
  if (!req.user) {
    throw new AppError('Auth required', 401, 'AUTH_REQUIRED');
  }
  if (req.user.role === 'admin') return next();
  if (req.user.status === 'banned') {
    throw new AppError('Account is banned', 403, 'ACCOUNT_BANNED');
  }
  if (req.user.status !== 'approved' || !req.user.isApproved) {
    throw new AppError(
      'Account is pending admin approval',
      403,
      'NOT_APPROVED'
    );
  }
  next();
};

const optionalAuth = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      `SELECT id, email, role, status, is_approved
         FROM users WHERE id = $1`,
      [decoded.userId]
    );
    if (result.rows.length === 0) {
      req.user = null;
    } else {
      const row = result.rows[0];
      req.user = {
        id: row.id,
        email: row.email,
        role: row.role,
        status: row.status,
        isApproved: row.is_approved,
      };
    }
  } catch {
    req.user = null;
  }
  next();
});

module.exports = {
  authenticate,
  authorize,
  requireAdmin,
  requireApproved,
  optionalAuth,
};
