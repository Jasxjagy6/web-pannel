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

// ---------------------------------------------------------------------
// Instagram-specific privacy surface.
// IG only exposes a single public/private flag + has_anonymous_profile_picture
// at the API level; this is hard-routed at /api/instagram/privacy/* so the
// platform-agnostic prefix interceptor doesn't need to know the URL shape.
// ---------------------------------------------------------------------

export const getInstagramPrivacy = (sessionId) =>
  api.get(`/instagram/privacy/account/${sessionId}`);

export const setInstagramPrivacy = (sessionId, settings) =>
  api.patch(`/instagram/privacy/account/${sessionId}`, settings);
