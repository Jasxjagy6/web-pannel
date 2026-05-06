/**
 * privacyController
 * --------------------------------------------------------------------
 * REST surface for the Privacy bulk-set feature.
 *
 *   GET    /api/privacy/keys            -> { keys, rules, ruleByKey }
 *   POST   /api/privacy/jobs            -> create a new job  (settings + sessionIds)
 *   GET    /api/privacy/jobs            -> list jobs for caller
 *   GET    /api/privacy/jobs/:id        -> single job summary
 *   GET    /api/privacy/jobs/:id/items  -> per-session breakdown
 *   POST   /api/privacy/jobs/:id/cancel -> request cancel
 */

const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const privacyService = require('../services/privacyService');
const reportService = require('../services/reportService');
const logger = require('../utils/logger');

// Map every panel key to the rule set the UI is allowed to submit. The
// 'messages' key is the only one allowed to receive 'premium'.
const RULES_BY_KEY = privacyService.PRIVACY_KEYS.reduce((acc, k) => {
  acc[k] = k === 'messages'
    ? ['everybody', 'premium', 'contacts', 'nobody']
    : ['everybody', 'contacts', 'nobody'];
  return acc;
}, {});

function _validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new AppError('settings must be an object', 400, 'BAD_SETTINGS');
  }
  const cleaned = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!privacyService.PRIVACY_KEYS.includes(key)) {
      throw new AppError(`Unknown privacy key: ${key}`, 400, 'BAD_KEY');
    }
    if (!RULES_BY_KEY[key].includes(value)) {
      throw new AppError(
        `Rule "${value}" is not valid for key "${key}"`,
        400,
        'BAD_RULE'
      );
    }
    cleaned[key] = value;
  }
  if (Object.keys(cleaned).length === 0) {
    throw new AppError('At least one privacy key must be set', 400, 'EMPTY');
  }
  return cleaned;
}

