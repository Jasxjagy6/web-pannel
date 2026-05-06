const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/instagramIdentityController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

router.get('/:sessionId', ctrl.get);
router.post('/:sessionId/rotate', ctrl.rotate);

module.exports = router;
