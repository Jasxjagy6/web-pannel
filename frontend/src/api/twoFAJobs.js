import api from './client';

// Bulk-mode job: same old/new password applied to many sessions.
export const createBulkJob = (payload) => api.post('/2fa-jobs/bulk', payload);

// Per-session job: each item carries its own old/new password.
export const createIndividualJob = (payload) =>
  api.post('/2fa-jobs/individual', payload);

export const listJobs = (params) => api.get('/2fa-jobs', { params });

export const getJob = (id) => api.get(`/2fa-jobs/${id}`);
