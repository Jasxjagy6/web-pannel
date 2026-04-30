import api from './client';

export const listProxies = (params) => api.get('/proxies', { params });
export const addProxy = (payload) => api.post('/proxies', payload);
export const deleteProxy = (id) => api.delete(`/proxies/${id}`);
export const refreshProxies = () => api.post('/proxies/refresh');
