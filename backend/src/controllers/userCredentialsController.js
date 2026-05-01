const service = require('../services/userApiCredentialsService');
const { asyncHandler } = require('../utils/errorHandler');

/**
 * REST surface for the per-user Telegram API credential vault. Mounted
 * under /api/user-credentials. Authentication is required but
 * `requireApproved` is NOT applied here — the user must be able to
 * configure credentials before the rest of the panel is unlocked.
 */
module.exports = {
  list: asyncHandler(async (req, res) => {
    const items = await service.list(req.user.id);
    res.json({ success: true, data: { items } });
  }),

  get: asyncHandler(async (req, res) => {
    const item = await service.getById(req.user.id, parseInt(req.params.id, 10));
    res.json({ success: true, data: item });
  }),

  create: asyncHandler(async (req, res) => {
    const item = await service.create(req.user.id, {
      label: req.body.label,
      apiId: req.body.apiId,
      apiHash: req.body.apiHash,
      maxSessions: req.body.maxSessions,
      notes: req.body.notes,
    });
    res.status(201).json({ success: true, data: item });
  }),

  update: asyncHandler(async (req, res) => {
    const item = await service.update(req.user.id, parseInt(req.params.id, 10), {
      label: req.body.label,
      apiHash: req.body.apiHash,
      maxSessions: req.body.maxSessions,
      isActive: req.body.isActive,
      notes: req.body.notes,
    });
    res.json({ success: true, data: item });
  }),

  remove: asyncHandler(async (req, res) => {
    await service.remove(req.user.id, parseInt(req.params.id, 10));
    res.json({ success: true });
  }),
};
