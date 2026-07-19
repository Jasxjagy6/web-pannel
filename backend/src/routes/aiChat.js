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

// Bulk enable/disable AI across every Telegram session the caller owns.
router.post('/bulk-toggle', controller.bulkToggle);

router.get('/sessions/:id/ai-chats', controller.listChatSettings);
router.patch('/sessions/:id/ai-chats/:peerType/:peerId', controller.updateChatSettings);
router.post('/sessions/:id/ai-chats/:peerType/:peerId/seed', controller.seedChatMemory);
router.delete('/sessions/:id/ai-chats/:peerType/:peerId/memory', controller.clearChatMemory);

router.get('/sessions/:id/ai-logs', controller.listLogs);

// AI activity tracking (analytics over the existing ai_response_logs audit trail)
router.get('/tracking/overview', controller.getTrackingOverview);
router.get('/sessions/:id/tracking/conversations', controller.listTrackedConversations);
router.get(
  '/sessions/:id/tracking/conversations/:peerType/:peerId',
  controller.getConversationTranscript
);

// CupidBot API key management
router.get('/cupidbot-key', controller.getCupidbotKey);
router.post('/cupidbot-key', controller.setCupidbotKey);
router.delete('/cupidbot-key', controller.deleteCupidbotKey);

// CapitalBot API key management
router.get('/capitalbot-key', controller.getCapitalbotKey);
router.post('/capitalbot-key', controller.setCapitalbotKey);
router.patch('/capitalbot-model-preset', controller.updateCapitalbotModelPreset);
router.get('/capitalbot-my-models', controller.getMyCapitalbotModels);
router.post('/capitalbot-models', controller.fetchCapitalbotModels);
router.delete('/capitalbot-key', controller.deleteCapitalbotKey);

module.exports = router;
