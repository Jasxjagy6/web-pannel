/**
 * Routes for the Login Email feature.
 *
 * Mounted at /api/privacy/login-email (see index.js / privacy.js).
 */

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/loginEmailController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

// Well-known IMAP providers list
router.get('/providers', ctrl.providers);

// Manual flow: send code → user enters code → verify
router.post('/send-code', ctrl.sendCode);
router.post('/verify-code', ctrl.verifyCode);

// Per-session login email status check
router.get('/status/:sessionId', ctrl.getStatus);

// Test IMAP connection
router.post('/test-imap', ctrl.testImap);

// Automated bulk flow
router.post('/bulk/start', ctrl.bulkStart);
router.get('/bulk/:jobId/status', ctrl.bulkStatus);
router.post('/bulk/:jobId/cancel', ctrl.bulkCancel);

module.exports = router;
