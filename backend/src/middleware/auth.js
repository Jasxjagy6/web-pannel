const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');

const authenticate = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError('No token provided', 401, 'AUTH_REQUIRED');
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // For single-admin mode, the JWT already contains email and role.
    // Skip database lookup if this is the admin (no DB user needed).
    if (decoded.role === 'admin') {
      req.user = {
        id: decoded.userId,
        email: decoded.email,
        role: decoded.role,
      };
      return next();
    }

    // For multi-user mode (if ever needed), fall back to DB lookup.
    const result = await pool.query('SELECT id, email, role FROM users WHERE id = $1', [
      decoded.userId,
    ]);

    if (result.rows.length === 0) {
      throw new AppError('User not found', 401, 'USER_NOT_FOUND');
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      throw new AppError('Invalid token', 401, 'INVALID_TOKEN');
    }
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError('Token expired', 401, 'TOKEN_EXPIRED');
    }
    throw error;
  }
});

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      throw new AppError('Insufficient permissions', 403, 'FORBIDDEN');
    }
    next();
  };
};

const optionalAuth = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role === 'admin') {
      req.user = {
        id: decoded.userId,
        email: decoded.email,
        role: decoded.role,
      };
      return next();
    }

    const result = await pool.query('SELECT id, email, role FROM users WHERE id = $1', [
      decoded.userId,
    ]);

    if (result.rows.length > 0) {
      req.user = result.rows[0];
    } else {
      req.user = null;
    }
  } catch (error) {
    req.user = null;
  }

  next();
});

module.exports = {
  authenticate,
  authorize,
  optionalAuth,
};
