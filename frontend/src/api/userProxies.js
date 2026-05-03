/**
 * BYO Proxy — user-scoped REST client (Phase 3).
 *
 * Hits the /api/me/proxies surface introduced in Phase 2. The
 * platform header (X-Platform) is added automatically by client.js
 * so we don't have to think about it here.
 */

import api from './client';

export const listMyProxies = () => api.get('/me/proxies');
export const addMyProxy = (payload) => api.post('/me/proxies', payload);
export const updateMyProxy = (id, patch) => api.patch(`/me/proxies/${id}`, patch);
export const testMyProxy = (id) => api.post(`/me/proxies/${id}/test`);
export const deleteMyProxy = (id) => api.delete(`/me/proxies/${id}`);
export const bindMyProxy = (id, sessionId) =>
  api.post(`/me/proxies/${id}/bind/${sessionId}`);
