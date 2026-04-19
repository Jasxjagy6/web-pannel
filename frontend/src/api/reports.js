import api from './client';

export const reportsAPI = {
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
};
