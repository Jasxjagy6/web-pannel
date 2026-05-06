const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/instagramTwoFactorController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

router.get('/:sessionId', ctrl.status);
router.post('/:sessionId/enable', ctrl.enable);
router.post('/:sessionId/disable', ctrl.disable);
router.post('/:sessionId/rotate', ctrl.rotate);

module.exports = router;
