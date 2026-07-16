const express = require('express');
const router = express.Router();
const trackingDashboardController = require('../controllers/trackingDashboardController');
const { authenticate } = require('../middleware/auth');
const { attachTrackingMember, requireTrackingPermission } = require('../middleware/trackingAuth');

router.use(authenticate);
router.use(attachTrackingMember);
router.use(requireTrackingPermission('view'));

router.get('/stats', trackingDashboardController.getStats);
router.get('/charts', trackingDashboardController.getCharts);
router.get('/recent', trackingDashboardController.getRecent);
router.get('/alerts', trackingDashboardController.getAlerts);

module.exports = router;
