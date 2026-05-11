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

/**
 * Trigger a session download in the requested format.
 *
 * @param {number|string} id            session id
 * @param {string}        suggestedName filename hint (extension is overridden
 *                                      to match `format` so the operator
 *                                      always gets a correctly-typed file)
 * @param {object}        [opts]
 * @param {'json'|'session'} [opts.format='json'] download format. `json` is
 *   the legacy GramJS envelope; `session` is a Telethon-native SQLite
 *   .session file (built server-side from the GramJS auth_key).
 */
export const downloadSession = async (
  id,
  suggestedName = 'session.json',
  opts = {},
) => {
  const format = opts.format === 'session' ? 'session' : 'json';
  const response = await api.get(`/sessions/${id}/download`, {
    responseType: 'blob',
    params: { format },
  });
  const blob = response.data;
  const url = URL.createObjectURL(blob);
  // Force the file extension to match the chosen format so users don't
  // end up with foo.json that's actually a SQLite blob (or vice versa).
  const baseName = String(suggestedName).replace(/\.(session|json)$/i, '');
  const finalName = `${baseName}.${format}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = finalName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ── QR-login clone export ──────────────────────────────────────────
// The panel uses Telegram's auth.ExportLoginToken /
// auth.AcceptLoginToken / auth.ImportLoginToken RPCs to mint a
// brand-new authorization (a fresh auth_key) for each selected
// session, under a destination api_id/api_hash supplied by the
// operator. The original session is NOT logged out; both
// authorizations coexist in Telegram's "Active sessions" UI.

export const startCloneExport = (payload) =>
  api.post('/sessions/clone-export/start', payload);

export const getCloneExportStatus = (jobId) =>
  api.get(`/sessions/clone-export/${jobId}/status`);

export const submitCloneExportPassword = (jobId, sessionId, password) =>
  api.post(`/sessions/clone-export/${jobId}/password`, { sessionId, password });

export const cancelCloneExport = (jobId) =>
  api.post(`/sessions/clone-export/${jobId}/cancel`);

export const downloadCloneExportZip = async (jobId) => {
  const response = await api.get(`/sessions/clone-export/${jobId}/download`, {
    responseType: 'blob',
  });
  const blob = response.data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `clone-export-${jobId}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
