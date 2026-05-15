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

// ---------------------------------------------------------------------------
// Watches (PR #7)
// ---------------------------------------------------------------------------
export const listLookupWatches = (params) => api.get('/instagram/lookup/watches', { params });
export const createLookupWatch = (data) => api.post('/instagram/lookup/watches', data);
export const deleteLookupWatch = (id) => api.delete(`/instagram/lookup/watches/${id}`);
export const runLookupWatchNow = (id) => api.post(`/instagram/lookup/watches/${id}/run`);

// ---------------------------------------------------------------------------
// Per-user API key vault (PR #5 / #6)
// ---------------------------------------------------------------------------
export const listLookupKeys = () => api.get('/instagram/lookup/keys');
export const upsertLookupKey = (data) => api.put('/instagram/lookup/keys', data);
export const deleteLookupKey = (provider) =>
  api.delete(`/instagram/lookup/keys/${encodeURIComponent(provider)}`);

// ---------------------------------------------------------------------------
// Per-user budget (PR #8)
// ---------------------------------------------------------------------------
export const getLookupBudget = () => api.get('/instagram/lookup/budget');
export const setLookupBudget = (data) => api.put('/instagram/lookup/budget', data);

// ---------------------------------------------------------------------------
// Audit + dashboards
// ---------------------------------------------------------------------------
export const listLookupAudit = (params) => api.get('/instagram/lookup/audit', { params });
export const getLookupUsage = (params) => api.get('/instagram/lookup/usage', { params });
export const getLookupRiskDashboard = () => api.get('/instagram/lookup/admin/risk');
