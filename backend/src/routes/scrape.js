const express = require('express');
const router = express.Router();
const scrapeController = require('../controllers/scrapeController');
const { authenticate } = require('../middleware/auth');
const { scrapeLimiter } = require('../middleware/rateLimiter');

// Apply auth middleware to all routes
router.use(authenticate);

// POST /api/scrape/group - Start group scraping (multi-session, multi-target)
router.post('/group', scrapeLimiter, scrapeController.scrapeGroup);

// POST /api/scrape/channel - Start channel scraping
router.post('/channel', scrapeLimiter, scrapeController.scrapeChannel);

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
