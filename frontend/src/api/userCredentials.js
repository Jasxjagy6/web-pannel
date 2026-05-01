import api from './client';

// REST surface for the per-user Telegram API ID/Hash vault. Backed
// by `routes/userCredentials.js` on the server. These endpoints are
// authenticated but do NOT require an active subscription or the
// new "must have credentials" gate, so the user can always reach
// them from Settings even before they're fully onboarded.

export const listCredentials = () => api.get('/user-credentials');
export const getCredential = (id) => api.get(`/user-credentials/${id}`);
export const createCredential = (data) => api.post('/user-credentials', data);
export const updateCredential = (id, data) => api.put(`/user-credentials/${id}`, data);
export const deleteCredential = (id) => api.delete(`/user-credentials/${id}`);
