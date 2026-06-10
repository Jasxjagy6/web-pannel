import api from './client';

// -----------------------------------------------------------------------
// IMAP Credential management
// -----------------------------------------------------------------------

export const detectImapSettings = (email) =>
  api.post('/privacy/login-mail/credentials/detect', { email });

export const saveLoginMailCredentials = (data) =>
  api.post('/privacy/login-mail/credentials', data);

export const listLoginMailCredentials = () =>
  api.get('/privacy/login-mail/credentials');

export const deleteLoginMailCredentials = (id) =>
  api.delete(`/privacy/login-mail/credentials/${id}`);

export const testLoginMailCredentials = (id) =>
  api.post(`/privacy/login-mail/credentials/${id}/test`);

// -----------------------------------------------------------------------
// Bulk job management
// -----------------------------------------------------------------------

export const createLoginMailJob = (credentialId, sessionIdsOrBody) => {
  const body =
    Array.isArray(sessionIdsOrBody) || sessionIdsOrBody == null
      ? { credentialId, sessionIds: sessionIdsOrBody || [] }
      : { credentialId, ...sessionIdsOrBody };
  return api.post('/privacy/login-mail/jobs', body);
};

export const listLoginMailJobs = (params) =>
  api.get('/privacy/login-mail/jobs', { params });

export const getLoginMailJob = (id) =>
  api.get(`/privacy/login-mail/jobs/${id}`);

export const getLoginMailJobItems = (id) =>
  api.get(`/privacy/login-mail/jobs/${id}/items`);

export const cancelLoginMailJob = (id) =>
  api.post(`/privacy/login-mail/jobs/${id}/cancel`);

// -----------------------------------------------------------------------
// Manual single-session flow
// -----------------------------------------------------------------------

export const sendLoginMailCode = (sessionId, email) =>
  api.post('/privacy/login-mail/send-code', { sessionId, email });

export const verifyLoginMailCode = (sessionId, code) =>
  api.post('/privacy/login-mail/verify-code', { sessionId, code });
