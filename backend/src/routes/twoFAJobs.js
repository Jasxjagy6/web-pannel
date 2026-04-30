const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/twoFAJobController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.post('/bulk', ctrl.createBulkJob);
router.post('/individual', ctrl.createIndividualJob);
router.get('/', ctrl.listJobs);
router.get('/:id', ctrl.getJob);

module.exports = router;
