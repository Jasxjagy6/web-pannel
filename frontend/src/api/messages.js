import api from './client';

export const sendMessage = (data) => api.post('/messages/send', data);

export const sendBulk = (data) => api.post('/messages/bulk', data);

export const sendMessageToGroup = (data) => api.post('/messages/send-group', data);

export const forwardMessage = (data) => api.post('/messages/forward', data);

export const getJobs = (params) => api.get('/messages/jobs', { params });

export const getJob = (id) => api.get(`/messages/jobs/${id}`);

export const cancelJob = (id) => api.post(`/messages/jobs/${id}/cancel`);

export const getMessageHistory = (params) => api.get('/messages/history', { params });

export const getMessagingStats = () => api.get('/messages/stats');

export const previewMessage = (data) => api.post('/messages/preview', data);

export const sendBulkToGroups = (data) => api.post('/messages/bulk-groups', data);

export const sendBulkToUsers = (data) => api.post('/messages/bulk-users', data);
