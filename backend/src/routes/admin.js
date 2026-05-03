const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/adminController');
const billing = require('../controllers/billingController');
const { authenticate, requireAdmin } = require('../middleware/auth');

router.use(authenticate);
router.use(requireAdmin);

router.get('/stats', ctrl.systemStats);
router.get('/actions', ctrl.recentActions);

router.get('/users', ctrl.listUsers);
router.get('/users/:id', ctrl.getUser);
router.delete('/users/:id', ctrl.deleteUser);
router.post('/users/:id/approve', ctrl.approveUser);
router.post('/users/:id/ban', ctrl.banUser);
router.post('/users/:id/unban', ctrl.unbanUser);
router.put('/users/:id/subscription', ctrl.setSubscription);

// Per-platform subscription editor (used by the multi-platform admin UI).
// GET returns one row per platform (creates synthetic 'inactive' rows for
// platforms the user has no record on yet); PUT upserts a single platform.
router.get('/users/:id/subscriptions', ctrl.listUserSubscriptions);
router.put('/users/:id/subscriptions/:platform', ctrl.setUserPlatformSubscription);

// ---------------------------------------------------------------------
// Billing admin endpoints
// ---------------------------------------------------------------------
router.get('/billing/settings',  billing.adminGetSettings);
router.put('/billing/settings',  billing.adminSetSettings);

router.get('/billing/invoices',           billing.adminListInvoices);
router.get('/billing/users/:id/invoices', billing.adminGetUserInvoices);

router.post('/billing/users/:id/grant',  billing.adminGrantSubscription);
router.post('/billing/users/:id/expire', billing.adminExpireSubscription);

// ---------------------------------------------------------------------
// Telegram anti-revoke admin endpoints (Phase 3 §B17/B18)
// ---------------------------------------------------------------------
router.get('/tg-detection-events', ctrl.tgDetectionEvents);
router.get('/tg-risk',             ctrl.tgRisk);
router.get('/tg-session-health',   ctrl.tgSessionHealth);

module.exports = router;
