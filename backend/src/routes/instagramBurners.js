const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/burnerController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

router.get('/',         ctrl.listBurners);
router.post('/',        ctrl.addBurner);
router.get('/stats',    ctrl.poolStats);
router.delete('/:id',   ctrl.deleteBurner);
router.post('/:id/block', ctrl.blockBurner);

module.exports = router;
