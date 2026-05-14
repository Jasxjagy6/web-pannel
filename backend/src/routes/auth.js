const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { validate, schemas } = require('../middleware/validator');

// POST /api/auth/register - Register
router.post('/register', authLimiter, validate(schemas.register), authController.register);

// POST /api/auth/login - Login
router.post('/login', authLimiter, validate(schemas.login), authController.login);

// POST /api/auth/refresh - Refresh token
router.post('/refresh', authenticate, authController.refreshToken);

// POST /api/auth/logout - Revoke the current JWT's auth_sessions row.
router.post('/logout', authenticate, authController.logout);

// GET /api/auth/profile - Get profile
router.get('/profile', authenticate, authController.getProfile);

// PUT /api/auth/profile - Update profile
router.put('/profile', authenticate, authController.updateProfile);

// POST /api/auth/change-password - Change password
router.post('/change-password', authenticate, authController.changePassword);

module.exports = router;
