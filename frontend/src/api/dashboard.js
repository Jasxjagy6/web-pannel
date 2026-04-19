import api from './client';

export const dashboardAPI = {
  stats: () => api.get('/dashboard/stats'),
  activity: (params) => api.get('/dashboard/activity', { params }),
  quickActions: () => api.get('/dashboard/quick-actions'),
};
