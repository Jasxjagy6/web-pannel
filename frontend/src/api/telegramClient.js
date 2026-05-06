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

/**
 * Send a media (photo/video/audio/document) message. `kind` selects the
 * Telegram document attribute set used by the receiver for rendering.
 *
 * `extras.onUploadProgress` receives raw axios progress events for the
 * outgoing HTTP body; the *actual* Telegram-side upload progress
 * arrives via Socket.IO `tg-client:uploadProgress`.
 */
export const sendClientMedia = (
  sessionId,
  peerType,
  peerId,
  { file, kind, caption, replyToMsgId, silent, clientMsgId, duration, width, height, waveform } = {},
  extras = {}
) => {
  const fd = new FormData();
  fd.append('file', file);
  if (kind) fd.append('kind', kind);
  if (caption) fd.append('caption', caption);
  if (replyToMsgId != null) fd.append('replyToMsgId', String(replyToMsgId));
  if (silent) fd.append('silent', 'true');
  if (clientMsgId) fd.append('clientMsgId', clientMsgId);
  if (duration != null) fd.append('duration', String(duration));
  if (width != null) fd.append('width', String(width));
  if (height != null) fd.append('height', String(height));
  if (waveform) fd.append('waveform', waveform);
  return api.post(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/send-media`,
    fd,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: extras.onUploadProgress,
      // media uploads are slow — bump axios timeout
      timeout: 0,
    }
  );
};

export const sendClientVoice = (
  sessionId,
  peerType,
  peerId,
  { file, replyToMsgId, silent, clientMsgId, duration, waveform } = {},
  extras = {}
) => {
  const fd = new FormData();
  fd.append('voice', file);
  if (replyToMsgId != null) fd.append('replyToMsgId', String(replyToMsgId));
  if (silent) fd.append('silent', 'true');
  if (clientMsgId) fd.append('clientMsgId', clientMsgId);
  if (duration != null) fd.append('duration', String(duration));
  if (waveform) fd.append('waveform', waveform);
  return api.post(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/send-voice`,
    fd,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: extras.onUploadProgress,
      timeout: 0,
    }
  );
};

/**
 * Send a sticker. Either provide `{ documentId, accessHash, fileReference }`
 * to re-send a known sticker, or `{ file }` to upload a one-off
 * sticker file.
 */
export const sendClientSticker = (
  sessionId,
  peerType,
  peerId,
  payload = {}
) => {
  if (payload.file) {
    const fd = new FormData();
    fd.append('file', payload.file);
    if (payload.replyToMsgId != null) fd.append('replyToMsgId', String(payload.replyToMsgId));
    if (payload.silent) fd.append('silent', 'true');
    if (payload.clientMsgId) fd.append('clientMsgId', payload.clientMsgId);
    return api.post(
      `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/send-sticker`,
      fd,
      { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0 }
    );
  }
  return api.post(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/send-sticker`,
    {
      documentId: payload.documentId,
      accessHash: payload.accessHash,
      fileReference: payload.fileReference,
      replyToMsgId: payload.replyToMsgId,
      silent: !!payload.silent,
      clientMsgId: payload.clientMsgId,
    }
  );
};
