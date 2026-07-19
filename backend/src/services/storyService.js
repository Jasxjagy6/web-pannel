/**
 * storyService — create + manage "Upload Story" jobs.
 *
 * The operator uploads one photo/video (optionally with a caption + link)
 * and picks sessions (or a session list). We create a story_jobs row plus
 * one story_job_items row per selected session, then let storyJobWorker
 * process them in the background (post the story on each Premium account,
 * skip non-Premium ones). The frontend polls job + items for history.
 *
 * Premium note: Stories are Premium-only. We pre-filter using the cached
 * account_info.isPremium flag so obviously-ineligible sessions are marked
 * skipped up front, and the worker double-checks each remaining session
 * with stories.CanSendStory at send time (authoritative).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');

const UPLOAD_DIR = path.join(os.tmpdir(), 'telegram-panel', 'uploads');

// Telegram-allowed story lifetimes (seconds).
const ALLOWED_PERIODS = new Set([6 * 3600, 12 * 3600, 24 * 3600, 48 * 3600]);
const VALID_PRIVACY = new Set(['everyone', 'contacts', 'close_friends']);

const storyService = {
  /**
   * Persist an uploaded story media file to the panel tmp uploads dir and
   * return its absolute path. Mirrors accountSettingsService.saveProfilePhoto.
   */
  async saveStoryMedia(file, userId) {
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
    const ext = path.extname(file.name || '') || '';
    const fileName = `story_${userId}_${Date.now()}${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileName);
    if (file.mv) {
      await file.mv(filePath);
    } else {
      fs.writeFileSync(filePath, file.data);
    }
    return { filePath, fileName: file.name || fileName };
  },

  _isUnderUploadDir(p) {
    if (typeof p !== 'string' || !p.length) return false;
    const resolved = path.resolve(p);
    const root = path.resolve(UPLOAD_DIR);
    return resolved === root || resolved.startsWith(root + path.sep);
  },

  /**
   * Create a story upload job.
   *
   * @param {object} params
   * @param {string} params.mediaPath   - abs path from saveStoryMedia
   * @param {'photo'|'video'} params.mediaType
   * @param {string} [params.mediaName]
   * @param {string} [params.caption]
   * @param {string} [params.linkUrl]
   * @param {string} [params.privacy]
   * @param {number} [params.periodSeconds]
   * @param {boolean} [params.pinToProfile]
   * @param {number[]} params.sessionIds - resolved session ids to target
   * @param {number} userId
   * @returns {Promise<{ jobId:number, total:number, eligible:number, skippedNonPremium:number }>}
   */
  async createJob(params, userId) {
    const {
      mediaPath,
      mediaType,
      mediaName = null,
      caption = '',
      linkUrl = '',
      privacy = 'everyone',
      periodSeconds = 86400,
      pinToProfile = false,
      sessionIds,
    } = params;

    if (!userId) throw new AppError('User ID is required', 400, 'MISSING_USER_ID');
    if (!mediaPath || !this._isUnderUploadDir(mediaPath) || !fs.existsSync(mediaPath)) {
      throw new AppError('Story media is missing — re-upload the file', 400, 'MEDIA_NOT_FOUND');
    }
    if (!['photo', 'video'].includes(mediaType)) {
      throw new AppError('mediaType must be photo or video', 400, 'BAD_MEDIA_TYPE');
    }
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new AppError('At least one session is required', 400, 'NO_SESSIONS');
    }
    const link = String(linkUrl || '').trim();
    if (link && !/^https?:\/\//i.test(link)) {
      throw new AppError('Link must start with http:// or https://', 400, 'BAD_LINK');
    }
    const period = ALLOWED_PERIODS.has(Number(periodSeconds)) ? Number(periodSeconds) : 86400;
    const priv = VALID_PRIVACY.has(privacy) ? privacy : 'everyone';

    const ids = Array.from(new Set(
      sessionIds.map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0)
    ));

    // Verify ownership + pull premium flag + connection-worthiness.
    const { rows: owned } = await pool.query(
      `SELECT id, phone, username, is_logged_in, status,
              account_info->>'isPremium' AS is_premium,
              account_info->>'firstName' AS first_name
         FROM sessions
        WHERE id = ANY($1::int[]) AND user_id = $2 AND platform = 'telegram'`,
      [ids, userId]
    );
    if (owned.length === 0) {
      throw new AppError('No valid sessions found for this user', 404, 'NO_VALID_SESSIONS');
    }

    // Pre-classify each owned session. Non-premium and not-logged-in are
    // pre-skipped so the job history is honest from the start; the worker
    // will still re-verify premium via CanSendStory for the rest.
    const items = owned.map((s) => {
      const label = s.username ? `@${s.username}` : (s.first_name || s.phone || `#${s.id}`);
      let status = 'pending';
      let skipReason = null;
      if (!s.is_logged_in) {
        status = 'skipped';
        skipReason = 'not_connected';
      } else if (String(s.is_premium) !== 'true') {
        status = 'skipped';
        skipReason = 'not_premium';
      }
      return { sessionId: s.id, phone: s.phone, label, status, skipReason };
    });

    const total = items.length;
    const preSkipped = items.filter((i) => i.status === 'skipped').length;
    const eligible = total - preSkipped;

    const client = await pool.connect();
    let jobId;
    try {
      await client.query('BEGIN');
      const jobRes = await client.query(
        `INSERT INTO story_jobs
           (user_id, media_path, media_type, media_name, caption, link_url,
            privacy, period_seconds, pin_to_profile, status, total_sessions,
            skipped_count, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11, NOW())
         RETURNING id`,
        [userId, mediaPath, mediaType, mediaName, caption || null, link || null,
         priv, period, !!pinToProfile, total, preSkipped]
      );
      jobId = jobRes.rows[0].id;

      // Bulk-insert items.
      const vals = [];
      const ph = [];
      let p = 1;
      for (const it of items) {
        ph.push(`($${p},$${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5})`);
        vals.push(jobId, it.sessionId, it.phone, it.label, it.status, it.skipReason);
        p += 6;
      }
      await client.query(
        `INSERT INTO story_job_items
           (job_id, session_id, phone, session_label, status, skip_reason)
         VALUES ${ph.join(', ')}`,
        vals
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    logger.info(
      `storyService: created job ${jobId} (user=${userId} total=${total} ` +
      `eligible=${eligible} preSkipped=${preSkipped})`
    );
    return { jobId, total, eligible, skippedNonPremium: preSkipped };
  },

  /** List a user's story jobs (history), most recent first. */
  async listJobs(userId, { limit = 30, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 30));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const { rows } = await pool.query(
      `SELECT id, media_type, media_name, caption, link_url, privacy,
              period_seconds, pin_to_profile, status, total_sessions,
              succeeded_count, failed_count, skipped_count, error_message,
              created_at, started_at, finished_at
         FROM story_jobs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, lim, off]
    );
    return rows;
  },

  /** One job with ownership check. */
  async getJob(jobId, userId) {
    const { rows } = await pool.query(
      `SELECT * FROM story_jobs WHERE id = $1 AND user_id = $2`,
      [Number(jobId), userId]
    );
    if (rows.length === 0) throw new AppError('Story job not found', 404, 'JOB_NOT_FOUND');
    return rows[0];
  },

  /** Per-session items for a job (history detail). */
  async getJobItems(jobId, userId) {
    // Ownership via the parent job.
    await this.getJob(jobId, userId);
    const { rows } = await pool.query(
      `SELECT session_id, phone, session_label, status, skip_reason,
              story_id, error_message, attempts, started_at, finished_at
         FROM story_job_items
        WHERE job_id = $1
        ORDER BY id ASC`,
      [Number(jobId)]
    );
    return rows;
  },

  /** Request cancellation. The worker stops before the next pending item. */
  async cancelJob(jobId, userId) {
    const job = await this.getJob(jobId, userId);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      throw new AppError(`Cannot cancel a ${job.status} job`, 400, 'NOT_CANCELABLE');
    }
    await pool.query(
      `UPDATE story_jobs SET cancel_requested = TRUE WHERE id = $1`,
      [Number(jobId)]
    );
    return { jobId: Number(jobId), cancelRequested: true };
  },
};

module.exports = storyService;
