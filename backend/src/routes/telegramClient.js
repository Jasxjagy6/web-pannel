/**
 * Routes for the in-panel Telegram client.
 *
 * Mounted at /api/telegram/client/* (Telegram-only). All routes require
 * an authenticated, approved panel user (no anonymous access). The
 * service layer authorizes per-session access.
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/telegramClientController');
const { authenticate, requireApproved } = require('../middleware/auth');
const { generalLimiter } = require('../middleware/rateLimiter');

router.use(authenticate);
router.use(requireApproved);
router.use(generalLimiter);

// --- Sessions -------------------------------------------------------------
router.get('/sessions', controller.listSessions);
router.post('/sessions/:id/connect', controller.connect);
router.get('/sessions/:id/me', controller.getMe);

// --- Dialogs --------------------------------------------------------------
router.get('/sessions/:id/dialogs', controller.getDialogs);

// --- Per-peer message routes (peerType ∈ user|chat|channel) --------------
router.get(
  '/sessions/:id/dialogs/:peerType/:peerId/messages',
  controller.getMessages
);
router.post(
  '/sessions/:id/dialogs/:peerType/:peerId/send',
  controller.sendMessage
);
router.post(
  '/sessions/:id/dialogs/:peerType/:peerId/read',
  controller.markRead
);
router.get(
  '/sessions/:id/dialogs/:peerType/:peerId/messages/:messageId/media',
  controller.getMessageMedia
);

// --- Profile photo --------------------------------------------------------
router.get(
  '/sessions/:id/photo/:peerType/:peerId',
  controller.getProfilePhoto
);

module.exports = router;
