import api from './client';

export const updateAccountSettings = (data) => api.post('/account-settings/update', data);

export const uploadProfilePhoto = (formData) => 
  api.post('/account-settings/upload-photo', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });

export const getAccountSettings = (sessionId) =>
  api.get(`/account-settings/${sessionId}`);

// Randomize Mode -----------------------------------------------------------

export const getRandomizePools = () =>
  api.get('/account-settings/randomize/pools');

/**
 * Build the URL the frontend can drop into an <img src> to display a bundled
 * avatar. Uses the configured axios baseURL so it works in dev + prod.
 */
export const randomAvatarUrl = (avatarId) => {
  const base = (api.defaults && api.defaults.baseURL) || '';
  return `${base.replace(/\/$/, '')}/account-settings/randomize/avatars/${avatarId}`;
};

// Bulk profile updates touch each selected session sequentially via
// Telegram's MTProto, so they can legitimately take many minutes when
// dozens of sessions are picked. Override the axios default (30s) so
// the request doesn't error out mid-flight while the backend is still
// processing — this was the root cause of the "Time exceeds" toast
// even though the backend completed successfully.
const LONG_RUNNING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export const applyRandomizedAccountSettings = (assignments) =>
  api.post('/account-settings/randomize/apply', { assignments }, {
    timeout: LONG_RUNNING_TIMEOUT_MS,
  });

// Profile List Mode --------------------------------------------------------

/**
 * Build the per-session preview for "Apply Profile List". Returns
 * `{ list, assignments, listSize, sessionCount, repeatsRequired }`.
 * The frontend renders the assignments table and lets the operator
 * re-roll by calling this endpoint again before the final apply.
 */
export const previewProfileList = (payload) =>
  api.post('/account-settings/profile-list/preview', payload);

/**
 * Apply a profile list across the given sessions. Accepts either
 * `{ listId, sessionIds, ...flags }` (server rebuilds assignments) or
 * `{ assignments }` (use the previewed assignments verbatim).
 *
 * Uses an extended axios timeout because the backend updates each
 * session sequentially against Telegram's MTProto — a fleet of 50
 * sessions can easily take 5+ minutes end-to-end.
 */
export const applyProfileList = (payload) =>
  api.post('/account-settings/profile-list/apply', payload, {
    timeout: LONG_RUNNING_TIMEOUT_MS,
  });
