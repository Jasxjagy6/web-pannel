/**
 * API client for the in-panel Telegram client (Login → real chat UI).
 *
 * Every endpoint is rooted at /api/telegram/client/... so it bypasses
 * the platform-aware auto-prefix logic in `client.js` (we don't want
 * `/instagram/client/...` to ever resolve, even if someone is browsing
 * the IG panel when a stale link is opened).
 */

import api from './client';

const BASE = '/telegram/client';

export const listClientSessions = () => api.get(`${BASE}/sessions`);

export const connectClientSession = (sessionId) =>
  api.post(`${BASE}/sessions/${sessionId}/connect`);

export const getClientMe = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/me`);

export const getClientDialogs = (sessionId, params = {}) =>
  api.get(`${BASE}/sessions/${sessionId}/dialogs`, { params });

export const getClientMessages = (sessionId, peerType, peerId, params = {}) =>
  api.get(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/messages`,
    { params }
  );

export const sendClientMessage = (sessionId, peerType, peerId, payload) =>
  api.post(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/send`,
    payload
  );

export const markClientRead = (sessionId, peerType, peerId, maxId) =>
  api.post(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/read`,
    { maxId }
  );

/**
 * Build a URL the browser can use directly in <img src="..."> tags.
 *
 * Profile photos are served as raw image bytes by the backend and gated
 * by the panel JWT — but we need to supply that JWT inside an <img> tag
 * which doesn't take headers. We fetch the photo via axios (which DOES
 * attach the JWT), turn it into an object URL, and let the caller cache
 * the result. See `useProfilePhoto` for the React-side cache.
 */
export const fetchProfilePhotoBlob = async (sessionId, peerType, peerId, opts = {}) => {
  const { data, status } = await api.get(
    `${BASE}/sessions/${sessionId}/photo/${peerType}/${peerId}`,
    {
      responseType: 'blob',
      params: opts.large ? { large: 1 } : {},
      // 204 should not throw.
      validateStatus: (s) => (s >= 200 && s < 300) || s === 204,
    }
  );
  if (status === 204 || !data || (data.size != null && data.size === 0)) {
    return null;
  }
  return data;
};

export const fetchMessageMediaBlob = async (sessionId, peerType, peerId, messageId) => {
  const { data, status } = await api.get(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/messages/${messageId}/media`,
    {
      responseType: 'blob',
      validateStatus: (s) => (s >= 200 && s < 300) || s === 204,
    }
  );
  if (status === 204 || !data || (data.size != null && data.size === 0)) {
    return null;
  }
  return data;
};
