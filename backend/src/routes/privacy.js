const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/privacyController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

router.get('/keys', ctrl.keys);
router.post('/jobs', ctrl.createJob);
router.get('/jobs', ctrl.listJobs);
router.get('/jobs/:id', ctrl.getJob);
router.get('/jobs/:id/items', ctrl.getJobItems);
router.post('/jobs/:id/cancel', ctrl.cancelJob);

module.exports = router;
