/**
 * Lookup risk-score + SLO service — PR #8.
 *
 * Aggregates two dashboards:
 *
 *   /api/admin/lookup/risk    — cohort burn rates by burner risk_score,
 *                                soft_block_count, checkpoint_count,
 *                                last_outcome. The data source is
 *                                `lookup_burners` (created in v34) and
 *                                `instagram_detection_events` if that
 *                                table is populated by the IG detection
 *                                stack.
 *
 *   /api/admin/lookup/slo     — Stage 1/2/3 latency p50/p95 over the
 *                                last 24h, by stage. Pulled from
 *                                `lookup_jobs.stage_p50_ms` / `stage_p95_ms`
 *                                JSONB columns (populated by the runner).
 *
 *   /api/lookup/usage         — Per-user 7d activity rollup (jobs run,
 *                                methods called, paid USD spent).
 */

'use strict';

const { pool } = require('../config/database');

async function riskCohort() {
  const { rows: burners } = await pool.query(
    `SELECT
       COUNT(*)                              AS total,
       SUM(CASE WHEN blocked THEN 1 ELSE 0 END)  AS blocked,
       AVG(NULLIF(risk_score, 0))            AS avg_risk,
       AVG(probe_count)                      AS avg_probes,
       SUM(soft_block_count)                 AS total_soft_blocks,
       SUM(checkpoint_count)                 AS total_checkpoints,
       SUM(CASE WHEN last_outcome = 'rate_limited'  THEN 1 ELSE 0 END) AS rate_limited_n,
       SUM(CASE WHEN last_outcome = 'checkpoint'    THEN 1 ELSE 0 END) AS checkpoint_n,
       SUM(CASE WHEN last_outcome = 'login_required' THEN 1 ELSE 0 END) AS login_required_n
       FROM lookup_burners`
  );
  const row = burners[0] || {};
  let detectionEvents = [];
  try {
    const r = await pool.query(
      `SELECT event_type, COUNT(*) AS cnt, MAX(created_at) AS last
         FROM instagram_detection_events
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY event_type
        ORDER BY cnt DESC`
    );
    detectionEvents = r.rows;
  } catch (_err) { /* table optional */ }
  return {
    burners: {
      total: parseInt(row.total || 0, 10),
      blocked: parseInt(row.blocked || 0, 10),
      avg_risk_score: row.avg_risk ? Number(row.avg_risk) : 0,
      avg_probes: row.avg_probes ? Number(row.avg_probes) : 0,
      total_soft_blocks: parseInt(row.total_soft_blocks || 0, 10),
      total_checkpoints: parseInt(row.total_checkpoints || 0, 10),
      last_outcomes: {
        rate_limited:   parseInt(row.rate_limited_n  || 0, 10),
        checkpoint:     parseInt(row.checkpoint_n    || 0, 10),
        login_required: parseInt(row.login_required_n|| 0, 10),
      },
    },
    detection_events_7d: detectionEvents,
  };
}

async function sloLatencyDashboard() {
  const { rows } = await pool.query(
    `SELECT
        date_trunc('hour', completed_at) AS hour,
        COUNT(*)                            AS jobs,
        AVG((stage_p50_ms->>'total')::float)   AS avg_total_p50,
        AVG((stage_p95_ms->>'total')::float)   AS avg_total_p95,
        AVG((stage_p50_ms->>'stage1')::float)  AS avg_s1_p50,
        AVG((stage_p95_ms->>'stage1')::float)  AS avg_s1_p95,
        AVG((stage_p50_ms->>'stage2')::float)  AS avg_s2_p50,
        AVG((stage_p95_ms->>'stage2')::float)  AS avg_s2_p95,
        AVG((stage_p50_ms->>'stage3')::float)  AS avg_s3_p50,
        AVG((stage_p95_ms->>'stage3')::float)  AS avg_s3_p95
       FROM lookup_jobs
      WHERE status = 'completed'
        AND completed_at > NOW() - INTERVAL '24 hours'
        AND stage_p50_ms IS NOT NULL
      GROUP BY 1
      ORDER BY 1 DESC`
  );
  return rows;
}

async function recentRiskJobs({ limit = 50 }) {
  const { rows } = await pool.query(
    `SELECT id, username, status, total_methods, total_findings,
            budget_usd_spent, stated_purpose, client_ip,
            stage_p50_ms, stage_p95_ms,
            created_at, completed_at, retained_until
       FROM lookup_jobs
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.min(500, parseInt(limit, 10) || 50)]
  );
  return rows;
}

async function usageRollup({ userId, days = 7 }) {
  const { rows } = await pool.query(
    `SELECT
        COUNT(*)                              AS jobs,
        COALESCE(SUM(total_findings), 0)      AS findings,
        COALESCE(SUM(budget_usd_spent), 0)    AS usd_spent,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        MAX(created_at)                       AS last_run
       FROM lookup_jobs
      WHERE user_id = $1
        AND created_at > NOW() - ($2 || ' days')::interval`,
    [userId, String(days)]
  );
  return rows[0] || null;
}

module.exports = {
  riskCohort,
  sloLatencyDashboard,
  recentRiskJobs,
  usageRollup,
};
