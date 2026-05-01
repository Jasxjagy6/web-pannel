const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/antiDetectController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

router.get('/status', ctrl.status);
router.get('/identities', ctrl.listIdentities);
router.get('/identity/:sessionId', ctrl.getIdentity);
router.post('/identity/:sessionId/rotate', ctrl.rotateIdentity);
router.get('/logs', ctrl.listLogs);
router.post('/warmup/run', ctrl.runTick);
router.post('/warmup/:sessionId', ctrl.runForSession);

module.exports = router;
