const express = require('express');
const router = express.Router();
const trackingBulkController = require('../controllers/trackingBulkController');
const { authenticate } = require('../middleware/auth');
const { attachTrackingMember, requireTrackingPermission } = require('../middleware/trackingAuth');
const { validate, schemas } = require('../middleware/validator');

router.use(authenticate);
router.use(attachTrackingMember);

router.post(
  '/delete',
  requireTrackingPermission('delete'),
  validate(schemas.trackingBulkIds),
  trackingBulkController.bulkDelete
);
router.post(
  '/status',
  requireTrackingPermission('edit'),
  validate(schemas.trackingBulkStatus),
  trackingBulkController.bulkStatusChange
);
router.post(
  '/assign',
  requireTrackingPermission('edit'),
  validate(schemas.trackingBulkAssign),
  trackingBulkController.bulkAssign
);
router.post(
  '/tags',
  requireTrackingPermission('edit'),
  validate(schemas.trackingBulkTag),
  trackingBulkController.bulkTag
);

module.exports = router;
