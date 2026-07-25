/**
 * User-scoped proxy controller — BYO Proxy, Phase 2.
 *
 * Backs the /api/me/proxies routes. Every method is hard-scoped to
 * `req.user.id`; the underlying service (proxyService) enforces the
 * same scoping at the SQL layer + DB trigger.
 */

const proxyService = require('../services/proxyService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const dedicatedProxyService = require('../services/dedicatedProxyService');

function publicProxy(proxy) {
  if (!proxy) return proxy;
  const {
    password_enc: _passwordEnc,
    secret: _secret,
    ...safe
  } = proxy;
  return safe;
}

const userProxyController = {
  /** GET /api/me/proxies — list proxies owned by the caller. */
  list: asyncHandler(async (req, res) => {
    const proxies = await proxyService.listMyProxies(req.user.id);
    return res.json({
      success: true,
      data: {
        proxies,
        constants: proxyService.constants,
      },
    });
  }),

  /** POST /api/me/proxies — add a BYO proxy. Auto-runs the health probe. */
  add: asyncHandler(async (req, res) => {
    const {
      host, port, protocol, username, password, secret,
      label, country_code: countryCode, notes, metadata, priority,
    } = req.body || {};
    if (!host || !port) {
      throw new AppError('host and port are required', 400, 'BAD_REQUEST');
    }
    const proxy = await proxyService.addMyProxy(req.user.id, {
      host: String(host),
      port: Number(port),
      protocol: protocol ? String(protocol) : undefined,
      username: username ? String(username) : undefined,
      password: password ? String(password) : undefined,
      secret: secret ? String(secret) : undefined,
      priority: priority != null ? Number(priority) : undefined,
      label: label != null ? String(label) : undefined,
      country_code: countryCode != null ? String(countryCode) : undefined,
      notes: notes != null ? String(notes) : undefined,
      metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
    });
    await reportService.logActivity(
      req.user.id,
      'proxy_added',
      'proxy',
      proxy.id,
      { host: proxy.host, port: proxy.port, protocol: proxy.protocol, isWorking: proxy.is_working }
    ).catch(() => {});
    return res.status(201).json({ success: true, data: { proxy: publicProxy(proxy) } });
  }),

  /** POST /api/me/proxies/import - import TXT/CSV/JSON or ZIP proxy files. */
  import: asyncHandler(async (req, res) => {
    const result = await dedicatedProxyService.importProxies(req.user.id, req.file, {
      protocol: req.body?.protocol || 'socks5',
      label: req.body?.label || null,
      country_code: req.body?.country_code || null,
    });
    return res.status(201).json({ success: true, data: result });
  }),

  /** POST /api/me/proxies/recheck - health-check every owned proxy now. */
  recheckAll: asyncHandler(async (req, res) => {
    const result = await dedicatedProxyService.revalidateAll(req.user.id);
    return res.json({ success: true, data: result });
  }),

  /** PATCH /api/me/proxies/:id — update label / notes / country. */
  update: asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) throw new AppError('Invalid id', 400, 'BAD_ID');
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'label')) {
      patch.label = req.body.label;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'notes')) {
      patch.notes = req.body.notes;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'country_code')) {
      patch.country_code = req.body.country_code;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'enabled')) {
      patch.enabled = req.body.enabled === true;
    }
    const proxy = await proxyService.updateMyProxy(req.user.id, id, patch);
    return res.json({ success: true, data: { proxy: publicProxy(proxy) } });
  }),

  /** POST /api/me/proxies/:id/test — re-run the health probe synchronously. */
  test: asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) throw new AppError('Invalid id', 400, 'BAD_ID');
    const proxy = await proxyService.testMyProxy(req.user.id, id);
    return res.json({ success: true, data: { proxy: publicProxy(proxy) } });
  }),

  /** DELETE /api/me/proxies/:id — remove a BYO proxy. */
  remove: asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) throw new AppError('Invalid id', 400, 'BAD_ID');
    const out = await proxyService.deleteMyProxy(req.user.id, id);
    await reportService.logActivity(req.user.id, 'proxy_deleted', 'proxy', id, {})
      .catch(() => {});
    return res.json({ success: true, data: out });
  }),

  /**
   * POST /api/me/proxies/:id/bind/:sessionId — pin a proxy to one of
   * the user's sessions. Used by the CreateSession flow + the
   * Sessions page "Change proxy" action.
   */
  bind: asyncHandler(async (req, res) => {
    const proxyId = Number(req.params.id);
    const sessionId = Number(req.params.sessionId);
    if (!proxyId || !sessionId) throw new AppError('Invalid id', 400, 'BAD_ID');
    const proxy = await proxyService.assignUserProxyToSession(
      req.user.id, sessionId, proxyId, { dedicated: true, requireHealthy: true }
    );
    return res.json({ success: true, data: { proxy: publicProxy(proxy), sessionId } });
  }),
};

module.exports = userProxyController;
