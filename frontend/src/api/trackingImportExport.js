import api from './client';

export const trackingImportExportAPI = {
  importAccounts: (formData, format) => api.post('/tracking/import-export/import', formData, {
    params: { format },
    headers: { 'Content-Type': 'multipart/form-data' },
  }),
  importSessionZip: (formData) => api.post('/tracking/import-export/import-sessions-zip', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }),
  exportAccounts: (params) => api.get('/tracking/import-export/export', {
    params,
    responseType: 'blob',
  }),
  downloadTemplate: () => api.get('/tracking/import-export/template', { responseType: 'blob' }),
};
