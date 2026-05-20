/**
 * Routes for the Reddit cookie-scraper feature.
 *
 * Mounted at /api/reddit. Lives under the Telegram-panel UI but is
 * platform-agnostic — the feature operates on Reddit credentials the
 * operator owns and has nothing to do with the Telegram or Instagram
 * provider chains.
 */

'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/redditScrapeController');
const { authenticate, requireApproved } = require('../middleware/auth');

router.use(authenticate);
router.use(requireApproved);

// Format listing — UI calls this on mount to populate the download dropdown.
router.get('/formats', ctrl.listFormats);

// Account CRUD
router.get('/accounts',            ctrl.listAccounts);
router.post('/accounts',           ctrl.createAccount);
router.get('/accounts/:id',        ctrl.getAccount);
router.patch('/accounts/:id',      ctrl.updateAccount);
router.delete('/accounts/:id',     ctrl.deleteAccount);

// Scrape trigger + history
router.post('/accounts/:id/scrape',          ctrl.scrapeAccount);
router.get('/accounts/:id/jobs',             ctrl.listJobs);
router.get('/accounts/:id/cookies/latest',   ctrl.latestCookies);

// Per-job inspection / export
router.get('/jobs/:jobId',                ctrl.getJob);
router.get('/jobs/:jobId/cookies',         ctrl.listJobCookies);
router.get('/jobs/:jobId/export/:format',  ctrl.exportJob);

module.exports = router;
