const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authenticate, requireApproved } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validator');

router.use(authenticate);
router.use(requireApproved);

// ---------------------------------------------------------------------
// Panel-wide reports (institutional-level)
//
// Mounted BEFORE the per-target /:id routes so URL paths like
// /sessions/summary / /messaging/summary aren't shadowed by the older
// "/session/:id" route family.
// ---------------------------------------------------------------------

// GET /api/reports/overview - Panel overview (KPIs + time series)
router.get('/overview', reportController.getOverview);

// GET /api/reports/sessions/summary - Per-session aggregated stats
router.get('/sessions/summary', reportController.getSessionsSummary);

// GET /api/reports/messaging/summary - Messaging jobs report
router.get('/messaging/summary', reportController.getMessagingSummary);

// GET /api/reports/scraping/summary - Scraping jobs report
router.get('/scraping/summary', reportController.getScrapingSummary);

// GET /api/reports/group-ops/summary - Group operations report
router.get('/group-ops/summary', reportController.getGroupOpsSummary);

// GET /api/reports/lists/summary - Lists report
router.get('/lists/summary', reportController.getListsSummary);

// GET /api/reports/export/overview - Export the panel overview as CSV/JSON
router.get('/export/overview', reportController.exportOverview);

// ---------------------------------------------------------------------
// Per-target reports (existing)
// ---------------------------------------------------------------------

// GET /api/reports/channel/:id - Channel report
router.get('/channel/:id', reportController.generateChannelReport);

// GET /api/reports/group/:id - Group report
router.get('/group/:id', reportController.generateGroupReport);

// GET /api/reports/user/:id - User report
router.get('/user/:id', reportController.generateUserReport);

// GET /api/reports/session/:id - Session report
router.get('/session/:id', reportController.generateSessionReport);

// GET /api/reports/saved - Saved reports
router.get('/saved', reportController.getSavedReports);

// GET /api/reports/saved/:id - Get saved report
router.get('/saved/:id', reportController.getReport);

// DELETE /api/reports/saved/:id - Delete saved report
router.delete('/saved/:id', reportController.deleteReport);

// POST /api/reports/save - Save report
router.post('/save', reportController.saveReport);

// POST /api/reports/export/:id - Export saved report
router.post('/export/:id', reportController.exportReport);

// GET /api/reports/activity - Activity log
router.get('/activity', reportController.getActivityLog);

module.exports = router;
