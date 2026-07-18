/**
 * ReplyTrackingService — 24-hour "did they reply?" pass for send jobs.
 *
 * After a send job (bulk or failover) finishes, we want to know, per
 * recipient, whether that user has since replied to the session that
 * messaged them. This service:
 *
 *   1. `initForJob`  — opens a reply-observation window on the job and
 *                      makes sure a `message_reply_tracking` row exists
 *                      for every recipient we actually sent to.
 *   2. `scanJob`     — for each session used by the job, reads recent
 *                      dialogs and flips `replied=true` (once) for any
 *                      tracked recipient whose last INBOUND message is
 *                      newer than when we messaged them.
 *   3. `scanDueJobs` — invoked on a timer by the worker; scans every job
 *                      whose 24h window is still open, then closes windows
 *                      that have elapsed.
 *
 * Counting is idempotent: a recipient is only ever counted once (the
 * `replied` boolean guards it), so re-scanning never inflates the number.
 */

const { pool } = require('../config/database');
const tgService = require('./telegramService');
const logger = require('../utils/logger');

function _toIdNum(v) {
  if (v === null || v === undefined) return null;
  try {
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'object' && typeof v.valueOf === 'function') {
      const n = Number(v.valueOf());
      return Number.isFinite(n) ? n : null;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

class ReplyTrackingService {
  /**
   * Open the reply window for a job and ensure tracking rows exist for
   * everyone we sent to. Safe to call multiple times.
   *
   * @param {number} jobId
   * @param {object} [opts]
   * @param {number} [opts.windowHours=24]
   */
  async initForJob(jobId, opts = {}) {
    const windowHours = Math.max(1, Math.min(168, parseInt(opts.windowHours, 10) || 24));

    // Backfill tracking rows from message_logs for any 'sent' target that
    // doesn't already have one (covers the bulk path, which logs sends but
    // doesn't seed the tracking table inline like failover does).
    await pool.query(
      `INSERT INTO message_reply_tracking (job_id, session_id, target_id, sent_status, sent_at)
       SELECT ml.job_id, ml.session_id, ml.target_id, 'sent', MAX(ml.sent_at)
         FROM message_logs ml
        WHERE ml.job_id = $1 AND ml.status = 'sent'
        GROUP BY ml.job_id, ml.session_id, ml.target_id
       ON CONFLICT (job_id, target_id) DO NOTHING`,
      [jobId]
    );

    await pool.query(
      `UPDATE messaging_jobs
          SET reply_tracking_status = 'scanning',
              reply_tracking_started_at = COALESCE(reply_tracking_started_at, NOW()),
              reply_tracking_until = NOW() + ($2 || ' hours')::interval,
              replied_count = (
                SELECT COUNT(*) FROM message_reply_tracking
                 WHERE job_id = $1 AND replied = TRUE
              )
        WHERE id = $1`,
      [jobId, String(windowHours)]
    );

    logger.info(`Reply tracking opened for job ${jobId} (${windowHours}h window)`);

    // Kick an immediate first scan so early replies show up fast; ignore
    // failures (sessions may be offline right after a send).
    this.scanJob(jobId).catch((e) =>
      logger.warn(`Initial reply scan for job ${jobId} failed: ${e.message}`)
    );

    return { jobId, windowHours };
  }

  /**
   * Build a map of peerId -> last INBOUND message epoch (seconds) for a
   * session, by reading its recent dialogs. One cheap call surfaces the
   * last message per conversation.
   *
   * @private
   */
  async _incomingByPeer(sessionId) {
    const map = new Map();
    const entry = tgService.clients.get(String(sessionId));
    if (!entry || !entry.client) {
      // Try to connect; if the session isn't loaded we just skip it.
      try {
        await tgService._ensureConnected(sessionId);
      } catch {
        return map;
      }
    }
    const client = tgService.clients.get(String(sessionId))?.client;
    if (!client) return map;

    let dialogs;
    try {
      dialogs = await client.getDialogs({ limit: 200 });
    } catch (err) {
      logger.warn(`replyTracking: getDialogs failed for session ${sessionId}: ${err.message}`);
      return map;
    }

    for (const d of dialogs || []) {
      const msg = d.message || null;
      const entity = d.entity || null;
      if (!entity) continue;
      const peerId = _toIdNum(entity.id);
      if (peerId == null) continue;
      // Only count a genuine INBOUND message as a reply (out === false).
      if (msg && msg.out === false) {
        const dateSec = _toIdNum(msg.date);
        if (dateSec != null) {
          const prev = map.get(peerId) || 0;
          if (dateSec > prev) map.set(peerId, dateSec);
        }
      }
      // Stash username -> peerId so we can match @username-only targets.
      if (entity.username) {
        map.set(`@${String(entity.username).toLowerCase()}`, peerId);
      }
    }
    return map;
  }

  /**
   * Scan one job: for every session it used, check tracked recipients for
   * a reply that arrived after we messaged them. Marks `replied` once.
   *
   * @param {number} jobId
   * @returns {Promise<{ scanned:number, newReplies:number, repliedTotal:number }>}
   */
  async scanJob(jobId) {
    const { rows: tracks } = await pool.query(
      `SELECT id, session_id, target_id, peer_id, replied, sent_at
         FROM message_reply_tracking
        WHERE job_id = $1`,
      [jobId]
    );
    if (tracks.length === 0) {
      return { scanned: 0, newReplies: 0, repliedTotal: 0 };
    }

    // Group by session so we read each session's dialogs only once.
    const bySession = new Map();
    for (const t of tracks) {
      const sid = t.session_id != null ? String(t.session_id) : null;
      if (!sid) continue;
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid).push(t);
    }

    let newReplies = 0;

    for (const [sid, items] of bySession) {
      let peerMap;
      try {
        peerMap = await this._incomingByPeer(sid);
      } catch (err) {
        logger.warn(`replyTracking: scan session ${sid} failed: ${err.message}`);
        continue;
      }

      for (const t of items) {
        if (t.replied) continue;

        // Resolve this recipient's peer id: prefer the stored numeric id,
        // else map a @username target through the dialog username index.
        let peerId = t.peer_id != null ? _toIdNum(t.peer_id) : null;
        if (peerId == null && typeof t.target_id === 'string' && t.target_id.startsWith('@')) {
          const mapped = peerMap.get(t.target_id.toLowerCase());
          if (typeof mapped === 'number') peerId = mapped;
        }
        if (peerId == null) {
          await pool.query(
            `UPDATE message_reply_tracking SET last_checked_at = NOW() WHERE id = $1`,
            [t.id]
          );
          continue;
        }

        const lastIncoming = peerMap.get(peerId) || 0;
        const sentAtSec = t.sent_at ? Math.floor(new Date(t.sent_at).getTime() / 1000) : 0;

        if (lastIncoming > 0 && lastIncoming >= sentAtSec) {
          await pool.query(
            `UPDATE message_reply_tracking
                SET replied = TRUE,
                    replied_at = to_timestamp($2),
                    peer_id = COALESCE(peer_id, $3),
                    last_checked_at = NOW()
              WHERE id = $1`,
            [t.id, lastIncoming, peerId]
          );
          newReplies++;
        } else {
          await pool.query(
            `UPDATE message_reply_tracking
                SET peer_id = COALESCE(peer_id, $2), last_checked_at = NOW()
              WHERE id = $1`,
            [t.id, peerId]
          );
        }
      }
    }

    // Refresh the job's replied_count + last scan time.
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS replied FROM message_reply_tracking WHERE job_id = $1 AND replied = TRUE`,
      [jobId]
    );
    const repliedTotal = cnt[0]?.replied || 0;
    await pool.query(
      `UPDATE messaging_jobs
          SET replied_count = $2, reply_tracking_last_scan_at = NOW()
        WHERE id = $1`,
      [jobId, repliedTotal]
    );

    if (newReplies > 0) {
      logger.info(`Reply scan job ${jobId}: +${newReplies} new replies (total ${repliedTotal})`);
    }
    return { scanned: tracks.length, newReplies, repliedTotal };
  }

  /**
   * Timer entry point: scan every job whose 24h window is still open, and
   * close windows that have elapsed. Called by the reply-tracking worker.
   */
  async scanDueJobs() {
    // Close elapsed windows first.
    await pool.query(
      `UPDATE messaging_jobs
          SET reply_tracking_status = 'completed'
        WHERE reply_tracking_status = 'scanning'
          AND reply_tracking_until IS NOT NULL
          AND reply_tracking_until < NOW()`
    );

    const { rows } = await pool.query(
      `SELECT id FROM messaging_jobs
        WHERE reply_tracking_status = 'scanning'
          AND (reply_tracking_until IS NULL OR reply_tracking_until >= NOW())
        ORDER BY reply_tracking_last_scan_at ASC NULLS FIRST
        LIMIT 25`
    );

    let totalNew = 0;
    for (const r of rows) {
      try {
        const res = await this.scanJob(r.id);
        totalNew += res.newReplies;
      } catch (err) {
        logger.warn(`scanDueJobs: job ${r.id} failed: ${err.message}`);
      }
    }
    return { jobsScanned: rows.length, newReplies: totalNew };
  }

  /**
   * Fetch the per-recipient reply breakdown for the job-history dropdown.
   *
   * @param {number} jobId
   * @param {number} userId - ownership guard
   */
  async getJobReplyDetails(jobId, userId) {
    const { rows: jobRows } = await pool.query(
      `SELECT id, user_id, total_count, sent_count, failed_count, skipped_count,
              replied_count, reply_tracking_status, reply_tracking_started_at,
              reply_tracking_until, reply_tracking_last_scan_at
         FROM messaging_jobs
        WHERE id = $1 AND user_id = $2`,
      [jobId, userId]
    );
    if (jobRows.length === 0) {
      const err = new Error('Job not found');
      err.statusCode = 404;
      throw err;
    }
    const job = jobRows[0];

    const { rows: recipients } = await pool.query(
      `SELECT mrt.target_id, mrt.target_label, mrt.session_id, mrt.peer_id,
              mrt.sent_status, mrt.sent_at, mrt.replied, mrt.replied_at,
              s.phone AS session_phone,
              s.account_info->>'firstName' AS session_first_name
         FROM message_reply_tracking mrt
         LEFT JOIN sessions s ON s.id = mrt.session_id
        WHERE mrt.job_id = $1
        ORDER BY mrt.replied DESC, mrt.sent_at ASC NULLS LAST, mrt.id ASC`,
      [jobId]
    );

    return {
      job: {
        id: job.id,
        totalCount: job.total_count,
        sentCount: job.sent_count,
        failedCount: job.failed_count,
        skippedCount: job.skipped_count,
        repliedCount: job.replied_count,
        replyTrackingStatus: job.reply_tracking_status,
        replyTrackingStartedAt: job.reply_tracking_started_at,
        replyTrackingUntil: job.reply_tracking_until,
        replyTrackingLastScanAt: job.reply_tracking_last_scan_at,
      },
      recipients: recipients.map((r) => ({
        targetId: r.target_id,
        label: r.target_label || r.target_id,
        sessionId: r.session_id,
        sessionLabel:
          [r.session_first_name].filter(Boolean).join(' ').trim() ||
          r.session_phone ||
          (r.session_id ? `Session #${r.session_id}` : '—'),
        sentStatus: r.sent_status,
        sentAt: r.sent_at,
        replied: r.replied === true,
        repliedAt: r.replied_at,
      })),
    };
  }
}

module.exports = new ReplyTrackingService();
