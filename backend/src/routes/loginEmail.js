const express = require('express');
const router = express.Router();
const loginEmailController = require('../controllers/loginEmailController');
const { authenticate } = require('../middleware/auth');
const rateLimiter = require('../middleware/rateLimiter');

// Public route for google callback if it comes directly from Google, but usually we just handle the code in frontend
// Actually, since we need user authentication to save the gmail account, we requireAuth on all.
router.use(authenticate);

// Google Auth
router.get('/google-auth-url', loginEmailController.getGoogleAuthUrl);
router.post('/google-callback', rateLimiter.generalLimiter, loginEmailController.googleCallback);

// Gmail Accounts
router.get('/gmail-accounts', loginEmailController.listGmailAccounts);
router.delete('/gmail-accounts/:id', loginEmailController.deleteGmailAccount);

// Jobs
router.post('/jobs', rateLimiter.generalLimiter, loginEmailController.createJob);
router.get('/jobs', loginEmailController.listJobs);
router.get('/jobs/:id/items', loginEmailController.getJobItems);
router.post('/jobs/:id/cancel', rateLimiter.generalLimiter, loginEmailController.cancelJob);

module.exports = router;
