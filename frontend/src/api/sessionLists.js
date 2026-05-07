import api from './client';

// Same auto-prefixing logic that other resource APIs rely on: the
// platform interceptor in `client.js` prepends /telegram/ or
// /instagram/ to a relative `/session-lists/...` path based on the
// current panel platform. So a call from the IG panel hits
// /api/instagram/session-lists, and from the TG panel
// /api/telegram/session-lists.
export const sessionListsAPI = {
  list: (params) => api.get('/session-lists', { params }),
  create: (data) => api.post('/session-lists', data),
  get: (id) => api.get(`/session-lists/${id}`),
  getSessions: (id, params) => api.get(`/session-lists/${id}/sessions`, { params }),
  update: (id, data) => api.put(`/session-lists/${id}`, data),
  delete: (id) => api.delete(`/session-lists/${id}`),
  addSessions: (id, sessionIds) =>
    api.post(`/session-lists/${id}/sessions`, { sessionIds }),
  removeSessions: (id, sessionIds) =>
    api.delete(`/session-lists/${id}/sessions`, { data: { sessionIds } }),
  setSessions: (id, sessionIds) =>
    api.put(`/session-lists/${id}/sessions`, { sessionIds }),
  // Streams a ZIP archive of every exportable session in the list.
  // `format` is 'json' (default) or 'session'. Returns the raw axios
  // response with `data` as a Blob — the caller is responsible for
  // turning it into an object URL and triggering the download.
  download: (id, { format = 'json' } = {}) =>
    api.get(`/session-lists/${id}/download`, {
      params: { format },
      responseType: 'blob',
    }),
};
