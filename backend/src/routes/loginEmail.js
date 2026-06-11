const express = require('express');
const router = express.Router();
const loginEmailController = require('../controllers/loginEmailController');
const { authenticate } = require('../middleware/auth');
const rateLimiter = require('../middleware/rateLimiter');

router.use(authenticate);

router.post(
  '/jobs',
  rateLimiter.generalLimiter,
  loginEmailController.createJob
);

router.get('/jobs', loginEmailController.listJobs);
router.get('/jobs/:id/items', loginEmailController.getJobItems);

router.post(
  '/jobs/:id/cancel',
  rateLimiter.generalLimiter,
  loginEmailController.cancelJob
);

module.exports = router;
