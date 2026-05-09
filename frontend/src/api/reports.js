import api from './client';

export const reportsAPI = {
  // Per-target reports (existing)
  channel: (id, params) => api.get(`/reports/channel/${id}`, { params }),
  group: (id, params) => api.get(`/reports/group/${id}`, { params }),
  user: (id) => api.get(`/reports/user/${id}`),
  session: (id, params) => api.get(`/reports/session/${id}`, { params }),
  saved: (params) => api.get('/reports/saved', { params }),
  getSaved: (id) => api.get(`/reports/saved/${id}`),
  save: (data) => api.post('/reports/save', data),
  exportReport: (id, format) => api.post(`/reports/export/${id}`, { format }, {
    responseType: 'blob',
  }),
  deleteSaved: (id) => api.delete(`/reports/saved/${id}`),
  activity: (params) => api.get('/reports/activity', { params }),

  // Panel-wide reports (institutional)
  overview: (params) => api.get('/reports/overview', { params }),
  sessionsSummary: (params) => api.get('/reports/sessions/summary', { params }),
  messagingSummary: (params) => api.get('/reports/messaging/summary', { params }),
  scrapingSummary: (params) => api.get('/reports/scraping/summary', { params }),
  groupOpsSummary: (params) => api.get('/reports/group-ops/summary', { params }),
  listsSummary: (params) => api.get('/reports/lists/summary', { params }),
  exportOverview: (params) => api.get('/reports/export/overview', {
    params,
    responseType: 'blob',
  }),
};
