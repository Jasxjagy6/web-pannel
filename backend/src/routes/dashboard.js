const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /api/dashboard/stats - Dashboard stats
router.get('/stats', dashboardController.getStats);

// GET /api/dashboard/activity - Recent activity
router.get('/activity', dashboardController.getActivity);

// GET /api/dashboard/quick-actions - Quick actions
router.get('/quick-actions', dashboardController.getQuickActions);

module.exports = router;
