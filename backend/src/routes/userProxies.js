/**
 * /api/me/proxies — BYO Proxy user-scoped routes (Phase 2).
 *
 * The `byo_proxy` feature gate is enforced via the standard
 * subscription/entitlement middleware. By default `byo_proxy` is NOT
 * in `billing.trial_allowed_features` so trial users see a 402
 * TRIAL_FEATURE_NOT_ALLOWED. Operators can flip this on per-platform
 * via the `system_settings` table.
 */

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/userProxyController');
const { authenticate, requireApproved } = require('../middleware/auth');
const multer = require('multer');

const proxyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

router.use(authenticate);
router.use(requireApproved('byo_proxy'));

router.get('/', ctrl.list);
router.post('/', ctrl.add);
router.post('/import', proxyUpload.single('file'), ctrl.import);
router.post('/recheck', ctrl.recheckAll);
router.patch('/:id', ctrl.update);
router.post('/:id/test', ctrl.test);
router.post('/:id/bind/:sessionId', ctrl.bind);
router.delete('/:id', ctrl.remove);

module.exports = router;
