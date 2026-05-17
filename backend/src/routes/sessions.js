const express = require('express');
const router = express.Router();
const sessionController = require('../controllers/sessionController');
const cloneExportController = require('../controllers/sessionDuplicationController');
const bulkLoginController = require('../controllers/sessionBulkLoginController');
const bulkAuthPurgeController = require('../controllers/sessionBulkAuthPurgeController');
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

// QR-Login-Token clone export. Selected sessions get a *new*
// authorization via auth.ExportLoginToken / AcceptLoginToken /
// ImportLoginToken; the new auth_keys are packaged as .session +
// .json inside a ZIP the operator can download. Original panel
// sessions are unaffected — both authorizations live in parallel.
// Mounted before /:id so the `clone-export` literal isn't shadowed.
router.post('/clone-export/start', cloneExportController.start);
router.get('/clone-export/:jobId/status', cloneExportController.status);
router.post('/clone-export/:jobId/password', cloneExportController.submitPassword);
router.post('/clone-export/:jobId/cancel', cloneExportController.cancel);
router.get('/clone-export/:jobId/download', cloneExportController.download);

// Bulk-login job runner. Mirrors the clone-export job shape so the
// frontend can render an identical job-progress modal. Mounted
// before /:id so the `bulk-login` literal isn't shadowed by the
// param matcher.
router.post('/bulk-login/start', bulkLoginController.start);
router.get('/bulk-login/:jobId/status', bulkLoginController.status);
router.post('/bulk-login/:jobId/cancel', bulkLoginController.cancel);

// Bulk auth-purge job runner. For each selected panel session,
// enumerates account.GetAuthorizations() and terminates every
// non-current device with account.ResetAuthorization(hash). The
// panel's own login is preserved on every row. Mounted before /:id
// so the `bulk-auth-purge` literal isn't shadowed by the param
// matcher.
router.post('/bulk-auth-purge/preview', bulkAuthPurgeController.preview);
router.post('/bulk-auth-purge/start', bulkAuthPurgeController.start);
router.get('/bulk-auth-purge/:jobId/status', bulkAuthPurgeController.status);
router.post('/bulk-auth-purge/:jobId/cancel', bulkAuthPurgeController.cancel);

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

// POST /api/sessions/:id/recover - Anti-revoke Phase 4: re-import a
// session that was marked status='revoked' (re-loads the encrypted
// session file or its newest backup, runs getMe, flips the row back
// to active if the auth key is still good).
router.post('/:id/recover', sessionController.recoverSession);

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
