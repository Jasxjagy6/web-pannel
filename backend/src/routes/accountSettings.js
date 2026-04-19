const express = require('express');
const router = express.Router();
const accountSettingsController = require('../controllers/accountSettingsController');
const { authenticate } = require('../middleware/auth');
const fileUpload = require('../middleware/fileUpload');

// All routes require authentication
router.use(authenticate);

// POST /api/account-settings/update - Update account settings for multiple sessions
router.post('/update', accountSettingsController.updateMultipleSessions);

// POST /api/account-settings/upload-photo - Upload profile photo
router.post('/upload-photo', fileUpload, accountSettingsController.uploadProfilePhoto);

// GET /api/account-settings/:sessionId - Get account settings for a session
router.get('/:sessionId', accountSettingsController.getAccountSettings);

module.exports = router;
