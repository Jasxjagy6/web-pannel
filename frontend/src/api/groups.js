import api from './client';

export const groupsAPI = {
  addMembers: (data) => api.post('/groups/add-members', data),
  // Dry-run: returns the distribution plan that the runner would
  // use, without sending anything to Telegram.
  previewAddMembers: (data) => api.post('/groups/add-members/preview', data),
  joinChannels: (data) => api.post('/groups/join', data),
  leaveChannels: (data) => api.post('/groups/leave', data),
  configure: (data) => api.post('/groups/configure', data),
  create: (data) => api.post('/groups/create', data),
  list: (params) => api.get('/groups/list', { params }),
  listOperations: (params) => api.get('/groups/operations', { params }),
  getOperation: (id) => api.get(`/groups/operations/${id}`),
  cancelOperation: (id) => api.post(`/groups/operations/${id}/cancel`),
  getInfo: (id, sessionId) => api.get(`/groups/${id}/info`, { params: { sessionId } }),
  removeMember: (id, data) => api.delete(`/groups/${id}/remove-member`, { data }),
};
