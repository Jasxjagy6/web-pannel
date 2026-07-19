/**
 * Per-session send breakdown for a finished job.
 *
 * Returns:
 *   - sessionsUsed:     count of sessions that sent >=1 successful DM
 *   - sessionsProvided: total sessions supplied to the job
 *   - sessions:         [{ sessionId, sessionLabel, sentCount }]
 *
 * Aggregates message_logs (status='sent') for the job. Postgres.
 */

const { pool } = require('../config/database');
const { AppError, asyncHandler } = require('../utils/errorHandler');

const getJobSessionBreakdown = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const jobId = parseInt(req.params.id, 10);
  if (!Number.isFinite(jobId)) {
    throw new AppError('Invalid job id', 400, 'BAD_JOB_ID');
  }

  // Ownership + provided-session count. messaging_jobs.options->'sessionIds'
  // holds the sessions the operator supplied to the job.
  const { rows: jobRows } = await pool.query(
    `SELECT id, user_id,
            COALESCE(jsonb_array_length(options->'sessionIds'), 0) AS provided
       FROM messaging_jobs
      WHERE id = $1`,
    [jobId]
  );
  const job = jobRows[0];
  if (!job) {
    throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
  }
  if (Number(job.user_id) !== Number(userId)) {
    throw new AppError('Not authorized for this job', 403, 'FORBIDDEN');
  }

  // Successful DMs per session, with a friendly label from account_info.
  const { rows } = await pool.query(
    `SELECT ml.session_id                                    AS session_id,
            COUNT(*) FILTER (WHERE ml.status = 'sent')       AS sent_count,
            s.phone                                          AS phone,
            s.account_info->>'firstName'                     AS first_name,
            s.account_info->>'lastName'                      AS last_name,
            s.account_info->>'username'                      AS username
       FROM message_logs ml
       LEFT JOIN sessions s ON s.id = ml.session_id
      WHERE ml.job_id = $1 AND ml.session_id IS NOT NULL
      GROUP BY ml.session_id, s.phone, s.account_info
     HAVING COUNT(*) FILTER (WHERE ml.status = 'sent') > 0
      ORDER BY sent_count DESC, ml.session_id ASC`,
    [jobId]
  );

  const sessions = rows.map((r) => {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
    const label =
      name ||
      (r.username ? `@${r.username}` : null) ||
      r.phone ||
      `Session ${r.session_id}`;
    return {
      sessionId: r.session_id,
      sessionLabel: label,
      sentCount: parseInt(r.sent_count, 10),
    };
  });

  return res.status(200).json({
    success: true,
    data: {
      sessionsUsed: sessions.length,
      sessionsProvided: parseInt(job.provided, 10) || 0,
      sessions,
    },
  });
});

module.exports = { getJobSessionBreakdown };
