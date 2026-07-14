const express = require('express');
const router = express.Router();
const trackingImportExportController = require('../controllers/trackingImportExportController');
const { authenticate } = require('../middleware/auth');
const { attachTrackingMember, requireTrackingPermission } = require('../middleware/trackingAuth');
const { uploadTrackingFile } = require('../middleware/trackingUpload');

router.use(authenticate);
router.use(attachTrackingMember);

router.post('/import', requireTrackingPermission('edit'), uploadTrackingFile('file'), trackingImportExportController.importAccounts);
router.post(
  '/import-sessions-zip',
  requireTrackingPermission('edit'),
  uploadTrackingFile('file'),
  trackingImportExportController.importSessionZip
);
router.get('/export', requireTrackingPermission('export'), trackingImportExportController.exportAccounts);
router.get('/template', requireTrackingPermission('view'), trackingImportExportController.downloadTemplate);

module.exports = router;
