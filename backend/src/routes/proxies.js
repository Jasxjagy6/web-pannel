/**
 * /api/proxies — legacy admin-pool router.
 *
 * BYO Proxy, Phase 2 (BYO_PROXY_PROPOSAL §4.2):
 *   - Regular user CRUD now lives at /api/me/proxies.
 *   - The shared-admin pool (free/manual rows with `user_id IS NULL`)
 *     is still reachable here, but ONLY to admins. The duplicated
 *     /api/admin/proxies routes (mounted in routes/admin.js) are the
 *     canonical surface for new clients; this router stays as a
 *     short-term compatibility shim for older frontends mid-deploy.
 */
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/proxyController');
const { authenticate, requireAdmin } = require('../middleware/auth');

router.use(authenticate);
router.use(requireAdmin);

router.get('/', ctrl.listProxies);
router.post('/', ctrl.addProxy);
router.post('/refresh', ctrl.refresh);
router.delete('/:id', ctrl.deleteProxy);

module.exports = router;
