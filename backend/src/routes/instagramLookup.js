const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/lookupController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

// Job CRUD
router.post('/',                ctrl.createAndStart);
router.get('/jobs',             ctrl.listJobs);
router.get('/jobs/:id',         ctrl.getJob);
router.get('/jobs/:id/progress',ctrl.getProgress);
router.get('/jobs/:id/findings',ctrl.listFindings);
router.post('/jobs/:id/cancel', ctrl.cancelJob);
router.post('/jobs/:id/export', ctrl.exportJob);
router.delete('/jobs/:id',      ctrl.deleteJob);

// Watches (PR #7)
router.get('/watches',          ctrl.listWatches);
router.post('/watches',         ctrl.createWatch);
router.delete('/watches/:id',   ctrl.deleteWatch);
router.post('/watches/:id/run', ctrl.runWatchNow);

// Per-user API key vault (PR #5 / #6)
router.get('/keys',             ctrl.listKeys);
router.put('/keys',             ctrl.upsertKey);
router.delete('/keys/:provider',ctrl.deleteKey);

// Per-user budget (PR #8)
router.get('/budget',           ctrl.getBudget);
router.put('/budget',           ctrl.setBudget);

// Audit + usage rollup
router.get('/audit',            ctrl.listAudit);
router.get('/usage',            ctrl.usageRollup);

// Admin dashboards (PR #8)
router.get('/admin/risk',       ctrl.riskDashboard);

module.exports = router;
