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

export const applyRandomizedAccountSettings = (assignments) =>
  api.post('/account-settings/randomize/apply', { assignments });
