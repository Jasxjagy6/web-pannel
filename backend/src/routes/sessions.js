const express = require('express');
const router = express.Router();
const sessionController = require('../controllers/sessionController');
const { authenticate, requireApproved } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimiter');
const { uploadMultiple } = require('../middleware/upload');

// Apply auth middleware to all routes
router.use(authenticate);
router.use(requireApproved);

// POST /api/sessions/upload - Upload session files
router.post('/upload', uploadLimiter, uploadMultiple('sessions', 1000), sessionController.uploadSessions);

// Upgrade 5 — interactive create-session flow.
// Mounted before the `/:id` routes so the `create` literal isn't shadowed
// by the param matcher.
router.post('/create/start', sessionController.createSessionStart);
router.post('/create/verify', sessionController.createSessionVerify);
router.post('/create/password', sessionController.createSessionPassword);
router.post('/create/resend', sessionController.createSessionResend);
router.post('/create/cancel', sessionController.createSessionCancel);

// GET /api/sessions - List sessions
router.get('/', sessionController.listSessions);

// GET /api/sessions/stats - Get session stats
router.get('/stats', sessionController.getSessionStats);

// POST /api/sessions/bulk-delete - Bulk delete
router.post('/bulk-delete', sessionController.bulkDeleteSessions);

// GET /api/sessions/:id - Get session
router.get('/:id', sessionController.getSession);

// GET /api/sessions/:id/download - Download the plaintext session JSON file
router.get('/:id/download', sessionController.downloadSession);

// POST /api/sessions/:id/login - Login session
router.post('/:id/login', sessionController.loginSession);

// POST /api/sessions/:id/logout - Logout session
router.post('/:id/logout', sessionController.logoutSession);

// GET /api/sessions/:id/status - Check status
router.get('/:id/status', sessionController.checkSessionStatus);

// DELETE /api/sessions/:id - Delete session
router.delete('/:id', sessionController.deleteSession);

// --- Instagram-only session-health surface ---
// These routes are mounted under both /api/sessions and /api/instagram/sessions
// (the platform middleware filters non-IG calls 404). Telegram sessions
// don't expose them.
//
// GET   /:id/health           — last warm-up state + recent log
// POST  /:id/health/check     — run an on-demand probe via the bound proxy
// PATCH /:id/proxy            — set/clear the per-session proxy URL
router.get('/:id/health', sessionController.getSessionHealth);
router.post('/:id/health/check', sessionController.runSessionHealthCheck);
router.patch('/:id/proxy', sessionController.setSessionProxy);

module.exports = router;
