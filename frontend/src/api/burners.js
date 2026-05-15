import api from './client';

// PR #4 burner-cookie pool admin (§6.3). Routes mounted under
// /api/instagram/burners on the backend.

export const listBurners = (params) =>
  api.get('/instagram/burners', { params });

export const addBurner = (data) =>
  api.post('/instagram/burners', data);

export const deleteBurner = (id) =>
  api.delete(`/instagram/burners/${id}`);

export const blockBurner = (id, reason) =>
  api.post(`/instagram/burners/${id}/block`, { reason: reason || 'manual' });

export const getBurnerPoolStats = () =>
  api.get('/instagram/burners/stats');
