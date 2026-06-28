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

export const getAiChatSettings = (sessionId, params = {}) =>
  api.get(`${BASE}/sessions/${sessionId}/ai-chats`, { params });

export const updateAiChatSettings = (sessionId, peerType, peerId, payload) =>
  api.patch(`${BASE}/sessions/${sessionId}/ai-chats/${peerType}/${peerId}`, payload);

export const clearAiChatMemory = (sessionId, peerType, peerId) =>
  api.delete(`${BASE}/sessions/${sessionId}/ai-chats/${peerType}/${peerId}/memory`);

export const getAiLogs = (sessionId, params = {}) =>
  api.get(`${BASE}/sessions/${sessionId}/ai-logs`, { params });
