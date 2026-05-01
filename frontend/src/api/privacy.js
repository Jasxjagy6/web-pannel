import api from './client';

export const getPrivacyKeys = () => api.get('/privacy/keys');

export const createPrivacyJob = (settings, sessionIds) =>
  api.post('/privacy/jobs', { settings, sessionIds });

export const listPrivacyJobs = (params) =>
  api.get('/privacy/jobs', { params });

export const getPrivacyJob = (id) => api.get(`/privacy/jobs/${id}`);

export const getPrivacyJobItems = (id) =>
  api.get(`/privacy/jobs/${id}/items`);

export const cancelPrivacyJob = (id) =>
  api.post(`/privacy/jobs/${id}/cancel`);
