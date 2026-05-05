const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/otpRelayController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);
router.get('/:id/events', ctrl.events);

module.exports = router;
