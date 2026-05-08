import api from './client';

export const sendMessage = (data) => api.post('/messages/send', data);

export const sendBulk = (data) => api.post('/messages/bulk', data);

// Dry-run for the bulk-message distribution plan. Returns the plan
// the runner would use without sending anything.
export const previewBulk = (data) => api.post('/messages/bulk/preview', data);

// Single-shot send to a group/channel. The backend route is
// `POST /messages/group` (see backend/src/routes/messages.js); the
// older `/messages/send-group` path 404'd through the catch-all and
// surfaced as a 500 in the UI.
export const sendMessageToGroup = (data) => api.post('/messages/group', data);

export const forwardMessage = (data) => api.post('/messages/forward', data);

export const getJobs = (params) => api.get('/messages/jobs', { params });

export const getJob = (id) => api.get(`/messages/jobs/${id}`);

export const cancelJob = (id) => api.post(`/messages/jobs/${id}/cancel`);

export const getMessageHistory = (params) => api.get('/messages/history', { params });

export const getMessagingStats = () => api.get('/messages/stats');

export const previewMessage = (data) => api.post('/messages/preview', data);

export const sendBulkToGroups = (data) => api.post('/messages/bulk-groups', data);

export const sendBulkToUsers = (data) => api.post('/messages/bulk-users', data);

// ---------------------------------------------------------------------
// Recurring group-message schedules. Backed by `message_schedules`;
// see backend/src/services/messageScheduleService.js. Each schedule
// stores the same selection a one-shot bulk-groups send would, plus
// an `intervalMinutes` cool-down. The server-side tick loop keeps
// re-dispatching the same job after each completion until the
// operator cancels it.
// ---------------------------------------------------------------------

export const createSchedule = (data) => api.post('/messages/schedules', data);

export const listSchedules = (params) => api.get('/messages/schedules', { params });

export const getSchedule = (id) => api.get(`/messages/schedules/${id}`);

export const cancelSchedule = (id) => api.post(`/messages/schedules/${id}/cancel`);

export const cancelAllSchedules = () => api.post('/messages/schedules/cancel-all');
