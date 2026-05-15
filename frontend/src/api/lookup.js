import api from './client';

// All paths are absolute under /instagram/lookup so the client's
// platform auto-prefix doesn't double-prefix them.

export const createLookupJob = (data) => api.post('/instagram/lookup', data);

export const listLookupJobs = (params) => api.get('/instagram/lookup/jobs', { params });

export const getLookupJob = (id) => api.get(`/instagram/lookup/jobs/${id}`);

export const getLookupProgress = (id) => api.get(`/instagram/lookup/jobs/${id}/progress`);

export const listLookupFindings = (id, params) =>
  api.get(`/instagram/lookup/jobs/${id}/findings`, { params });

export const cancelLookupJob = (id) => api.post(`/instagram/lookup/jobs/${id}/cancel`);

export const deleteLookupJob = (id) => api.delete(`/instagram/lookup/jobs/${id}`);

export const exportLookupJob = (id, data) =>
  api.post(`/instagram/lookup/jobs/${id}/export`, data, { responseType: 'blob' });
