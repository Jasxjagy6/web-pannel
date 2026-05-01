import api from './client';

export const scrapeGroup = (data) => api.post('/scrape/group', data);

export const scrapeChannel = (data) => api.post('/scrape/channel', data);

export const listScrapeJobs = (params) => api.get('/scrape/jobs', { params });

export const getScrapeJob = (id) => api.get(`/scrape/jobs/${id}`);

export const getScrapeProgress = (id) => api.get(`/scrape/jobs/${id}/progress`);

export const cancelScrapeJob = (id) => api.post(`/scrape/jobs/${id}/cancel`);

export const exportScrapeJob = (id, data) => api.post(`/scrape/jobs/${id}/export`, data, {
  responseType: 'blob',
});

export const deleteScrapeJob = (id) => api.delete(`/scrape/jobs/${id}`);

export const getScrapeStats = () => api.get('/scrape/jobs/stats');

// ---------------------------------------------------------------------------
// Scrape preview & period-bounded monitor jobs (admin-only chats)
// ---------------------------------------------------------------------------

export const previewScrapeTargets = (data) => api.post('/scrape/preview', data);

export const createMonitorJob = (data) => api.post('/scrape/monitors', data);

export const listMonitorJobs = (params) => api.get('/scrape/monitors', { params });

export const getMonitorJob = (id) => api.get(`/scrape/monitors/${id}`);

export const listMonitorUsers = (id, params) =>
  api.get(`/scrape/monitors/${id}/users`, { params });

export const pauseMonitorJob = (id) => api.post(`/scrape/monitors/${id}/pause`);

export const resumeMonitorJob = (id) => api.post(`/scrape/monitors/${id}/resume`);

export const stopMonitorJob = (id) => api.post(`/scrape/monitors/${id}/stop`);

export const cancelAllMonitorJobs = () => api.post('/scrape/monitors/cancel-all');

export const exportMonitorJob = (id, data) =>
  api.post(`/scrape/monitors/${id}/export`, data, { responseType: 'blob' });
