import api from './client';

export const getAntiDetectStatus = () => api.get('/anti-detect/status');
export const listIdentities = () => api.get('/anti-detect/identities');
export const getIdentity = (sessionId) =>
  api.get(`/anti-detect/identity/${sessionId}`);
export const rotateIdentity = (sessionId, opts = {}) =>
  api.post(`/anti-detect/identity/${sessionId}/rotate`, opts);
export const listBehaviorLogs = (params) =>
  api.get('/anti-detect/logs', { params });
export const runWarmupTick = (payload = {}) =>
  api.post('/anti-detect/warmup/run', payload);
export const runWarmupForSession = (sessionId, action) =>
  api.post(`/anti-detect/warmup/${sessionId}`, action ? { action } : {});
