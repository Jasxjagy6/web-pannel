const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/otpController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.post('/jobs', ctrl.createJob);
router.get('/jobs', ctrl.listJobs);
router.get('/jobs/:id', ctrl.getJob);

module.exports = router;
