import api from './client';

export const register = (data) => api.post('/auth/register', data);

export const login = (data) => api.post('/auth/login', data);

export const refreshToken = () => api.post('/auth/refresh');

export const getProfile = () => api.get('/auth/profile');

export const updateProfile = (data) => api.put('/auth/profile', data);

export const changePassword = (data) => api.post('/auth/change-password', data);

// Revoke the current JWT's server-side auth_sessions row. Called by
// AuthContext.logout before clearing localStorage so the row goes to
// `revoked_at = NOW()` and disappears from the admin "Active logins"
// view immediately, instead of lingering until the JWT's `exp`.
export const logout = () => api.post('/auth/logout');
