import api from './client';

// Upload the story media (photo/video). Returns { mediaPath, mediaName, mediaType }.
export const uploadStoryMedia = (formData) =>
  api.post('/stories/upload-media', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 5 * 60 * 1000, // videos can be large
  });

// Create a story upload job across sessions (or a session list). Non-premium
// sessions are skipped automatically by the backend.
export const createStoryJob = (payload) => api.post('/stories/jobs', payload);

// History
export const listStoryJobs = (params = {}) => api.get('/stories/jobs', { params });
export const getStoryJob = (id) => api.get(`/stories/jobs/${id}`);
export const getStoryJobItems = (id) => api.get(`/stories/jobs/${id}/items`);
export const cancelStoryJob = (id) => api.post(`/stories/jobs/${id}/cancel`);
