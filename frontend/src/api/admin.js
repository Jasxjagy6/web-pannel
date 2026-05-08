import api from './client';

export const getSystemStats = () => api.get('/admin/stats');
export const getRecentActions = (params) => api.get('/admin/actions', { params });

export const listUsers = (params) => api.get('/admin/users', { params });
export const getUser = (id) => api.get(`/admin/users/${id}`);
export const deleteUser = (id) => api.delete(`/admin/users/${id}`);

export const approveUser = (id) => api.post(`/admin/users/${id}/approve`);
export const banUser = (id, reason) => api.post(`/admin/users/${id}/ban`, { reason });
export const unbanUser = (id) => api.post(`/admin/users/${id}/unban`);

export const setSubscription = (id, payload) =>
  api.put(`/admin/users/${id}/subscription`, payload);

// Per-platform subscription editor (used by the multi-platform admin UI).
export const listUserPlatformSubscriptions = (id) =>
  api.get(`/admin/users/${id}/subscriptions`);

export const setUserPlatformSubscription = (id, platform, payload) =>
  api.put(`/admin/users/${id}/subscriptions/${platform}`, payload);

// ---------------------------------------------------------------------
// Billing — admin endpoints
// ---------------------------------------------------------------------
export const getBillingSettings = () => api.get('/admin/billing/settings');
export const updateBillingSettings = (data) =>
  api.put('/admin/billing/settings', data);

export const listAdminInvoices = (params) =>
  api.get('/admin/billing/invoices', { params });

export const getUserInvoices = (id, params) =>
  api.get(`/admin/billing/users/${id}/invoices`, { params });

export const grantUserSubscription = (id, payload) =>
  api.post(`/admin/billing/users/${id}/grant`, payload);

export const expireUserSubscription = (id, payload) =>
  api.post(`/admin/billing/users/${id}/expire`, payload);

// ---------------------------------------------------------------------
// Anti-revoke (Telegram) — Phase 3 admin endpoints
// ---------------------------------------------------------------------
// /api/admin/tg-detection-events — recent revocation/flood/migrate events
// /api/admin/tg-risk             — top-N highest-scoring sessions
// /api/admin/tg-session-health   — single-session health detail
//
export const listTgDetectionEvents = (params) =>
  api.get('/admin/tg-detection-events', { params });

export const getTgRiskOverview = (params) =>
  api.get('/admin/tg-risk', { params });

export const getTgSessionHealth = (sessionId) =>
  api.get(`/admin/tg-session-health/${sessionId}`);

// ---------------------------------------------------------------------
// BYO Proxy — admin (Phase 2/3). The legacy shared pool plus the
// cross-user usage matrix.
// ---------------------------------------------------------------------
export const adminListProxies = (params) =>
  api.get('/admin/proxies', { params });
export const adminAddProxy = (payload) =>
  api.post('/admin/proxies', payload);
export const adminDeleteProxy = (id) =>
  api.delete(`/admin/proxies/${id}`);
export const adminRefreshProxies = () =>
  api.post('/admin/proxies/refresh');
export const adminProxyUsage = () =>
  api.get('/admin/proxies/usage');

// Global proxy switch (system_settings.proxy.global_enabled).
// When false the panel drops every proxy and egresses from the VPS IP.
export const getProxySettings = () => api.get('/admin/proxy/settings');
export const updateProxySettings = (data) =>
  api.put('/admin/proxy/settings', data);
