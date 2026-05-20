/**
 * Reddit cookie-scraper API client.
 *
 * Mounted under /api/reddit on the backend (platform-agnostic — the
 * panel client.js interceptor leaves /reddit paths alone instead of
 * prefixing them with /telegram or /instagram).
 */

import api from './client';

// Formats / metadata
export const listFormats = () => api.get('/reddit/formats');

// Account CRUD
export const listAccounts = () => api.get('/reddit/accounts');
export const getAccount = (id) => api.get(`/reddit/accounts/${id}`);
export const createAccount = (payload) => api.post('/reddit/accounts', payload);
export const updateAccount = (id, payload) => api.patch(`/reddit/accounts/${id}`, payload);
export const deleteAccount = (id) => api.delete(`/reddit/accounts/${id}`);

// Scrape trigger + history
export const triggerScrape = (id) => api.post(`/reddit/accounts/${id}/scrape`, {});
export const listJobs = (id, params) => api.get(`/reddit/accounts/${id}/jobs`, { params });
export const latestCookies = (id) => api.get(`/reddit/accounts/${id}/cookies/latest`);

// Per-job
export const getJob = (jobId) => api.get(`/reddit/jobs/${jobId}`);
export const listJobCookies = (jobId) => api.get(`/reddit/jobs/${jobId}/cookies`);

/**
 * Helper for the export-modal "preview" button — fetches the export
 * body as text so we can render it inline.
 */
export const previewExport = (jobId, format) =>
  api.get(`/reddit/jobs/${jobId}/export/${format}`, {
    responseType: 'text',
    transformResponse: [(d) => d],
  });

/**
 * Fetch the export body as a Blob and trigger a browser file save.
 * Goes through axios so the JWT bearer token is honoured.
 */
export async function downloadExport(jobId, format) {
  const resp = await api.get(`/reddit/jobs/${jobId}/export/${format}`, {
    responseType: 'blob',
  });
  // Try to read filename from Content-Disposition.
  const cd = resp.headers['content-disposition'] || '';
  const m = /filename="([^"]+)"/.exec(cd);
  const filename = (m && m[1]) || `reddit_cookies_${jobId}_${format}.bin`;
  const url = window.URL.createObjectURL(resp.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}
