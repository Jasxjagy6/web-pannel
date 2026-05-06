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
const { uploadFile, uploadVoice } = require('../middleware/tgClientUpload');

router.use(authenticate);
router.use(requireApproved);
router.use(generalLimiter);

// Conditionally applies the multer single-file middleware only when the
// caller actually sent multipart/form-data. JSON-only routes (like the
// re-send-sticker by document reference) skip multer so express body
// parsing keeps working.
function maybeMultipart(mw) {
  return (req, res, next) => {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (ct.startsWith('multipart/form-data')) return mw(req, res, next);
    return next();
  };
}

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
router.post(
  '/sessions/:id/dialogs/:peerType/:peerId/send-media',
  uploadFile,
  controller.sendMedia
);
router.post(
  '/sessions/:id/dialogs/:peerType/:peerId/send-voice',
  uploadVoice,
  controller.sendVoice
);
router.post(
  '/sessions/:id/dialogs/:peerType/:peerId/send-sticker',
  maybeMultipart(uploadFile),
  controller.sendSticker
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
