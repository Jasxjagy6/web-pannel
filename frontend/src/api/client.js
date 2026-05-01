import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor: add JWT token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Error codes that mean the panel JWT itself is invalid/expired and the
// admin needs to log in again. Anything else (including 401s from the
// per-Telegram-session login endpoint, e.g. AUTH_KEY_DUPLICATED) must NOT
// log the admin out of the panel — it's a domain-level error to surface
// to the user via a toast.
const PANEL_AUTH_FAILURE_CODES = new Set([
  'AUTH_REQUIRED',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'USER_NOT_FOUND',
  'INVALID_CREDENTIALS',
]);

function isPanelAuthFailure(error) {
  if (error?.response?.status !== 401) return false;
  const url = error.config?.url || '';
  // /auth/login itself returning 401 is an INVALID_CREDENTIALS attempt —
  // not a session that needs to be cleared (the user isn't logged in yet).
  if (url.includes('/auth/login')) return false;
  const code = error.response?.data?.error?.code || error.response?.data?.code;
  if (code && PANEL_AUTH_FAILURE_CODES.has(code)) return true;
  // Fallback: 401 on /auth/* endpoints (profile, refresh) means the panel
  // JWT is bad. Anything else (e.g. /sessions/:id/login, /reports/...) is a
  // domain-level 401 that must be propagated to the caller, not redirected.
  if (url.includes('/auth/')) return true;
  return false;
}

// Response interceptor: clear creds + redirect ONLY when the panel JWT is
// the thing that's broken. Otherwise propagate so the caller can show a
// useful error.
//
// v8: also intercept the dedicated 412 API_CREDENTIALS_REQUIRED status
// (raised by the per-user Telegram credentials gate) and dispatch a
// global event so any mounted MissingApiCredsModal can pop up,
// regardless of which page made the request.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (isPanelAuthFailure(error) && window.location.pathname !== '/login') {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    if (error?.response?.status === 412) {
      const code = error.response?.data?.error?.code || error.response?.data?.code;
      if (code === 'API_CREDENTIALS_REQUIRED') {
        try {
          window.dispatchEvent(new CustomEvent('missing-api-creds', {
            detail: {
              message: error.response?.data?.error?.message
                || 'Set up your Telegram API ID and Hash in Settings to use the panel.',
            },
          }));
        } catch (_) { /* SSR safety */ }
      }
    }
    return Promise.reject(error);
  }
);

export default api;
