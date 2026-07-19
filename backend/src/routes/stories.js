/**
 * Routes for the "Upload Story" feature. Mounted at /api/stories
 * (Telegram-only). Stories are Premium-only; non-premium sessions in the
 * selection are skipped automatically by the job worker.
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/storyController');
const { authenticate, requireApproved } = require('../middleware/auth');
const fileUpload = require('../middleware/storyUpload');

router.use(authenticate);
router.use(requireApproved);

// Upload the story media first (multipart), then create a job referencing it.
router.post('/upload-media', fileUpload, controller.uploadMedia);

router.post('/jobs', controller.createJob);
router.get('/jobs', controller.listJobs);
router.get('/jobs/:id', controller.getJob);
router.get('/jobs/:id/items', controller.getJobItems);
router.post('/jobs/:id/cancel', controller.cancelJob);

module.exports = router;
