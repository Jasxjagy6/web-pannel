const express = require('express');
const router = express.Router();
const billing = require('../controllers/billingController');
const { authenticate } = require('../middleware/auth');

// All user-facing billing routes require authentication. We don't add
// `requireApproved` because the user must be able to see their billing
// status while their subscription is INACTIVE — that's the whole point
// of this page.
router.get('/config', authenticate, billing.getConfig);
router.get('/status', authenticate, billing.getStatus);

router.post('/trial/start',  authenticate, billing.startTrial);
router.post('/checkout',     authenticate, billing.createCheckout);

router.get('/invoices',                        authenticate, billing.listMyInvoices);
router.get('/events',                          authenticate, billing.listMyEvents);
router.post('/invoices/:id/refresh',           authenticate, billing.refreshInvoice);

// Public webhook — verified via HMAC inside the controller.
// Mounted with raw body parsing in `index.js` (NOT here) so we can
// rebuild the exact bytes OxaPay signed.
router.post('/oxapay/ipn', billing.oxapayIpn);

module.exports = router;
