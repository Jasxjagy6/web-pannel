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
// Bulk "Clear chat history across N sessions" — declared before
// /sessions/:id/* so the static path wins over the param route.
router.post('/sessions/clear-history', controller.clearAllChatsHistory);
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

// --- Settings (D7) -------------------------------------------------------
router.get('/sessions/:id/settings/notifications', controller.getDefaultNotifySettings);
router.patch('/sessions/:id/settings/notifications/:kind', controller.setDefaultNotifySettings);
router.post('/sessions/:id/settings/notifications/reset', controller.resetNotifySettings);
router.get('/sessions/:id/settings/privacy/:key', controller.getPrivacy);
router.patch('/sessions/:id/settings/privacy/:key', controller.setPrivacy);
router.get('/sessions/:id/settings/language', controller.getLanguage);
router.get('/sessions/:id/settings/languages', controller.listLanguages);

// --- Security (D8) -------------------------------------------------------
router.get('/sessions/:id/security/2fa',          controller.get2FAState);
router.post('/sessions/:id/security/2fa/enable',  controller.enable2FA);
router.post('/sessions/:id/security/2fa/disable', controller.disable2FA);
router.post('/sessions/:id/security/2fa/change',  controller.change2FA);
router.get('/sessions/:id/security/authorizations',                       controller.listAuthorizations);
router.delete('/sessions/:id/security/authorizations/:hash',              controller.resetAuthorization);
router.post('/sessions/:id/security/authorizations/reset-others',         controller.resetOtherAuthorizations);
router.patch('/sessions/:id/security/authorizations/ttl',                 controller.setAuthorizationTtl);

// --- Contacts (D9) -------------------------------------------------------
router.get('/sessions/:id/contacts',          controller.listContacts);
router.get('/sessions/:id/contacts/search',   controller.searchContacts);
router.post('/sessions/:id/contacts',         controller.addContact);
router.delete('/sessions/:id/contacts',       controller.deleteContacts);

// --- Drafts (D12) --------------------------------------------------------
router.get('/sessions/:id/drafts',                                       controller.getAllDrafts);
router.post('/sessions/:id/drafts/:peerType/:peerId',                    controller.saveDraft);
router.delete('/sessions/:id/drafts/:peerType/:peerId',                  controller.clearDraft);

// --- Pinned messages (D13) ----------------------------------------------
router.get('/sessions/:id/dialogs/:peerType/:peerId/pinned',                    controller.getPinnedMessages);
router.post('/sessions/:id/dialogs/:peerType/:peerId/pinned/:messageId',        controller.pinMessage);
router.delete('/sessions/:id/dialogs/:peerType/:peerId/pinned/:messageId',      controller.unpinMessage);
router.delete('/sessions/:id/dialogs/:peerType/:peerId/pinned',                 controller.unpinAllMessages);

// --- Search (D4) ---------------------------------------------------------
router.get('/sessions/:id/dialogs/:peerType/:peerId/search',  controller.searchInChat);
router.get('/sessions/:id/search',                            controller.searchGlobal);

// --- Stickers / GIFs (D11) ----------------------------------------------
router.get('/sessions/:id/stickers/sets',         controller.getStickerSets);
router.get('/sessions/:id/stickers/recent',       controller.getRecentStickers);
router.get('/sessions/:id/stickers/favorite',     controller.getFavoriteStickers);
router.get('/sessions/:id/stickers/search',       controller.searchStickers);
router.get('/sessions/:id/gifs/saved',            controller.getSavedGifs);
router.get('/sessions/:id/gifs/search',           controller.searchGifs);
router.get('/sessions/:id/documents/:documentId/media', controller.getDocumentMedia);

module.exports = router;
