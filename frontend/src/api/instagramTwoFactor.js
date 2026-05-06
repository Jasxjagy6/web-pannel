/**
 * Instagram-only 2FA API surface.
 * Hard-coded to /api/instagram/two-factor/* — the platform interceptor
 * doesn't auto-prefix these because they don't share a noun with TG.
 */

import api from './client';

export const getStatus = (sessionId) =>
  api.get(`/instagram/two-factor/${sessionId}`);

export const enable = (sessionId) =>
  api.post(`/instagram/two-factor/${sessionId}/enable`);

export const disable = (sessionId) =>
  api.post(`/instagram/two-factor/${sessionId}/disable`);

export const rotate = (sessionId) =>
  api.post(`/instagram/two-factor/${sessionId}/rotate`);
