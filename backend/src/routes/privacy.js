const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/privacyController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

router.get('/keys', ctrl.keys);
router.post('/jobs', ctrl.createJob);
router.get('/jobs', ctrl.listJobs);
router.get('/jobs/:id', ctrl.getJob);
router.get('/jobs/:id/items', ctrl.getJobItems);
router.post('/jobs/:id/cancel', ctrl.cancelJob);

router.post('/email/send-code', ctrl.sendEmailCode);
router.post('/email/verify-code', ctrl.verifyEmailCode);

// Login email sub-router — full redesign of the login-email-on-session
// feature with automated IMAP OTP reading for bulk operations.
const loginEmailRoutes = require('./loginEmail');
router.use('/login-email', loginEmailRoutes);

// Instagram-specific per-account privacy. The handlers themselves
// reject non-IG platforms with 400 WRONG_PLATFORM, so it's safe to
// mount them on the shared router (the legacy /api/privacy alias
// stays Telegram-only because req.platform defaults to 'telegram').
router.get('/account/:sessionId', ctrl.getInstagramPrivacy);
router.patch('/account/:sessionId', ctrl.setInstagramPrivacy);

module.exports = router;
