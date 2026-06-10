const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/loginMailController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

// Credential management
router.post('/credentials/detect', ctrl.detectImapSettings);
router.post('/credentials',        ctrl.saveCredentials);
router.get('/credentials',         ctrl.listCredentials);
router.delete('/credentials/:id',  ctrl.deleteCredentials);
router.post('/credentials/:id/test', ctrl.testCredentials);

// Bulk jobs
router.post('/jobs',              ctrl.createJob);
router.get('/jobs',               ctrl.listJobs);
router.get('/jobs/:id',           ctrl.getJob);
router.get('/jobs/:id/items',     ctrl.getJobItems);
router.post('/jobs/:id/cancel',   ctrl.cancelJob);

// Manual single-session flow
router.post('/send-code',    ctrl.sendCode);
router.post('/verify-code',  ctrl.verifyCode);

module.exports = router;
