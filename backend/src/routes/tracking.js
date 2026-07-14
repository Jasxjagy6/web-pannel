const express = require('express');
const router = express.Router();
const trackingAccountController = require('../controllers/trackingAccountController');
const { authenticate } = require('../middleware/auth');
const { attachTrackingMember, requireTrackingPermission } = require('../middleware/trackingAuth');
const { validate, schemas } = require('../middleware/validator');
const { uploadTrackingFile } = require('../middleware/trackingUpload');

router.use(authenticate);
router.use(attachTrackingMember);

// GET /api/tracking/accounts
router.get('/accounts', requireTrackingPermission('view'), trackingAccountController.listAccounts);

// GET /api/tracking/accounts/:id
router.get('/accounts/:id', requireTrackingPermission('view'), trackingAccountController.getAccount);

// POST /api/tracking/accounts
router.post(
  '/accounts',
  requireTrackingPermission('edit'),
  validate(schemas.trackingAccountCreate),
  trackingAccountController.createAccount
);

// PUT /api/tracking/accounts/:id
router.put(
  '/accounts/:id',
  requireTrackingPermission('edit'),
  validate(schemas.trackingAccountUpdate),
  trackingAccountController.updateAccount
);

// DELETE /api/tracking/accounts/:id (soft delete)
router.delete('/accounts/:id', requireTrackingPermission('delete'), trackingAccountController.deleteAccount);

// POST /api/tracking/accounts/:id/restore
router.post('/accounts/:id/restore', requireTrackingPermission('delete'), trackingAccountController.restoreAccount);

// POST /api/tracking/accounts/:id/status
router.post(
  '/accounts/:id/status',
  requireTrackingPermission('edit'),
  validate(schemas.trackingStatusChange),
  trackingAccountController.changeStatus
);

// --- Session Information ---------------------------------------------
router.get('/accounts/:id/session', requireTrackingPermission('view'), trackingAccountController.getSession);
router.put(
  '/accounts/:id/session',
  requireTrackingPermission('edit'),
  validate(schemas.trackingSessionUpdate),
  trackingAccountController.updateSession
);
router.post(
  '/accounts/:id/session/file',
  requireTrackingPermission('edit'),
  uploadTrackingFile('file'),
  trackingAccountController.uploadSessionFile
);
router.post(
  '/accounts/:id/session/backup',
  requireTrackingPermission('edit'),
  uploadTrackingFile('file'),
  trackingAccountController.uploadBackupFile
);

// --- SIM Information -----------------------------------------------------
router.get('/accounts/:id/sim', requireTrackingPermission('view'), trackingAccountController.getSim);
router.put(
  '/accounts/:id/sim',
  requireTrackingPermission('edit'),
  validate(schemas.trackingSimUpdate),
  trackingAccountController.updateSim
);

// --- Security (encrypted) --------------------------------------------------
router.get(
  '/accounts/:id/security',
  requireTrackingPermission('view'),
  requireTrackingPermission('security'),
  trackingAccountController.getSecurity
);
router.put(
  '/accounts/:id/security',
  requireTrackingPermission('edit'),
  requireTrackingPermission('security'),
  validate(schemas.trackingSecurityUpdate),
  trackingAccountController.updateSecurity
);

// --- Purchase Information --------------------------------------------------
router.get('/accounts/:id/purchase', requireTrackingPermission('view'), trackingAccountController.getPurchase);
router.put(
  '/accounts/:id/purchase',
  requireTrackingPermission('edit'),
  validate(schemas.trackingPurchaseUpdate),
  trackingAccountController.updatePurchase
);

// --- Sales Tracking ----------------------------------------------------
router.get(
  '/accounts/:id/sales',
  requireTrackingPermission('view'),
  requireTrackingPermission('sales'),
  trackingAccountController.getSales
);
router.post(
  '/accounts/:id/sales',
  requireTrackingPermission('edit'),
  requireTrackingPermission('sales'),
  validate(schemas.trackingSaleCreate),
  trackingAccountController.addSale
);
router.put(
  '/accounts/:id/sales/:saleId',
  requireTrackingPermission('edit'),
  requireTrackingPermission('sales'),
  validate(schemas.trackingSaleUpdate),
  trackingAccountController.updateSale
);

// --- Assignments (append-only history) ----------------------------------
router.get('/accounts/:id/assignments', requireTrackingPermission('view'), trackingAccountController.getAssignments);
router.post(
  '/accounts/:id/assignments',
  requireTrackingPermission('edit'),
  validate(schemas.trackingAssignmentCreate),
  trackingAccountController.assign
);
router.post(
  '/accounts/:id/assignments/:assignmentId/return',
  requireTrackingPermission('edit'),
  trackingAccountController.returnAssignment
);

// --- Notes (unlimited, timestamped) -------------------------------------
router.get('/accounts/:id/notes', requireTrackingPermission('view'), trackingAccountController.getNotes);
router.post(
  '/accounts/:id/notes',
  requireTrackingPermission('edit'),
  validate(schemas.trackingNoteCreate),
  trackingAccountController.addNote
);

// --- Attachments ---------------------------------------------------------
router.get('/accounts/:id/attachments', requireTrackingPermission('view'), trackingAccountController.getAttachments);
router.post(
  '/accounts/:id/attachments',
  requireTrackingPermission('edit'),
  uploadTrackingFile('file'),
  trackingAccountController.uploadAttachment
);
router.get(
  '/accounts/:id/attachments/:attachmentId/download',
  requireTrackingPermission('view'),
  trackingAccountController.downloadAttachment
);
router.delete(
  '/accounts/:id/attachments/:attachmentId',
  requireTrackingPermission('edit'),
  trackingAccountController.deleteAttachment
);

// --- Tags (per-account assignment) ---------------------------------------
router.get('/accounts/:id/tags', requireTrackingPermission('view'), trackingAccountController.getAccountTags);
router.post(
  '/accounts/:id/tags',
  requireTrackingPermission('edit'),
  validate(schemas.trackingAccountTagsSet),
  trackingAccountController.addAccountTags
);
router.delete('/accounts/:id/tags/:tagId', requireTrackingPermission('edit'), trackingAccountController.removeAccountTag);

// --- Live Telegram session sync -----------------------------------------
// Sync ALL currently logged-in Telegram sessions into tracking. Declared
// before the :id route so "sync" isn't captured as an account id.
router.post('/sync/logged-in', requireTrackingPermission('edit'), trackingAccountController.syncAllLoggedIn);
// Re-sync a single tracking account from its linked session.
router.post('/accounts/:id/sync', requireTrackingPermission('edit'), trackingAccountController.syncAccount);

module.exports = router;
