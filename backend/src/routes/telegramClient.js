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
const { uploadFile, uploadVoice, uploadPhoto } = require('../middleware/tgClientUpload');

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

// --- Edit / delete / forward (D3) ----------------------------------------
router.patch(
  '/sessions/:id/dialogs/:peerType/:peerId/messages/:messageId',
  controller.editMessage
);
router.delete(
  '/sessions/:id/dialogs/:peerType/:peerId/messages/:messageId',
  controller.deleteMessages
);
router.delete(
  '/sessions/:id/dialogs/:peerType/:peerId/messages',
  controller.deleteMessages
);
router.post(
  '/sessions/:id/forward',
  controller.forwardMessages
);

// --- Profile photo --------------------------------------------------------
router.get(
  '/sessions/:id/photo/:peerType/:peerId',
  controller.getProfilePhoto
);

// --- Self profile (D5) ---------------------------------------------------
router.get('/sessions/:id/profile/me', controller.getSelfProfile);
router.patch('/sessions/:id/profile/me', controller.updateSelfProfile);
router.patch('/sessions/:id/profile/me/username', controller.updateSelfUsername);
router.get('/sessions/:id/profile/me/check-username', controller.checkSelfUsername);
router.post(
  '/sessions/:id/profile/me/photo',
  uploadPhoto,
  controller.updateSelfPhoto
);
router.delete('/sessions/:id/profile/me/photo', controller.deleteSelfPhoto);

// --- Peer profile (D6) ---------------------------------------------------
// 'me' is matched above, so :peerType won't capture it as long as we
// keep the more-specific routes first.
router.get('/sessions/:id/profile/:peerType/:peerId', controller.getPeerProfile);
router.patch('/sessions/:id/profile/:peerType/:peerId/block', controller.setPeerBlocked);
router.patch('/sessions/:id/profile/:peerType/:peerId/mute', controller.setPeerMuted);
router.get('/sessions/:id/profile/user/:peerId/common-chats', controller.getCommonChats);

// --- Members + admin (D10) ----------------------------------------------
router.get('/sessions/:id/dialogs/:peerType/:peerId/members', controller.getChatMembers);
router.post('/sessions/:id/dialogs/:peerType/:peerId/members', controller.addChatMember);
router.delete('/sessions/:id/dialogs/:peerType/:peerId/members/:userId', controller.kickChatMember);
router.patch('/sessions/:id/dialogs/:peerType/:peerId/members/:userId/admin', controller.setChatAdmin);
router.patch('/sessions/:id/dialogs/:peerType/:peerId/title', controller.editChatTitle);
router.patch('/sessions/:id/dialogs/:peerType/:peerId/about', controller.editChatAbout);
router.post('/sessions/:id/dialogs/:peerType/:peerId/photo', uploadPhoto, controller.editChatPhoto);
router.post('/sessions/:id/dialogs/:peerType/:peerId/leave', controller.leaveChat);

module.exports = router;
