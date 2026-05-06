import api from './client';

export const getAccount = (sessionId) =>
  api.get(`/instagram/account/${sessionId}`);

export const updateAccount = (sessionId, patch) =>
  api.patch(`/instagram/account/${sessionId}`, patch);

export const uploadPhoto = (sessionId, file) => {
  const fd = new FormData();
  fd.append('photo', file);
  return api.post(`/instagram/account/${sessionId}/photo`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};
