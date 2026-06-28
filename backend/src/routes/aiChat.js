/**
 * Routes for the AI auto-responder management surface.
 *
 * Mounted under /api/telegram/ai-chat/* (Telegram-only).
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/aiChatController');
const { authenticate, requireApproved } = require('../middleware/auth');
const { generalLimiter } = require('../middleware/rateLimiter');

router.use(authenticate);
router.use(requireApproved);
router.use(generalLimiter);

router.get('/sessions/:id/ai-settings', controller.getSessionSettings);
router.patch('/sessions/:id/ai-settings', controller.updateSessionSettings);

router.get('/sessions/:id/ai-chats', controller.listChatSettings);
router.patch('/sessions/:id/ai-chats/:peerType/:peerId', controller.updateChatSettings);
router.delete('/sessions/:id/ai-chats/:peerType/:peerId/memory', controller.clearChatMemory);

router.get('/sessions/:id/ai-logs', controller.listLogs);

module.exports = router;
