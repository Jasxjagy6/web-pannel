/**
 * HTTP surface for the session-duplication / QR-login-token export
 * feature.
 *
 * Endpoints (mounted under /api/sessions/clone-export):
 *   POST   /start                 → { jobId }
 *   GET    /:jobId/status         → public job view
 *   POST   /:jobId/password       → { sessionId, password } resolves a 2FA wait
 *   POST   /:jobId/cancel
 *   GET    /:jobId/download       → ZIP bundle
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');

const { AppError, asyncHandler } = require('../utils/errorHandler');
const service = require('../services/sessionDuplicationService');

module.exports = {
  /**
   * POST /start — body: { sessionIds: [..], destApiId, destApiHash,
   *                       interSessionDelayMs? }
   */
  start: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) {
      throw new AppError('Authentication required', 401, 'NO_AUTH');
    }
    const { sessionIds, destApiId, destApiHash, interSessionDelayMs, sharedPassword } = req.body || {};
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError(
        'sessionIds must be a non-empty array of panel session IDs',
        400,
        'BAD_SESSION_IDS'
      );
    }
    if (sessionIds.length > 200) {
      throw new AppError(
        'At most 200 sessions can be cloned per job',
        400,
        'TOO_MANY_SESSIONS'
      );
    }
    if (!destApiId || !destApiHash) {
      throw new AppError(
        'destApiId and destApiHash are required (the credentials the recipient will use to load the cloned sessions)',
        400,
        'MISSING_DEST_CREDENTIALS'
      );
    }
    try {
      const { jobId } = await service.startCloneJob({
        userId,
        sessionIds,
        destApiId,
        destApiHash,
        interSessionDelayMs,
        sharedPassword,
      });
      res.status(202).json({ jobId });
    } catch (err) {
      throw new AppError(err.message, 400, 'CLONE_START_FAILED');
    }
  }),

  /**
   * GET /:jobId/status
   */
  status: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) throw new AppError('Authentication required', 401, 'NO_AUTH');
    const view = service.getJobStatus(req.params.jobId, userId);
    if (!view) {
      throw new AppError('Clone-export job not found', 404, 'JOB_NOT_FOUND');
    }
    res.json(view);
  }),

  /**
   * POST /:jobId/password — body: { sessionId, password }
   */
  submitPassword: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) throw new AppError('Authentication required', 401, 'NO_AUTH');
    const { sessionId, password } = req.body || {};
    if (!sessionId || !password) {
      throw new AppError('sessionId and password are required', 400, 'MISSING_FIELDS');
    }
    const ok = service.submitPassword(req.params.jobId, userId, sessionId, password);
    if (!ok) {
      throw new AppError(
        'No clone is waiting for a 2FA password on this (job, session) pair',
        409,
        'NO_PENDING_PASSWORD'
      );
    }
    res.json({ ok: true });
  }),

  /**
   * POST /:jobId/cancel
   */
  cancel: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) throw new AppError('Authentication required', 401, 'NO_AUTH');
    const ok = service.cancelJob(req.params.jobId, userId);
    if (!ok) throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    res.json({ ok: true });
  }),

  /**
   * GET /:jobId/download — streams the zip bundle. The zip lives on
   * disk under the job's stage directory; we send it directly and let
   * the operator save it.
   */
  download: asyncHandler(async (req, res) => {
    const userId = req.user && req.user.id;
    if (!userId) throw new AppError('Authentication required', 401, 'NO_AUTH');
    const zipPath = service.getJobZipPath(req.params.jobId, userId);
    if (!zipPath) {
      throw new AppError(
        'No completed clone-export ZIP for this job',
        404,
        'ZIP_NOT_READY'
      );
    }
    if (!(await fs.pathExists(zipPath))) {
      throw new AppError(
        'Clone-export ZIP missing on disk (job may have been cleaned up)',
        410,
        'ZIP_GONE'
      );
    }
    // Express's `res.sendFile` mandates an absolute path. The service
    // already resolves `uploadsRoot` to an absolute path, but harden
    // here too so a future regression (or an unusual deployment that
    // sets UPLOAD_DIR via a different code path) cannot turn this
    // endpoint into a 500.
    const absoluteZipPath = path.isAbsolute(zipPath)
      ? zipPath
      : path.resolve(zipPath);
    const filename = path.basename(absoluteZipPath);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.sendFile(absoluteZipPath);
  }),
};
