/**
 * REST controller for the IG burner-cookie pool (PR #4 §6.3).
 *
 * Routes (mounted under /api/instagram/burners):
 *   GET    /            listBurners        — pool listing (no decrypted blobs)
 *   POST   /            addBurner          — ingest a cookie blob
 *   DELETE /:id         deleteBurner       — remove a row
 *   POST   /:id/block   blockBurner        — manually retire a burner
 *   GET    /stats       poolStats          — aggregate metrics
 */

'use strict';

const burnerPool = require('../services/burnerPoolService');
const { AppError, asyncHandler } = require('../utils/errorHandler');

function _assertIg(req) {
  if (req.platform && req.platform !== 'instagram') {
    throw new AppError('Burner pool is only available on the Instagram platform.', 400, 'PLATFORM_UNSUPPORTED');
  }
}

const burnerController = {
  listBurners: asyncHandler(async (req, res) => {
    _assertIg(req);
    const includeBlocked = String(req.query.includeBlocked || '').toLowerCase() === 'true';
    const rows = await burnerPool.listBurners({ includeBlocked });
    res.json({ success: true, data: { burners: rows } });
  }),

  addBurner: asyncHandler(async (req, res) => {
    _assertIg(req);
    const { cookieBlob, webFingerprint, boundProxyId, label } = req.body || {};
    if (!cookieBlob) throw new AppError('cookieBlob is required', 400, 'VALIDATION_ERROR');
    try {
      const row = await burnerPool.insertBurner({
        cookieBlob,
        webFingerprint: webFingerprint || null,
        boundProxyId: boundProxyId || null,
        label: label || null,
        createdByUserId: req.user.id,
      });
      res.status(201).json({ success: true, data: { burner: row } });
    } catch (err) {
      throw new AppError(err.message || 'invalid cookie blob', 400, 'VALIDATION_ERROR');
    }
  }),

  deleteBurner: asyncHandler(async (req, res) => {
    _assertIg(req);
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('invalid burner id', 400, 'VALIDATION_ERROR');
    await burnerPool.deleteBurner(id);
    res.json({ success: true });
  }),

  blockBurner: asyncHandler(async (req, res) => {
    _assertIg(req);
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('invalid burner id', 400, 'VALIDATION_ERROR');
    const reason = (req.body && req.body.reason) || 'manual';
    await burnerPool.markBlocked(id, reason);
    res.json({ success: true });
  }),

  poolStats: asyncHandler(async (req, res) => {
    _assertIg(req);
    const stats = await burnerPool.poolStats();
    res.json({ success: true, data: { stats } });
  }),
};

module.exports = burnerController;
