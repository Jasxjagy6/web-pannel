import api from './client';

export const startScan = (payload) => api.post('/otp/jobs', payload);
export const listJobs = (params) => api.get('/otp/jobs', { params });
export const getJob = (id) => api.get(`/otp/jobs/${id}`);
