import api from './client';

export const trackingTagsAPI = {
  list: () => api.get('/tracking/tags'),
  create: (data) => api.post('/tracking/tags', data),
  update: (id, data) => api.put(`/tracking/tags/${id}`, data),
  remove: (id) => api.delete(`/tracking/tags/${id}`),
};
