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

// ---------------------------------------------------------------------
// Phase 3 — Instagram observability admin endpoints.
// ig-detection-events surfaces every checkpoint / feedback_required /
// action_blocked / cookie_missing event written by the IG provider.
// ig-risk returns a per-session 0..1 risk score driven by those events.
// ---------------------------------------------------------------------
router.get('/ig-detection-events', ctrl.listIgDetectionEvents);
router.get('/ig-risk',             ctrl.getIgRisk);

// ---------------------------------------------------------------------
// BYO Proxy — admin (Phase 2 §4.3). Regular users go through
// /api/me/proxies; this surface keeps the legacy shared pool plus the
// cross-user usage matrix only an admin should see.
// ---------------------------------------------------------------------
router.get('/proxies',         ctrl.listAdminProxies);
router.post('/proxies',        ctrl.addAdminProxy);
router.post('/proxies/refresh', ctrl.refreshAdminProxies);
router.get('/proxies/usage',   ctrl.adminProxyUsage);
router.delete('/proxies/:id',  ctrl.deleteAdminProxy);

// ---------------------------------------------------------------------
// Global proxy switch (system_settings.proxy.global_enabled). When OFF
// the panel drops every proxy and egresses directly from the VPS IP.
// ---------------------------------------------------------------------
router.get('/proxy/settings', ctrl.getProxySettings);
router.put('/proxy/settings', ctrl.setProxySettings);

module.exports = router;
