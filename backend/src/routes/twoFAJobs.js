const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/twoFAJobController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

router.post('/bulk', ctrl.createBulkJob);
router.post('/individual', ctrl.createIndividualJob);
router.get('/', ctrl.listJobs);
router.get('/:id', ctrl.getJob);

module.exports = router;
