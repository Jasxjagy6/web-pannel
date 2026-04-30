const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/proxyController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/', ctrl.listProxies);
router.post('/', ctrl.addProxy);
router.post('/refresh', ctrl.refresh);
router.delete('/:id', ctrl.deleteProxy);

module.exports = router;
