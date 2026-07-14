import api from './client';

export const trackingDashboardAPI = {
  getStats: () => api.get('/tracking/dashboard/stats'),
  getCharts: (months) => api.get('/tracking/dashboard/charts', { params: { months } }),
  getRecent: (limit) => api.get('/tracking/dashboard/recent', { params: { limit } }),
  getAlerts: () => api.get('/tracking/dashboard/alerts'),
};
