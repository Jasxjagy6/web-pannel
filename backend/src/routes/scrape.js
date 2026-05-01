const express = require('express');
const router = express.Router();
const scrapeController = require('../controllers/scrapeController');
const { authenticate, requireApproved } = require('../middleware/auth');
const { scrapeLimiter } = require('../middleware/rateLimiter');

// Apply auth middleware to all routes
router.use(authenticate);
router.use(requireApproved);

// POST /api/scrape/group - Start group scraping (multi-session, multi-target)
router.post('/group', scrapeLimiter, scrapeController.scrapeGroup);

// POST /api/scrape/channel - Start channel scraping
router.post('/channel', scrapeLimiter, scrapeController.scrapeChannel);

// POST /api/scrape/preview - Detect admin-only chats before launching a job.
// Returns { results: [{ target, canScrape, isAdminOnly, info, reason }] }
router.post('/preview', scrapeController.previewTargets);

// ---------------------------------------------------------------------------
// MONITOR routes (period-bounded passive scraper for admin-only chats).
// `monitors/cancel-all` MUST be declared before `monitors/:id` so the
// dynamic-id route does not swallow it.
// ---------------------------------------------------------------------------
router.post('/monitors', scrapeLimiter, scrapeController.createMonitor);
router.get('/monitors', scrapeController.listMonitors);
router.post('/monitors/cancel-all', scrapeController.cancelAllMonitors);
router.get('/monitors/:id', scrapeController.getMonitor);
router.get('/monitors/:id/users', scrapeController.monitorUsers);
router.post('/monitors/:id/pause', scrapeController.pauseMonitor);
router.post('/monitors/:id/resume', scrapeController.resumeMonitor);
router.post('/monitors/:id/stop', scrapeController.stopMonitor);
router.post('/monitors/:id/cancel', scrapeController.stopMonitor);
router.post('/monitors/:id/export', scrapeController.exportMonitor);

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
