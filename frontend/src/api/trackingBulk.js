import api from './client';

export const trackingBulkAPI = {
  delete: (ids) => api.post('/tracking/bulk/delete', { ids }),
  status: (ids, status, reservedUntil) => api.post('/tracking/bulk/status', { ids, status, reservedUntil }),
  assign: (ids, data) => api.post('/tracking/bulk/assign', { ids, ...data }),
  tag: (ids, tagIds) => api.post('/tracking/bulk/tags', { ids, tagIds }),
};
