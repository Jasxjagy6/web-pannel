const express = require('express');
const router = express.Router();
const messageController = require('../controllers/messageController');
const { getJobSessionBreakdown } = require('../controllers/messageController_sessionBreakdown');
const { authenticate, requireApproved } = require('../middleware/auth');
const { messageLimiter } = require('../middleware/rateLimiter');
const { validate, schemas } = require('../middleware/validator');

router.use(authenticate);
router.use(requireApproved);

// POST /api/messages/send - Send single
router.post('/send', messageLimiter, validate(schemas.sendMessage), messageController.sendMessage);

// POST /api/messages/bulk - Bulk send
router.post('/bulk', messageLimiter, validate(schemas.bulkMessage), messageController.sendBulk);

// POST /api/messages/failover - Sequential multi-session failover send.
// Session #1 sends until Telegram limits it / refuses (mutual-contact),
// then hands off to session #2 resuming from the same target. Target-side
// errors skip just that target. Reuses the bulkMessage validator shape.
router.post('/failover', messageLimiter, validate(schemas.failoverMessage), messageController.sendFailover);

// POST /api/messages/parallel - Parallel round-robin mass DM. Every
// session works in parallel pulling the next target off a shared queue
// (session 1 -> target 1, session 2 -> target 2, …). Invalid targets are
// skipped so each session stays busy on DIFFERENT users. Finishes a big
// list in minutes with safe per-account pacing. Reuses the failover shape.
router.post('/parallel', messageLimiter, validate(schemas.failoverMessage), messageController.sendParallel);

// POST /api/messages/split - Split mass DM. Operator sets a per-session quota
// (dmsPerSession); the audience is cut into contiguous slices (session 1 ->
// users 1..q, session 2 -> users q+1..2q, …) and every slice runs at the same
// time. Finishes in roughly the time ONE session needs for its slice. Targets
// are pre-verified so a limited/dead session just stops its own slice.
router.post('/split', messageLimiter, validate(schemas.failoverMessage), messageController.sendSplit);

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

// POST /api/messages/single-user-mass-dm
//   Single-User Mass DM: 1..50 manual or saved-list target users; every
//   selected session DMs each target with a per-send delay (in seconds).
//   Validated by the `singleUserMassDm` Joi schema.
router.post(
  '/single-user-mass-dm',
  messageLimiter,
  validate(schemas.singleUserMassDm),
  messageController.sendSingleUserMassDm
);

// ---------------------------------------------------------------------
// Recurring group-message schedules (Messaging > Schedule tab).
// IMPORTANT: must be declared BEFORE the catch-all `/:id` routes
// below, otherwise `/schedules` would be parsed as `/:id`.
// ---------------------------------------------------------------------

// POST /api/messages/schedules - Create a recurring group-message schedule
router.post('/schedules', messageController.createSchedule);

// GET /api/messages/schedules - List the caller's schedules
router.get('/schedules', messageController.listSchedules);

// POST /api/messages/schedules/cancel-all - Cancel every running schedule
router.post('/schedules/cancel-all', messageController.cancelAllSchedules);

// GET /api/messages/schedules/:id - Get one schedule
router.get('/schedules/:id', messageController.getSchedule);

// POST /api/messages/schedules/:id/cancel - Cancel one schedule
router.post('/schedules/:id/cancel', messageController.cancelSchedule);

// GET /api/messages/jobs/:id/replies - Per-recipient reply breakdown
// (the job-history dropdown). Declared before the catch-all `/:id`.
router.get('/jobs/:id/replies', messageController.getJobReplyDetails);

// GET /api/messages/jobs/:id/export?type=sent|replied - CSV download of
// the job's successful recipients, or those who replied back.
router.get('/jobs/:id/export', messageController.exportJobRecipients);

// GET /api/messages/jobs/:id/session-breakdown - Per-session send breakdown
router.get('/jobs/:id/session-breakdown', getJobSessionBreakdown);

// GET /api/messages/jobs/:id - Get job
router.get('/:id', messageController.getJob);

// POST /api/messages/jobs/:id/cancel - Cancel job
router.post('/:id/cancel', messageController.cancelJob);

module.exports = router;
