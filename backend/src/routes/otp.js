const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/otpController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

router.post('/jobs', ctrl.createJob);
router.get('/jobs', ctrl.listJobs);
router.get('/jobs/:id', ctrl.getJob);

module.exports = router;
