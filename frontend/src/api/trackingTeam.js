import api from './client';

export const trackingTeamAPI = {
  getMe: () => api.get('/tracking/team/me'),
  list: () => api.get('/tracking/team'),
  addMember: (data) => api.post('/tracking/team', data),
  updateMember: (userId, data) => api.put(`/tracking/team/${userId}`, data),
  removeMember: (userId) => api.delete(`/tracking/team/${userId}`),
};
