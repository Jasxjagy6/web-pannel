import api from './client';

export const register = (data) => api.post('/auth/register', data);

export const login = (data) => api.post('/auth/login', data);

export const refreshToken = () => api.post('/auth/refresh');

export const getProfile = () => api.get('/auth/profile');

export const updateProfile = (data) => api.put('/auth/profile', data);

export const changePassword = (data) => api.post('/auth/change-password', data);
