const proxyService = require('../services/proxyService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');

const proxyController = {
  /** GET /api/proxies */
  listProxies: asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.source) filter.source = String(req.query.source);
    if (req.query.working === 'true') filter.working = true;
    if (req.query.working === 'false') filter.working = false;
    const proxies = await proxyService.listProxies(filter);
    return res.json({
      success: true,
      data: {
        proxies,
        constants: proxyService.constants,
      },
    });
  }),

  /** POST /api/proxies */
  addProxy: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { host, port, protocol, username, password, secret, priority } = req.body || {};
    if (!host || !port) throw new AppError('host and port required', 400, 'BAD_REQUEST');
    const proxy = await proxyService.addManualProxy({
      host: String(host),
      port: Number(port),
      protocol: protocol ? String(protocol) : undefined,
      username: username ? String(username) : undefined,
      password: password ? String(password) : undefined,
      secret: secret ? String(secret) : undefined,
      priority: priority != null ? Number(priority) : undefined,
    });
    await reportService.logActivity(userId, 'proxy_added', 'proxy', proxy.id, {
      host: proxy.host,
      port: proxy.port,
      protocol: proxy.protocol,
      isWorking: proxy.is_working,
    }).catch(() => {});
    return res.status(201).json({ success: true, data: { proxy } });
  }),

  /** DELETE /api/proxies/:id */
  deleteProxy: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = Number(req.params.id);
    if (!id) throw new AppError('Invalid id', 400, 'BAD_ID');
    const result = await proxyService.deleteProxy(id);
    await reportService.logActivity(userId, 'proxy_deleted', 'proxy', id, {}).catch(() => {});
    return res.json({ success: true, data: result });
  }),

  /** POST /api/proxies/refresh - manually trigger free proxy scrape + revalidate */
  refresh: asyncHandler(async (req, res) => {
    const refreshed = await proxyService.refreshFreeProxies();
    const revalidated = await proxyService.revalidateAll();
    return res.json({ success: true, data: { refreshed, revalidated } });
  }),
};

module.exports = proxyController;
