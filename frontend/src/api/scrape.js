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
