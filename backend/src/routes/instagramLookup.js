const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/lookupController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

router.post('/',                ctrl.createAndStart);
router.get('/jobs',             ctrl.listJobs);
router.get('/jobs/:id',         ctrl.getJob);
router.get('/jobs/:id/progress',ctrl.getProgress);
router.get('/jobs/:id/findings',ctrl.listFindings);
router.post('/jobs/:id/cancel', ctrl.cancelJob);
router.post('/jobs/:id/export', ctrl.exportJob);
router.delete('/jobs/:id',      ctrl.deleteJob);

module.exports = router;
