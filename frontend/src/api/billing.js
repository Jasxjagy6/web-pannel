import api from './client';

// User-facing endpoints — accept an optional `platform` arg so per-platform
// billing pages (TG vs IG) can fetch their own pricing / trial config.
// All endpoints fall back to /api/billing/* when no platform is supplied
// for backwards-compat with the pre-multiplatform UI.
const _q = (platform) => (platform ? { params: { platform } } : undefined);

export const getBillingConfig  = (platform) => api.get('/billing/config', _q(platform));
export const getBillingStatus  = (platform) => api.get('/billing/status', _q(platform));

export const startTrial        = (platform) =>
  api.post('/billing/trial/start', platform ? { platform } : undefined);

export const createCheckout    = (opts = {}) =>
  api.post('/billing/checkout', opts);

export const listMyInvoices    = (params) => api.get('/billing/invoices', { params });
export const listMyEvents      = (params) => api.get('/billing/events', { params });
export const refreshInvoice    = (id) => api.post(`/billing/invoices/${id}/refresh`);
