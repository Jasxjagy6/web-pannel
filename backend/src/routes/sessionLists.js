const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/sessionListController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

// CRUD on session lists.
router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.get('/:id', ctrl.get);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

// Membership management.
router.get('/:id/sessions', ctrl.getSessions);
router.post('/:id/sessions', ctrl.addSessions);
router.delete('/:id/sessions', ctrl.removeSessions);
router.put('/:id/sessions', ctrl.setSessions);

// Bulk download as a ZIP archive of plain (decrypted) session files.
// `?format=json` (default) or `?format=session`.
router.get('/:id/download', ctrl.download);

module.exports = router;
