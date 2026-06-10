import api from './client';

// Well-known IMAP providers (Gmail, Outlook, Yahoo, etc.)
export const getLoginEmailProviders = () =>
  api.get('/privacy/login-email/providers');

// Manual flow: send verification code to email
export const sendLoginEmailCode = (sessionId, email) =>
  api.post('/privacy/login-email/send-code', { sessionId, email });

// Manual flow: verify the code
export const verifyLoginEmailCode = (sessionId, email, code) =>
  api.post('/privacy/login-email/verify-code', { sessionId, email, code });

// Check if a session has a login email configured
export const getLoginEmailStatus = (sessionId) =>
  api.get(`/privacy/login-email/status/${sessionId}`);

// Test IMAP connection
export const testImapConnection = (imapConfig) =>
  api.post('/privacy/login-email/test-imap', imapConfig);

// Automated bulk flow
export const startLoginEmailBulkJob = (payload) =>
  api.post('/privacy/login-email/bulk/start', payload);

export const getLoginEmailBulkStatus = (jobId) =>
  api.get(`/privacy/login-email/bulk/${jobId}/status`);

export const cancelLoginEmailBulkJob = (jobId) =>
  api.post(`/privacy/login-email/bulk/${jobId}/cancel`);
