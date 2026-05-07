/**
 * /api/me/proxy-providers — REST controller for the auto-rotating
 * proxy provider configuration.
 *
 * One row per (user, vendor) configuration. The actual sticky-IP
 * minting happens automatically inside proxyService.pickProxyForSession
 * once a row is enabled.
 */

const proxyProviderService = require('../services/proxyProviderService');
const { AppError, asyncHandler } = require('../utils/errorHandler');

const proxyProviderController = {
  /** GET /api/me/proxy-providers/vendors — public catalog of supported vendors. */
  vendors: asyncHandler(async (req, res) => {
    const vendors = proxyProviderService.listVendorCatalog();
    return res.json({ success: true, data: { vendors } });
  }),

  /** GET /api/me/proxy-providers — list provider configs for the caller. */
  list: asyncHandler(async (req, res) => {
    const providers = await proxyProviderService.listProviders(req.user.id);
    return res.json({
      success: true,
      data: {
        providers,
        vendors: proxyProviderService.listVendorCatalog(),
      },
    });
  }),

  /** POST /api/me/proxy-providers — create a provider config. */
  add: asyncHandler(async (req, res) => {
    const provider = await proxyProviderService.addProvider(req.user.id, req.body || {});
    return res.status(201).json({ success: true, data: { provider } });
  }),

  /** PATCH /api/me/proxy-providers/:id — partial update. */
  update: asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) throw new AppError('Invalid id', 400, 'BAD_ID');
    const provider = await proxyProviderService.updateProvider(
      req.user.id, id, req.body || {}
    );
    return res.json({ success: true, data: { provider } });
  }),

  /** POST /api/me/proxy-providers/:id/test — health-check the credentials. */
  test: asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) throw new AppError('Invalid id', 400, 'BAD_ID');
    const result = await proxyProviderService.testProvider(req.user.id, id);
    return res.json({ success: true, data: { result } });
  }),

  /** DELETE /api/me/proxy-providers/:id — remove a provider config. */
  remove: asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) throw new AppError('Invalid id', 400, 'BAD_ID');
    const out = await proxyProviderService.deleteProvider(req.user.id, id);
    return res.json({ success: true, data: out });
  }),
};

module.exports = proxyProviderController;
