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
