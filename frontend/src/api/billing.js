import api from './client';

// User-facing endpoints
export const getBillingConfig  = () => api.get('/billing/config');
export const getBillingStatus  = () => api.get('/billing/status');

export const startTrial        = () => api.post('/billing/trial/start');
export const createCheckout    = () => api.post('/billing/checkout');

export const listMyInvoices    = (params) => api.get('/billing/invoices', { params });
export const listMyEvents      = (params) => api.get('/billing/events', { params });
export const refreshInvoice    = (id) => api.post(`/billing/invoices/${id}/refresh`);
