const jwt = require('jsonwebtoken');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const authController = {
  /**
   * Authenticate the single admin against .env credentials.
   * No database lookup - credentials are stored in ADMIN_EMAIL and ADMIN_PASSWORD.
   */
  login: asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminEmail || !adminPassword) {
      logger.error('Admin credentials not configured in .env');
      throw new AppError('Server configuration error', 500, 'CONFIG_ERROR');
    }

    if (email !== adminEmail || password !== adminPassword) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    // Generate JWT token for the admin
    const token = generateToken({ email: adminEmail });

    logger.info('Admin logged in', { email: adminEmail });

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: 1,
        email: adminEmail,
        role: 'admin',
      },
    });
  }),

  /**
   * Registration is disabled for single-admin mode.
   */
  register: asyncHandler(async (_req, res) => {
    throw new AppError('Registration is disabled. Contact the administrator.', 403, 'REGISTRATION_DISABLED');
  }),

  /**
   * Refresh the current JWT token.
   */
  refreshToken: asyncHandler(async (req, res) => {
    const { userId, email, role } = req.user;

    const token = generateToken({ id: userId, email, role });

    return res.status(200).json({
      success: true,
      token,
    });
  }),

  /**
   * Return the profile of the currently authenticated admin.
   */
  getProfile: asyncHandler(async (req, res) => {
    return res.status(200).json({
      success: true,
      user: {
        id: 1,
        email: req.user.email,
        role: 'admin',
        createdAt: null,
        lastLogin: null,
        updatedAt: null,
      },
    });
  }),

  /**
   * Update profile is disabled for single-admin mode.
   * Edit credentials directly in the .env file.
   */
  updateProfile: asyncHandler(async (_req, res) => {
    throw new AppError('Profile updates are disabled. Edit credentials in the .env file.', 403, 'PROFILE_UPDATE_DISABLED');
  }),

  /**
   * Change password is disabled for single-admin mode.
   * Edit the ADMIN_PASSWORD directly in the .env file.
   */
  changePassword: asyncHandler(async (_req, res) => {
    throw new AppError('Password changes are disabled. Edit ADMIN_PASSWORD in the .env file.', 403, 'PASSWORD_CHANGE_DISABLED');
  }),
};

/**
 * Generate a JWT token for the admin.
 */
function generateToken(user) {
  return jwt.sign(
    { userId: user.id || 1, email: user.email, role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '7d' }
  );
}

module.exports = authController;
