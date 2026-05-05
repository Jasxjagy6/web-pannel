import api from './client';

export const uploadSessions = (formData) =>
  api.post('/sessions/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });

export const listSessions = (params) => api.get('/sessions', { params });

export const getSession = (id) => api.get(`/sessions/${id}`);

export const loginSession = (id) => api.post(`/sessions/${id}/login`);

export const logoutSession = (id) => api.post(`/sessions/${id}/logout`);

// Anti-revoke Phase 4 — re-import a session that's been marked
// status='revoked' if its encrypted on-disk file (or one of the
// recent session_backups rows) is still accepted by Telegram.
// Telegram-only.
export const recoverSession = (id) => api.post(`/sessions/${id}/recover`);

export const deleteSession = (id) => api.delete(`/sessions/${id}`);

export const bulkDeleteSessions = (ids) =>
  api.post('/sessions/bulk-delete', { sessionIds: ids });

export const checkSessionStatus = (id) => api.get(`/sessions/${id}/status`);

export const getSessionStats = () => api.get('/sessions/stats');

// Upgrade 5 — interactive session creation flow.
export const createSessionStart = (payload) =>
  api.post('/sessions/create/start', payload);
export const createSessionVerify = (payload) =>
  api.post('/sessions/create/verify', payload);
export const createSessionPassword = (payload) =>
  api.post('/sessions/create/password', payload);
export const createSessionResend = (payload) =>
  api.post('/sessions/create/resend', payload);
export const createSessionCancel = (payload) =>
  api.post('/sessions/create/cancel', payload);

/**
 * Trigger a download of the encrypted session JSON for a given session id.
 * Uses the configured axios instance (so the JWT is attached) and synthesises
 * a temporary <a> tag to invoke the browser's download flow.
 */
// --- Instagram-only session-health surface ---
// These endpoints only exist on the IG side (see backend
// sessions router). Calling them on a TG session returns 404.

export const getSessionHealth = (id) => api.get(`/sessions/${id}/health`);

export const runSessionHealthCheck = (id) =>
  api.post(`/sessions/${id}/health/check`);

export const setSessionProxy = (id, proxyUrl) =>
  api.patch(`/sessions/${id}/proxy`, { proxyUrl });

export const downloadSession = async (id, suggestedName = 'session.json') => {
  const response = await api.get(`/sessions/${id}/download`, {
    responseType: 'blob',
  });
  const blob = response.data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
