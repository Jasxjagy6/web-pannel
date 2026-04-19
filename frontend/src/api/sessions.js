import api from './client';

export const uploadSessions = (formData) =>
  api.post('/sessions/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });

export const listSessions = (params) => api.get('/sessions', { params });

export const getSession = (id) => api.get(`/sessions/${id}`);

export const loginSession = (id) => api.post(`/sessions/${id}/login`);

export const logoutSession = (id) => api.post(`/sessions/${id}/logout`);

export const deleteSession = (id) => api.delete(`/sessions/${id}`);

export const bulkDeleteSessions = (ids) =>
  api.post('/sessions/bulk-delete', { sessionIds: ids });

export const checkSessionStatus = (id) => api.get(`/sessions/${id}/status`);

export const getSessionStats = () => api.get('/sessions/stats');
