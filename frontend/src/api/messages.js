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

// Single-User Mass DM. The body shape mirrors the backend validator:
//   { sessionIds | sessionListId, targets: string[1..3], message,
//     messageType?, delaySeconds?, async? }
// Each session DMs every target sequentially with `delaySeconds` between
// sends. The 3-target hard cap and 1..120-second delay band are enforced
// server-side; the form should match those bounds.
export const sendSingleUserMassDm = (data) =>
  api.post('/messages/single-user-mass-dm', data);

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

// ---------------------------------------------------------------------
// Sequential multi-session failover send. Session #1 sends until
// Telegram limits it / refuses (mutual-contact), then hands off to
// session #2 resuming from the same target; target-not-found errors
// skip just that target. Body shape mirrors sendBulk plus:
//   { trackReplies?: boolean, replyWindowHours?: number }
// ---------------------------------------------------------------------
export const sendFailover = (data) => api.post('/messages/failover', data);

// Parallel round-robin mass DM. Every session works in parallel pulling
// the next target off a shared queue (session 1 -> target 1, session 2 ->
// target 2, …); invalid targets are skipped so each session stays busy on
// DIFFERENT users. Finishes a big list in minutes with safe pacing. Body
// shape mirrors sendFailover.
export const sendParallel = (data) => api.post('/messages/parallel', data);

// Per-recipient reply breakdown for a finished send job (job-history
// dropdown: "sent to user 1 — not replied", "sent to user 2 — replied").
export const getJobReplyDetails = (id) => api.get(`/messages/jobs/${id}/replies`);

// Per-session send breakdown: how many sessions were used (sent ≥1 successful
// DM) out of total provided, and how many successful DMs each session sent.
export const getJobSessionBreakdown = (id) => api.get(`/messages/jobs/${id}/session-breakdown`);

// Download a job's recipients as CSV. `type` is 'sent' (everyone the DM
// succeeded on) or 'replied' (those who replied back within 24h). Fetches
// as a blob (auth header is attached by the interceptor) and triggers a
// browser download.
export const exportJobRecipients = async (id, type = 'sent') => {
  const res = await api.get(`/messages/jobs/${id}/export`, {
    params: { type },
    responseType: 'blob',
  });
  const disposition = res.headers?.['content-disposition'] || '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match ? match[1] : `job-${id}-${type}.csv`;
  const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
  return { filename };
};
