import api from './client';

export const getIdentity = (sessionId) =>
  api.get(`/instagram/identity/${sessionId}`);

export const rotateIdentity = (sessionId, opts = {}) =>
  api.post(`/instagram/identity/${sessionId}/rotate`, opts);
