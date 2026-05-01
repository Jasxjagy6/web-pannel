const express = require('express');
const router = express.Router();
const scrapeController = require('../controllers/scrapeController');
const monitorController = require('../controllers/monitorController');
const { authenticate, requireApproved } = require('../middleware/auth');
const { scrapeLimiter } = require('../middleware/rateLimiter');

// Apply auth middleware to all routes
router.use(authenticate);
router.use(requireApproved);

// POST /api/scrape/group - Start group scraping (multi-session, multi-target)
router.post('/group', scrapeLimiter, scrapeController.scrapeGroup);

// POST /api/scrape/channel - Start channel scraping
router.post('/channel', scrapeLimiter, scrapeController.scrapeChannel);

// --- Channel/group monitoring (long-running watch jobs) -------------------
// IMPORTANT: keep these BEFORE /jobs/:id so /jobs/:id/... doesn't shadow
// /monitor/cancel-all etc.
router.post('/monitor/cancel-all', monitorController.cancelAll);
router.post('/monitor', scrapeLimiter, monitorController.createJob);
router.get('/monitor', monitorController.list);
router.get('/monitor/:id', monitorController.get);
router.get('/monitor/:id/users', monitorController.users);
router.post('/monitor/:id/pause', monitorController.pause);
router.post('/monitor/:id/resume', monitorController.resume);
router.post('/monitor/:id/stop', monitorController.stop);

// GET /api/scrape/jobs - List jobs
router.get('/jobs', scrapeController.listJobs);

// GET /api/scrape/jobs/stats - Get scrape stats (must be before /:id)
router.get('/jobs/stats', scrapeController.getScrapeStats);

// GET /api/scrape/jobs/:id - Get job details
router.get('/jobs/:id', scrapeController.getJob);

// GET /api/scrape/jobs/:id/progress - Get job progress
router.get('/jobs/:id/progress', scrapeController.getJobProgress);

// POST /api/scrape/jobs/:id/cancel - Cancel job
router.post('/jobs/:id/cancel', scrapeController.cancelJob);

// POST /api/scrape/jobs/:id/export - Export scraped users with filters
router.post('/jobs/:id/export', scrapeController.exportJob);

// DELETE /api/scrape/jobs/:id - Delete job
router.delete('/jobs/:id', scrapeController.deleteJob);

module.exports = router;
