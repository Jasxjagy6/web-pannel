const express = require('express');
const router = express.Router();
const sessionController = require('../controllers/sessionController');
const { authenticate } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimiter');
const { uploadMultiple } = require('../middleware/upload');

// Apply auth middleware to all routes
router.use(authenticate);

// POST /api/sessions/upload - Upload session files
router.post('/upload', uploadLimiter, uploadMultiple('sessions', 1000), sessionController.uploadSessions);

// GET /api/sessions - List sessions
router.get('/', sessionController.listSessions);

// GET /api/sessions/stats - Get session stats
router.get('/stats', sessionController.getSessionStats);

// POST /api/sessions/bulk-delete - Bulk delete
router.post('/bulk-delete', sessionController.bulkDeleteSessions);

// GET /api/sessions/:id - Get session
router.get('/:id', sessionController.getSession);

// POST /api/sessions/:id/login - Login session
router.post('/:id/login', sessionController.loginSession);

// POST /api/sessions/:id/logout - Logout session
router.post('/:id/logout', sessionController.logoutSession);

// GET /api/sessions/:id/status - Check status
router.get('/:id/status', sessionController.checkSessionStatus);

// DELETE /api/sessions/:id - Delete session
router.delete('/:id', sessionController.deleteSession);

module.exports = router;
