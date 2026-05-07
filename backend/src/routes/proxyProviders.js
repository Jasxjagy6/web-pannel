/**
 * /api/me/proxy-providers — auto-rotating proxy provider configuration.
 */

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/proxyProviderController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
// Same entitlement gate as BYO proxies — operators on the trial plan
// can't configure auto-rotating providers without it being enabled.
router.use(requireApproved('byo_proxy'));

router.get('/vendors', ctrl.vendors);
router.get('/', ctrl.list);
router.post('/', ctrl.add);
router.patch('/:id', ctrl.update);
router.post('/:id/test', ctrl.test);
router.delete('/:id', ctrl.remove);

module.exports = router;
