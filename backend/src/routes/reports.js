const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authenticate, requireApproved } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validator');

router.use(authenticate);
router.use(requireApproved);

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

// POST /api/reports/export/:id - Export report
router.post('/export/:id', reportController.exportReport);

// GET /api/reports/activity - Activity log
router.get('/activity', reportController.getActivityLog);

module.exports = router;
