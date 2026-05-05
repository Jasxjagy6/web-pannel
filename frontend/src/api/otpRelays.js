import api from './client';

// Saved-Messages OTP Relay — Telegram-only.
// Backed by backend/src/routes/otpRelays.js (mounted at
// /api/telegram/otp-relays and /api/otp-relays).

export const listOtpRelays = () => api.get('/otp-relays');

export const createOtpRelay = (payload) => api.post('/otp-relays', payload);

export const updateOtpRelay = (id, patch) =>
  api.patch(`/otp-relays/${id}`, patch);

export const deleteOtpRelay = (id) => api.delete(`/otp-relays/${id}`);

export const listOtpRelayEvents = (id, { limit = 50, offset = 0 } = {}) =>
  api.get(`/otp-relays/${id}/events`, { params: { limit, offset } });
