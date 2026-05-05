/**
 * Controller for the Saved-Messages OTP relay.
 *
 * Routes (mounted under /api/otp-relays):
 *   GET    /                  list this user's attachments
 *   POST   /                  create a watch→relay attachment
 *   PATCH  /:id               update enabled / sender_filter / regex / prefix
 *   DELETE /:id               remove an attachment
 *   GET    /:id/events        recent forward audit log
 */

const otpRelayService = require('../services/otpRelayService');
const { asyncHandler, AppError } = require('../utils/errorHandler');
const logger = require('../utils/logger');

module.exports = {
  list: asyncHandler(async (req, res) => {
    const items = await otpRelayService.listForUser(req.user.id);
    return res.status(200).json({ success: true, data: { items } });
  }),

  create: asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== 'object') {
      throw new AppError('Body required', 400, 'INVALID_REQUEST');
    }
    const created = await otpRelayService.create(req.user.id, req.body);
    logger.info(
      `OTP relay attached: user=${req.user.id} relay=${created.id} ` +
      `watch=${created.watch_session_id} → relay=${created.relay_session_id}`
    );
    return res.status(201).json({ success: true, data: created });
  }),

  update: asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) throw new AppError('id required', 400, 'INVALID_REQUEST');
    const updated = await otpRelayService.update(req.user.id, id, req.body || {});
    return res.status(200).json({ success: true, data: updated });
  }),

  remove: asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) throw new AppError('id required', 400, 'INVALID_REQUEST');
    const r = await otpRelayService.remove(req.user.id, id);
    return res.status(200).json({ success: true, data: r });
  }),

  events: asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) throw new AppError('id required', 400, 'INVALID_REQUEST');
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;
    const events = await otpRelayService.listEvents(req.user.id, id, { limit, offset });
    return res.status(200).json({ success: true, data: { items: events } });
  }),
};
