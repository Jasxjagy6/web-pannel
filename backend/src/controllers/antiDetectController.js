const identityService = require('../services/identityService');
const behaviorService = require('../services/behaviorService');
const fingerprint = require('../utils/deviceFingerprint');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');

const antiDetectController = {
  /** GET /api/anti-detect/status */
  status: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const [identityStats, behaviorStats] = await Promise.all([
      identityService.stats(),
      behaviorService.stats(userId),
    ]);
    return res.json({
      success: true,
      data: {
        identity: identityStats,
        behavior: behaviorStats,
        profilePool: fingerprint.listProfiles().map((p) => ({
          id: p.id,
          platform: p.platform,
          devices: p.deviceModels.length,
          systems: p.systemVersions.length,
          apps: p.appVersions.length,
        })),
      },
    });
  }),

  /** GET /api/anti-detect/identity/:sessionId */
  getIdentity: asyncHandler(async (req, res) => {
    const sessionId = Number(req.params.sessionId);
    if (!sessionId) throw new AppError('Invalid session id', 400, 'BAD_ID');
    const identity = await identityService.load(sessionId);
    return res.json({ success: true, data: { sessionId, identity } });
  }),

  /** POST /api/anti-detect/identity/:sessionId/rotate */
  rotateIdentity: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = Number(req.params.sessionId);
    if (!sessionId) throw new AppError('Invalid session id', 400, 'BAD_ID');
    const identity = await identityService.rotate(sessionId, req.body || {});
    await reportService
      .logActivity(userId, 'device_identity_rotated', 'session', sessionId, {
        platform: identity.platform,
        deviceModel: identity.deviceModel,
      })
      .catch(() => {});
    return res.json({ success: true, data: { sessionId, identity } });
  }),

  /** GET /api/anti-detect/identities */
  listIdentities: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const items = await identityService.forUserId(userId);
    return res.json({ success: true, data: { items } });
  }),

  /** GET /api/anti-detect/logs */
  listLogs: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const filter = {
      userId,
      sessionId: req.query.sessionId ? Number(req.query.sessionId) : undefined,
      action: req.query.action ? String(req.query.action) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    };
    const items = await behaviorService.listLogs(filter);
    return res.json({ success: true, data: { items } });
  }),

  /** POST /api/anti-detect/warmup/run */
  runTick: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionIds = Array.isArray(req.body && req.body.sessionIds)
      ? req.body.sessionIds
      : undefined;
    const result = await behaviorService.tickOnce({
      batchSize: Number(req.body && req.body.batchSize) || undefined,
      sessionIds,
    });
    await reportService
      .logActivity(userId, 'behavior_warmup_tick', 'session', 0, {
        picked: result.picked,
        succeeded: result.succeeded,
        failed: result.failed,
      })
      .catch(() => {});
    return res.json({ success: true, data: result });
  }),

  /** POST /api/anti-detect/warmup/:sessionId */
  runForSession: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sessionId = Number(req.params.sessionId);
    if (!sessionId) throw new AppError('Invalid session id', 400, 'BAD_ID');
    const action = req.body && req.body.action;
    const result = await behaviorService.runForSession(sessionId, action);
    await reportService
      .logActivity(userId, 'behavior_warmup_run', 'session', sessionId, {
        action: result.action,
        succeeded: result.succeeded,
      })
      .catch(() => {});
    return res.json({ success: true, data: { sessionId, ...result } });
  }),
};

module.exports = antiDetectController;
