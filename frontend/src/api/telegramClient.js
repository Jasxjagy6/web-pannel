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

export const fetchMessageMediaBlob = async (sessionId, peerType, peerId, messageId, opts = {}) => {
  const { data, status, headers } = await api.get(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/messages/${messageId}/media`,
    {
      responseType: 'blob',
      params: {
        ...(opts.thumb ? { thumb: 1 } : {}),
        ...(opts.download ? { download: 1 } : {}),
      },
      validateStatus: (s) => (s >= 200 && s < 300) || s === 204,
    }
  );
  if (status === 204 || !data || (data.size != null && data.size === 0)) {
    return null;
  }
  return {
    blob: data,
    kind: headers?.['x-tg-media-kind'] || null,
    width: headers?.['x-tg-media-width'] ? Number(headers['x-tg-media-width']) : null,
    height: headers?.['x-tg-media-height'] ? Number(headers['x-tg-media-height']) : null,
    duration: headers?.['x-tg-media-duration'] ? Number(headers['x-tg-media-duration']) : null,
    isThumb: headers?.['x-tg-media-is-thumb'] === '1',
    mimeType: data.type || 'application/octet-stream',
  };
};

/**
 * Direct URL for use as `<video src=...>`, `<audio src=...>`, or as
 * a file download link. Uses the configured API_BASE_URL so it works
 * when the panel is mounted on a non-root path. The browser will
 * carry the panel JWT via the existing axios interceptor when used
 * as part of a fetch — but `<video>` tags don't honor cookies the
 * same way; for those, prefer building a blob URL via fetchMessageMediaBlob
 * and assigning the resulting object URL.
 */
export const buildMessageMediaUrl = (sessionId, peerType, peerId, messageId, opts = {}) => {
  const base = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
  const params = new URLSearchParams();
  if (opts.thumb) params.set('thumb', '1');
  if (opts.download) params.set('download', '1');
  const qs = params.toString();
  return `${base}${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/messages/${messageId}/media${qs ? `?${qs}` : ''}`;
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

/**
 * D3 — edit a message (sender's own outgoing only). Empty text rejected.
 */
export const editClientMessage = (sessionId, peerType, peerId, messageId, text) =>
  api.patch(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/messages/${messageId}`,
    { text }
  );

/**
 * D3 — delete one or more messages. `revoke` requests the messages be
 * removed for the recipient too where Telegram allows it.
 */
export const deleteClientMessages = (sessionId, peerType, peerId, messageIds, revoke = true) =>
  api.delete(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/messages`,
    { data: { messageIds, revoke } }
  );

/**
 * Bulk wipe chat history across N Telegram sessions ("Delete chats" on the
 * Login page). `revoke=true` asks Telegram to also remove the history on
 * the other side wherever Telegram allows it; `revoke=false` is the
 * "Delete for me" semantic.
 *
 * Backend behaviour: returns immediately with `{ jobId, job }`. The
 * actual wipe runs asynchronously and progress flows through the
 * History tab (REST + the per-user `tg-client:clearJobUpdate` socket
 * event).
 */
export const clearAllSessionsChats = (sessionIds, revoke = false, opts = {}) =>
  api.post(`${BASE}/sessions/clear-history`, {
    sessionIds,
    revoke: !!revoke,
    ...(opts.concurrency != null ? { concurrency: opts.concurrency } : {}),
  });

/**
 * List the most recent "Delete chats" jobs the panel user has started.
 * Newest first; capped server-side at 200.
 */
export const listClearChatsJobs = (limit = 50) =>
  api.get(`${BASE}/sessions/clear-history/jobs`, { params: { limit } });

/**
 * Fetch a single "Delete chats" job snapshot, including the per-session
 * per-dialog results.
 */
export const getClearChatsJob = (jobId) =>
  api.get(`${BASE}/sessions/clear-history/jobs/${encodeURIComponent(jobId)}`);

/**
 * D3 — forward messages from one chat into another.
 */
export const forwardClientMessages = (sessionId, payload) =>
  api.post(`${BASE}/sessions/${sessionId}/forward`, payload);

// --- D5 — self profile ----------------------------------------------------

export const getSelfProfile = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/profile/me`);

export const updateSelfProfile = (sessionId, payload) =>
  api.patch(`${BASE}/sessions/${sessionId}/profile/me`, payload);

export const updateSelfUsername = (sessionId, username) =>
  api.patch(`${BASE}/sessions/${sessionId}/profile/me/username`, { username });

export const checkSelfUsername = (sessionId, username) =>
  api.get(`${BASE}/sessions/${sessionId}/profile/me/check-username`, {
    params: { username },
  });

export const updateSelfPhoto = (sessionId, file) => {
  const fd = new FormData();
  fd.append('photo', file);
  return api.post(`${BASE}/sessions/${sessionId}/profile/me/photo`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 0,
  });
};

export const deleteSelfPhoto = (sessionId) =>
  api.delete(`${BASE}/sessions/${sessionId}/profile/me/photo`);

// --- D6 — peer profile ----------------------------------------------------

export const getPeerProfile = (sessionId, peerType, peerId) =>
  api.get(`${BASE}/sessions/${sessionId}/profile/${peerType}/${peerId}`);

export const setPeerBlocked = (sessionId, peerType, peerId, blocked) =>
  api.patch(`${BASE}/sessions/${sessionId}/profile/${peerType}/${peerId}/block`, { blocked });

export const setPeerMuted = (sessionId, peerType, peerId, muted, muteUntilSec) =>
  api.patch(`${BASE}/sessions/${sessionId}/profile/${peerType}/${peerId}/mute`, {
    muted,
    muteUntilSec,
  });

export const getCommonChats = (sessionId, peerId, opts = {}) =>
  api.get(`${BASE}/sessions/${sessionId}/profile/user/${peerId}/common-chats`, {
    params: { limit: opts.limit ?? 100 },
  });

// --- D10 — chat info + admin ---------------------------------------------

export const getChatMembers = (sessionId, peerType, peerId, opts = {}) =>
  api.get(`${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/members`, {
    params: {
      filter: opts.filter,
      search: opts.search,
      offset: opts.offset ?? 0,
      limit: opts.limit ?? 200,
    },
  });

export const addChatMember = (sessionId, peerType, peerId, payload) =>
  api.post(`${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/members`, payload);

export const kickChatMember = (sessionId, peerType, peerId, targetUserId, opts = {}) =>
  api.delete(`${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/members/${targetUserId}`, {
    params: { ban: opts.ban ? 'true' : 'false', untilDate: opts.untilDate || 0 },
  });

export const setChatAdmin = (sessionId, peerType, peerId, targetUserId, payload) =>
  api.patch(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/members/${targetUserId}/admin`,
    payload,
  );

export const editChatTitle = (sessionId, peerType, peerId, title) =>
  api.patch(`${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/title`, { title });

export const editChatAbout = (sessionId, peerType, peerId, about) =>
  api.patch(`${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/about`, { about });

export const editChatPhoto = (sessionId, peerType, peerId, file) => {
  const fd = new FormData();
  fd.append('photo', file);
  return api.post(`${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/photo`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 0,
  });
};

export const leaveChat = (sessionId, peerType, peerId) =>
  api.post(`${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/leave`);

// --- D7 — settings -------------------------------------------------------

export const getDefaultNotifySettings = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/settings/notifications`);

export const setDefaultNotifySettings = (sessionId, kind, payload) =>
  api.patch(`${BASE}/sessions/${sessionId}/settings/notifications/${kind}`, payload);

export const resetNotifySettings = (sessionId) =>
  api.post(`${BASE}/sessions/${sessionId}/settings/notifications/reset`);

export const getPrivacy = (sessionId, key) =>
  api.get(`${BASE}/sessions/${sessionId}/settings/privacy/${key}`);

export const setPrivacy = (sessionId, key, payload) =>
  api.patch(`${BASE}/sessions/${sessionId}/settings/privacy/${key}`, payload);

export const getLanguage = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/settings/language`);

export const listLanguages = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/settings/languages`);

// --- D8 — security (2FA + active sessions) -------------------------------

export const get2FAState = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/security/2fa`);

export const enable2FA = (sessionId, payload) =>
  api.post(`${BASE}/sessions/${sessionId}/security/2fa/enable`, payload);

export const disable2FA = (sessionId, payload) =>
  api.post(`${BASE}/sessions/${sessionId}/security/2fa/disable`, payload);

export const change2FA = (sessionId, payload) =>
  api.post(`${BASE}/sessions/${sessionId}/security/2fa/change`, payload);

export const listAuthorizations = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/security/authorizations`);

export const resetAuthorization = (sessionId, hash) =>
  api.delete(`${BASE}/sessions/${sessionId}/security/authorizations/${encodeURIComponent(hash)}`);

export const resetOtherAuthorizations = (sessionId) =>
  api.post(`${BASE}/sessions/${sessionId}/security/authorizations/reset-others`);

export const setAuthorizationTtl = (sessionId, days) =>
  api.patch(`${BASE}/sessions/${sessionId}/security/authorizations/ttl`, { days });

// --- D9 — contacts -------------------------------------------------------

export const listContacts = (sessionId, search) =>
  api.get(`${BASE}/sessions/${sessionId}/contacts`, { params: search ? { search } : undefined });

export const searchContactsApi = (sessionId, q, limit = 20) =>
  api.get(`${BASE}/sessions/${sessionId}/contacts/search`, { params: { q, limit } });

export const addContact = (sessionId, payload) =>
  api.post(`${BASE}/sessions/${sessionId}/contacts`, payload);

export const deleteContacts = (sessionId, ids) =>
  api.delete(`${BASE}/sessions/${sessionId}/contacts`, { data: { ids } });

// --- D12 — drafts --------------------------------------------------------

export const getAllDrafts = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/drafts`);

export const saveDraft = (sessionId, peerType, peerId, payload) =>
  api.post(`${BASE}/sessions/${sessionId}/drafts/${peerType}/${peerId}`, payload);

export const clearDraft = (sessionId, peerType, peerId) =>
  api.delete(`${BASE}/sessions/${sessionId}/drafts/${peerType}/${peerId}`);

// --- D13 — pinned messages ----------------------------------------------

export const getPinnedMessages = (sessionId, peerType, peerId, params = {}) =>
  api.get(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/pinned`,
    { params }
  );

export const pinMessage = (sessionId, peerType, peerId, messageId, payload = {}) =>
  api.post(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/pinned/${messageId}`,
    payload
  );

export const unpinMessage = (sessionId, peerType, peerId, messageId) =>
  api.delete(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/pinned/${messageId}`
  );

export const unpinAllMessages = (sessionId, peerType, peerId) =>
  api.delete(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/pinned`
  );

// --- D4 — search ---------------------------------------------------------

export const searchInChat = (sessionId, peerType, peerId, params = {}) =>
  api.get(
    `${BASE}/sessions/${sessionId}/dialogs/${peerType}/${peerId}/search`,
    { params }
  );

export const searchGlobal = (sessionId, params = {}) =>
  api.get(`${BASE}/sessions/${sessionId}/search`, { params });

// --- D11 — stickers / GIFs ----------------------------------------------

export const getStickerSets = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/stickers/sets`);

export const getRecentStickers = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/stickers/recent`);

export const getFavoriteStickers = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/stickers/favorite`);

export const searchStickers = (sessionId, q) =>
  api.get(`${BASE}/sessions/${sessionId}/stickers/search`, { params: { q } });

export const getSavedGifs = (sessionId) =>
  api.get(`${BASE}/sessions/${sessionId}/gifs/saved`);

export const searchGifs = (sessionId, q, offset) =>
  api.get(`${BASE}/sessions/${sessionId}/gifs/search`, {
    params: { q, ...(offset ? { offset } : {}) },
  });

/**
 * Fetch a sticker / GIF document by id+accessHash+fileReference.
 * Returns a blob URL or null on 204. Used by the picker thumbnails.
 */
export const getClientMedia = async (sessionId, payload = {}) => {
  if (!payload.documentId || !payload.accessHash || !payload.fileReference) return null;
  const params = {
    accessHash: String(payload.accessHash),
    fileReference: String(payload.fileReference),
    ...(payload.thumb ? { thumb: 1 } : {}),
  };
  const { data, status } = await api.get(
    `${BASE}/sessions/${sessionId}/documents/${payload.documentId}/media`,
    {
      responseType: 'blob',
      params,
      validateStatus: (s) => (s >= 200 && s < 300) || s === 204,
    }
  );
  if (status === 204 || !data || (data.size != null && data.size === 0)) return null;
  return URL.createObjectURL(data);
};
