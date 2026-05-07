/**
 * Auto-rotating proxy providers — REST client.
 * Backed by /api/me/proxy-providers (see backend/src/routes/proxyProviders.js).
 */

import api from './client';

export const listProxyProviders = () => api.get('/me/proxy-providers');
export const listProxyProviderVendors = () =>
  api.get('/me/proxy-providers/vendors');
export const addProxyProvider = (payload) =>
  api.post('/me/proxy-providers', payload);
export const updateProxyProvider = (id, patch) =>
  api.patch(`/me/proxy-providers/${id}`, patch);
export const testProxyProvider = (id) =>
  api.post(`/me/proxy-providers/${id}/test`);
export const deleteProxyProvider = (id) =>
  api.delete(`/me/proxy-providers/${id}`);
