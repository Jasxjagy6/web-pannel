/**
 * API client for the AI auto-responder management surface.
 *
 * All endpoints live under /api/telegram/ai-chat/*.
 */

import api from './client';

const BASE = '/telegram/ai-chat';

export const getAiSessionSettings = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/ai-settings`);

export const updateAiSessionSettings = (sessionId, payload) =>
  api.patch(`${BASE}/sessions/${sessionId}/ai-settings`, payload);

// Bulk enable/disable AI across every Telegram session the caller owns.
// On enable the backend picks the provider from the user's validated key
// (CapitalBot preferred, else CupidBot).
export const bulkToggleAiSessions = (enabled) =>
  api.post(`${BASE}/bulk-toggle`, { enabled });

export const getAiChatSettings = (sessionId, params = {}) =>
  api.get(`${BASE}/sessions/${sessionId}/ai-chats`, { params });

export const updateAiChatSettings = (sessionId, peerType, peerId, payload) =>
  api.patch(`${BASE}/sessions/${sessionId}/ai-chats/${peerType}/${peerId}`, payload);

export const clearAiChatMemory = (sessionId, peerType, peerId) =>
  api.delete(`${BASE}/sessions/${sessionId}/ai-chats/${peerType}/${peerId}/memory`);

export const seedAiChatMemory = (sessionId, peerType, peerId) =>
  api.post(`${BASE}/sessions/${sessionId}/ai-chats/${peerType}/${peerId}/seed`);

export const getAiLogs = (sessionId, params = {}) =>
  api.get(`${BASE}/sessions/${sessionId}/ai-logs`, { params });

// CupidBot API key management (per-user)
export const getCupidbotKey = () => api.get(`${BASE}/cupidbot-key`);
export const setCupidbotKey = (apiKey) =>
  api.post(`${BASE}/cupidbot-key`, { apiKey });
export const deleteCupidbotKey = () => api.delete(`${BASE}/cupidbot-key`);

// CapitalBot API key management (per-user)
export const getCapitalbotKey = () => api.get(`${BASE}/capitalbot-key`);
export const setCapitalbotKey = (apiKey, modelId, presetId, responseLanguage) =>
  api.post(`${BASE}/capitalbot-key`, { apiKey, modelId, presetId, responseLanguage });
export const updateCapitalbotModelPreset = (modelId, presetId, responseLanguage) =>
  api.patch(`${BASE}/capitalbot-model-preset`, { modelId, presetId, responseLanguage });
export const fetchCapitalbotModels = (apiKey) =>
  api.post(`${BASE}/capitalbot-models`, { apiKey });
export const getMyCapitalbotModels = () =>
  api.get(`${BASE}/capitalbot-my-models`);
export const deleteCapitalbotKey = () => api.delete(`${BASE}/capitalbot-key`);

// ─── AI activity tracking (analytics over the existing audit trail) ───

// Owner-wide overview: totals + per-session breakdown.
// Optional params: { sessionId, since, until }
export const getAiTrackingOverview = (params = {}) =>
  api.get(`${BASE}/tracking/overview`, { params });

// Every conversation (distinct peer) the AI touched for a session.
export const getAiTrackedConversations = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/tracking/conversations`);

// Full message-by-message transcript for one tracked conversation.
export const getAiConversationTranscript = (sessionId, peerType, peerId, params = {}) =>
  api.get(
    `${BASE}/sessions/${sessionId}/tracking/conversations/${peerType}/${peerId}`,
    { params }
  );
