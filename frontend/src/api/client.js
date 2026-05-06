import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor: add JWT token + auto-prefix the active platform on
// platform-agnostic relative paths.
//
// To keep call sites simple (e.g. `api.get('/sessions')`), if the URL
// starts with one of the per-platform-noun paths and isn't already
// prefixed with `/telegram/` or `/instagram/`, we prepend the active
// platform from localStorage('panel_platform'). This means a page that
// was written before multiplatform routing — and just calls
// `/sessions` — still hits the right per-platform endpoint after the
// user toggles between TG and IG.
const PLATFORM_AGNOSTIC_NOUNS = new Set([
  'sessions', 'scrape', 'messages', 'messaging', 'groups', 'threads',
  'lists', 'reports', 'proxies', 'twoFAJobs', 'two-fa-jobs',
  'antiDetect', 'anti-detect', 'privacy', 'accountSettings',
  'account-settings', 'otp', 'meta',
]);
function _prefixPlatform(url) {
  if (!url || typeof url !== 'string') return url;
  if (/^https?:\/\//i.test(url)) return url; // absolute URL — leave alone
  // Already prefixed?
  if (/^\/?(telegram|instagram)\//.test(url)) return url;
  // Match the first path segment.
  const stripped = url.replace(/^\/+/, '');
  const seg = stripped.split('/')[0];
  if (!PLATFORM_AGNOSTIC_NOUNS.has(seg)) return url;
  let platform = 'telegram';
  try {
    const stored = localStorage.getItem('panel_platform');
    if (stored === 'telegram' || stored === 'instagram') platform = stored;
  } catch (_) { /* SSR / private mode */ }
  const leading = url.startsWith('/') ? '/' : '';
  return `${leading}${platform}/${stripped}`;
}

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Stamp X-Platform from localStorage so the backend can route
  // requests through the right provider even if the URL is one of the
  // legacy paths still served by /api/* (backwards-compat).
  try {
    const stored = localStorage.getItem('panel_platform');
    if ((stored === 'telegram' || stored === 'instagram') && !config.headers['X-Platform']) {
      config.headers['X-Platform'] = stored;
    }
  } catch (_) { /* SSR */ }
  // Auto-prefix /<platform>/ on platform-agnostic relative paths.
  if (config.url) {
    config.url = _prefixPlatform(config.url);
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
// Pages that are reachable without a valid panel JWT. The auth-failure
// branch below leaves visitors here alone — otherwise a stale token in
// localStorage would force a full-page redirect to /login the moment
// AuthContext fires its boot-time getProfile() call, kicking the user
// off the public landing / register pages.
const PUBLIC_PATHS = new Set(['/', '/landing', '/login', '/register']);

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (isPanelAuthFailure(error) && !PUBLIC_PATHS.has(window.location.pathname)) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    } else if (isPanelAuthFailure(error) && PUBLIC_PATHS.has(window.location.pathname)) {
      // Still clear the now-known-bad credentials so the user appears
      // unauthenticated to React Router (which is what the public
      // pages assume), but don't navigate away from the public page.
      localStorage.removeItem('token');
      localStorage.removeItem('user');
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
    // 402 Payment Required — backend's signal that the user has no
    // active subscription on the platform they just hit. Redirect to
    // /:platform/billing so they can subscribe / start the trial.
    if (error?.response?.status === 402) {
      try {
        const platform = error.response?.data?.error?.platform
          || error.response?.data?.platform
          || error.config?.headers?.['X-Platform']
          || 'telegram';
        const target = `/${platform}/billing`;
        if (window.location.pathname !== target) {
          window.location.href = target;
        }
      } catch (_) { /* SSR safety */ }
    }
    return Promise.reject(error);
  }
);

export default api;
