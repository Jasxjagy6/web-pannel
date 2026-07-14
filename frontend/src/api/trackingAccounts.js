import api from './client';

export const trackingAccountsAPI = {
  list: (params) => api.get('/tracking/accounts', { params }),
  get: (id) => api.get(`/tracking/accounts/${id}`),
  create: (data) => api.post('/tracking/accounts', data),
  update: (id, data) => api.put(`/tracking/accounts/${id}`, data),
  remove: (id) => api.delete(`/tracking/accounts/${id}`),
  restore: (id) => api.post(`/tracking/accounts/${id}/restore`),
  changeStatus: (id, data) => api.post(`/tracking/accounts/${id}/status`, data),

  getSession: (id) => api.get(`/tracking/accounts/${id}/session`),
  updateSession: (id, data) => api.put(`/tracking/accounts/${id}/session`, data),
  uploadSessionFile: (id, formData) => api.post(`/tracking/accounts/${id}/session/file`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }),
  uploadBackupFile: (id, formData) => api.post(`/tracking/accounts/${id}/session/backup`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }),

  getSim: (id) => api.get(`/tracking/accounts/${id}/sim`),
  updateSim: (id, data) => api.put(`/tracking/accounts/${id}/sim`, data),

  getSecurity: (id) => api.get(`/tracking/accounts/${id}/security`),
  updateSecurity: (id, data) => api.put(`/tracking/accounts/${id}/security`, data),

  getPurchase: (id) => api.get(`/tracking/accounts/${id}/purchase`),
  updatePurchase: (id, data) => api.put(`/tracking/accounts/${id}/purchase`, data),

  getSales: (id) => api.get(`/tracking/accounts/${id}/sales`),
  addSale: (id, data) => api.post(`/tracking/accounts/${id}/sales`, data),
  updateSale: (id, saleId, data) => api.put(`/tracking/accounts/${id}/sales/${saleId}`, data),

  getAssignments: (id) => api.get(`/tracking/accounts/${id}/assignments`),
  assign: (id, data) => api.post(`/tracking/accounts/${id}/assignments`, data),
  returnAssignment: (id, assignmentId) => api.post(`/tracking/accounts/${id}/assignments/${assignmentId}/return`),

  getNotes: (id) => api.get(`/tracking/accounts/${id}/notes`),
  addNote: (id, data) => api.post(`/tracking/accounts/${id}/notes`, data),

  getAttachments: (id) => api.get(`/tracking/accounts/${id}/attachments`),
  uploadAttachment: (id, formData) => api.post(`/tracking/accounts/${id}/attachments`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }),
  deleteAttachment: (id, attachmentId) => api.delete(`/tracking/accounts/${id}/attachments/${attachmentId}`),
  downloadAttachment: (id, attachmentId) => api.get(`/tracking/accounts/${id}/attachments/${attachmentId}/download`, {
    responseType: 'blob',
  }),

  getTags: (id) => api.get(`/tracking/accounts/${id}/tags`),
  setTags: (id, tagIds) => api.post(`/tracking/accounts/${id}/tags`, { tagIds }),
  removeTag: (id, tagId) => api.delete(`/tracking/accounts/${id}/tags/${tagId}`),
};
