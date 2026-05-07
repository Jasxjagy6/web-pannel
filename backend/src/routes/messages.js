const express = require('express');
const router = express.Router();
const messageController = require('../controllers/messageController');
const { authenticate, requireApproved } = require('../middleware/auth');
const { messageLimiter } = require('../middleware/rateLimiter');
const { validate, schemas } = require('../middleware/validator');

router.use(authenticate);
router.use(requireApproved);

// POST /api/messages/send - Send single
router.post('/send', messageLimiter, validate(schemas.sendMessage), messageController.sendMessage);

// POST /api/messages/bulk - Bulk send
router.post('/bulk', messageLimiter, validate(schemas.bulkMessage), messageController.sendBulk);

// POST /api/messages/bulk/preview - Distribution-engine preview
// Returns the rotation/cooldown plan that would be used for a bulk
// send, without enqueueing or sending anything.
router.post('/bulk/preview', messageController.previewBulk);

// POST /api/messages/group - Send to group
router.post('/group', messageLimiter, messageController.sendMessageToGroup);

// POST /api/messages/forward - Forward
router.post('/forward', messageLimiter, messageController.forwardMessage);

// GET /api/messages/jobs - List jobs
router.get('/jobs', messageController.getJobs);

// GET /api/messages/history - Message history
router.get('/history', messageController.getMessageHistory);

// GET /api/messages/stats - Get stats
router.get('/stats', messageController.getMessagingStats);

// POST /api/messages/preview - Test message
router.post('/preview', messageController.previewMessage);

// POST /api/messages/bulk-groups - Send to multiple groups with rate limiting
router.post('/bulk-groups', messageController.sendBulkToGroups);

// POST /api/messages/bulk-users - Send to multiple users with rate limiting
router.post('/bulk-users', messageController.sendBulkToUsers);

// GET /api/messages/jobs/:id - Get job
router.get('/:id', messageController.getJob);

// POST /api/messages/jobs/:id/cancel - Cancel job
router.post('/:id/cancel', messageController.cancelJob);

module.exports = router;
