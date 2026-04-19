import api from './client';

export const listsAPI = {
  importList: (formData) => api.post('/lists/import', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }),
  createFromScrape: (data) => api.post('/lists/from-scrape', data),
  merge: (data) => api.post('/lists/merge', data),
  deduplicate: (id) => api.post(`/lists/${id}/deduplicate`),
  list: (params) => api.get('/lists', { params }),
  get: (id) => api.get(`/lists/${id}`),
  getItems: (id, params) => api.get(`/lists/${id}/items`, { params }),
  getStats: (id) => api.get(`/lists/${id}/stats`),
  update: (id, data) => api.put(`/lists/${id}`, data),
  delete: (id) => api.delete(`/lists/${id}`),
  exportList: (id, format) => api.post(`/lists/${id}/export`, { format }, {
    responseType: 'blob',
  }),
  addItems: (id, data) => api.post(`/lists/${id}/items`, data),
  removeItems: (id, data) => api.post(`/lists/${id}/items/remove`, data),
};