const privacyController = {
  /** GET /api/privacy/keys */
  keys: asyncHandler(async (_req, res) => {
    return res.json({
      success: true,
      data: {
        keys: privacyService.PRIVACY_KEYS,
        rules: privacyService.PRIVACY_RULES,
        ruleByKey: RULES_BY_KEY,
      },
    });
  }),

  /**
   * POST /api/privacy/jobs
   * Body: { settings: { phone_number: 'contacts', ... }, sessionIds: [1,2,3] }
   */
  createJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const body = req.body || {};
    const settings = _validateSettings(body.settings);
    const rawIds = Array.isArray(body.sessionIds) ? body.sessionIds : [];
    const sessionIds = Array.from(
      new Set(
        rawIds
          .map((x) => Number(x))
          .filter((x) => Number.isInteger(x) && x > 0)
      )
    );
    if (sessionIds.length === 0) {
      throw new AppError('Pick at least one session', 400, 'NO_SESSIONS');
    }

    // Restrict to sessions the caller actually owns and that are usable.
    // 'active' / 'uploaded' with is_logged_in=true is what other workers
    // (twoFA, scrape, message) treat as runnable.
    const { rows: ownedRows } = await pool.query(
      `SELECT id FROM sessions
        WHERE user_id = $1
          AND id = ANY($2::int[])
          AND is_logged_in = true
          AND status IN ('active','uploaded')`,
      [userId, sessionIds]
    );
    const ownedIds = ownedRows.map((r) => r.id);
    if (ownedIds.length === 0) {
      throw new AppError(
        'None of the selected sessions are usable for this account',
        400,
        'NO_OWNED_SESSIONS'
      );
    }

    const client = await pool.connect();
    let jobId;
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO privacy_jobs (user_id, settings, status, total_sessions)
         VALUES ($1, $2::jsonb, 'pending', $3)
         RETURNING id, created_at`,
        [userId, JSON.stringify(settings), ownedIds.length]
      );
      jobId = ins.rows[0].id;

      // Bulk-insert items in one round-trip.
      const placeholders = ownedIds.map((_, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO privacy_job_items (job_id, session_id)
         VALUES ${placeholders}`,
        [jobId, ...ownedIds]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    reportService
      .logActivity(userId, 'privacy_job_queued', 'privacy_job', jobId, {
        settings,
        sessionCount: ownedIds.length,
      })
      .catch(() => {});

    logger.info(
      `privacy job ${jobId} queued by user ${userId} (${ownedIds.length} sessions, ` +
        `${Object.keys(settings).length} keys)`
    );
    return res.status(201).json({
      success: true,
      data: {
        jobId,
        sessionCount: ownedIds.length,
        skipped: sessionIds.length - ownedIds.length,
        settings,
      },
    });
  }),

  /** GET /api/privacy/jobs */
  listJobs: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const { rows } = await pool.query(
      `SELECT id, settings, status, total_sessions, succeeded_count,
              failed_count, skipped_count, error_message, cancel_requested,
              created_at, started_at, finished_at
         FROM privacy_jobs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit]
    );
    return res.json({ success: true, data: { items: rows } });
  }),

  /** GET /api/privacy/jobs/:id */
  getJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = Number(req.params.id);
    if (!jobId) throw new AppError('Invalid job id', 400, 'BAD_ID');
    const { rows } = await pool.query(
      `SELECT * FROM privacy_jobs WHERE id = $1 AND user_id = $2`,
      [jobId, userId]
    );
    if (!rows[0]) throw new AppError('Job not found', 404, 'NOT_FOUND');
    return res.json({ success: true, data: rows[0] });
  }),

  /** GET /api/privacy/jobs/:id/items */
  getJobItems: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = Number(req.params.id);
    if (!jobId) throw new AppError('Invalid job id', 400, 'BAD_ID');
    // Guard with a single SELECT-EXISTS check.
    const owned = await pool.query(
      `SELECT 1 FROM privacy_jobs WHERE id = $1 AND user_id = $2`,
      [jobId, userId]
    );
    if (owned.rowCount === 0) {
      throw new AppError('Job not found', 404, 'NOT_FOUND');
    }
    // Per-session metadata (display name, username, phone) lives inside
    // sessions.account_info JSONB so we extract it with -> operators.
    const { rows } = await pool.query(
      `SELECT items.id, items.session_id, items.status, items.results,
              items.error_code, items.error_message, items.attempts,
              items.started_at, items.finished_at,
              s.phone AS phone,
              (s.account_info->>'firstName') AS first_name,
              (s.account_info->>'lastName')  AS last_name,
              (s.account_info->>'username')  AS username
         FROM privacy_job_items items
         JOIN sessions s ON s.id = items.session_id
        WHERE items.job_id = $1
        ORDER BY items.id ASC`,
      [jobId]
    );
    return res.json({ success: true, data: { items: rows } });
  }),

  /** POST /api/privacy/jobs/:id/cancel */
  cancelJob: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const jobId = Number(req.params.id);
    if (!jobId) throw new AppError('Invalid job id', 400, 'BAD_ID');
    const { rowCount } = await pool.query(
      `UPDATE privacy_jobs
          SET cancel_requested = TRUE
        WHERE id = $1 AND user_id = $2
          AND status IN ('pending','running')`,
      [jobId, userId]
    );
    if (rowCount === 0) {
      throw new AppError(
        'Job not found or already finished',
        404,
        'NOT_CANCELLABLE'
      );
    }
    reportService
      .logActivity(userId, 'privacy_job_cancel_requested', 'privacy_job', jobId, {})
      .catch(() => {});
    return res.json({ success: true });
  }),

  // -------------------------------------------------------------------
  // Instagram-specific privacy surface (per-account, single session).
  //
  // Telegram exposes 11 named privacy keys (phone_number, last_seen, ...)
  // each settable to everybody/contacts/nobody. Instagram does NOT —
  // the closest mobile-API surface is `setAccountPrivate / setAccountPublic`
  // plus a handful of comment / message-receipt flags. Modelling this
  // as TG-style keys/jobs would be misleading, so the IG panel hits a
  // dedicated single-session GET/PATCH at /api/instagram/privacy/account/:id.
  // -------------------------------------------------------------------

  /** GET /api/instagram/privacy/account/:sessionId */
  getInstagramPrivacy: asyncHandler(async (req, res) => {
    if (req.platform !== 'instagram') {
      throw new AppError(
        'This endpoint is Instagram-only.',
        400,
        'WRONG_PLATFORM'
      );
    }
    const userId = req.user.id;
    const sessionId = Number(req.params.sessionId);
    if (!sessionId) throw new AppError('Invalid session id', 400, 'BAD_ID');
    const out = await req.provider.privacy.get({ userId, sessionId });
    return res.json({ success: true, data: out });
  }),

  /** PATCH /api/instagram/privacy/account/:sessionId */
  setInstagramPrivacy: asyncHandler(async (req, res) => {
    if (req.platform !== 'instagram') {
      throw new AppError(
        'This endpoint is Instagram-only.',
        400,
        'WRONG_PLATFORM'
      );
    }
    const userId = req.user.id;
    const sessionId = Number(req.params.sessionId);
    if (!sessionId) throw new AppError('Invalid session id', 400, 'BAD_ID');
    const settings = req.body || {};
    if (typeof settings.is_private !== 'boolean'
        && typeof settings.has_anonymous_profile_picture !== 'boolean') {
      throw new AppError(
        'Provide at least one boolean key: is_private, has_anonymous_profile_picture',
        400,
        'EMPTY_SETTINGS'
      );
    }
    const out = await req.provider.privacy.set({ userId, sessionId, settings });
    reportService
      .logActivity(req.user.id, 'instagram_privacy_set', 'session', sessionId, {
        settings,
      })
      .catch(() => {});
    logger.info(
      `IG privacy set user=${req.user.id} session=${sessionId} ` +
      `settings=${JSON.stringify(settings)}`
    );
    return res.json({ success: true, data: out });
  }),
};

module.exports = privacyController;
