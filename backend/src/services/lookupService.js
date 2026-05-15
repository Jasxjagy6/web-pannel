/**
 * Lookup service — orchestrates the lifecycle of IG identity-lookup
 * jobs (instagram_upgrade.txt §4.3).
 *
 * Mirrors `scrapeService.js`:
 *   - createJob(...)
 *   - startJob(...)            → BullMQ enqueue
 *   - getJob(id)
 *   - listJobs({ userId, page, limit, status })
 *   - getProgress(id)          → joins lookup_jobs + recent findings
 *   - cancelJob(id)
 *   - exportJob(id, format)    → CSV / JSON
 *   - listFindings(jobId)
 *
 * The service is intentionally thin — the heavy lifting happens in
 * `providers/instagram/lookup/index.js::runJob()` (the BullMQ worker).
 */

'use strict';

const { stringify } = require('csv-stringify/sync');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const instagramLookupQueue = require('../queues/instagramLookupQueue');

const VALID_METHODS = [
  'profile_info',
  'reset_oracle',
  'reset_oracle_deep',
  'alt_account',
  'cross_platform',
  'geo_from_posts',
  'dork',
  'email_enum',
  'phone_enum',
  'breach',
  'link_expand',
  'reverse_image',
];

const DEFAULT_METHODS = [
  'profile_info',
  'reset_oracle',
  'cross_platform',
  'geo_from_posts',
  'dork',
];

function _sanitiseUsername(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/i.test(cleaned)) return null;
  return cleaned;
}

function _validateMethods(methods) {
  if (!Array.isArray(methods) || !methods.length) return DEFAULT_METHODS.slice();
  const out = [];
  for (const m of methods) {
    if (typeof m === 'string' && VALID_METHODS.includes(m) && !out.includes(m)) {
      out.push(m);
    }
  }
  return out.length ? out : DEFAULT_METHODS.slice();
}

async function createJob({ userId, username, methods, options, statedPurpose, clientIp }) {
  if (!userId) throw new AppError('userId required', 400, 'VALIDATION_ERROR');
  const cleaned = _sanitiseUsername(username);
  if (!cleaned) {
    throw new AppError(
      'Invalid IG username (must be 1-30 chars, a-z 0-9 . _).',
      400,
      'INVALID_USERNAME'
    );
  }
  const purpose = (statedPurpose || '').trim();
  if (!purpose || purpose.length < 8) {
    throw new AppError(
      'A stated purpose (>=8 chars) is required for every lookup job. This is recorded for audit per §8 of the upgrade plan.',
      400,
      'STATED_PURPOSE_REQUIRED'
    );
  }
  const validMethods = _validateMethods(methods);
  const opts = options && typeof options === 'object' ? options : {};
  const budgetCap = Number(opts.budgetUsdCap || 0);
  const deepMode = !!(opts.deepMode || opts.deep_mode);
  if (deepMode && !validMethods.includes('reset_oracle_deep')) validMethods.push('reset_oracle_deep');
  const retentionDays = parseInt(process.env.LOOKUP_JOB_RETENTION_DAYS || '90', 10);
  const insert = await pool.query(
    `INSERT INTO lookup_jobs
       (user_id, platform, username, methods, options, status,
        total_methods, completed_methods, error_methods, total_findings,
        budget_usd_cap, budget_usd_spent, stated_purpose, client_ip, deep_mode, retained_until)
     VALUES ($1, 'instagram', $2, $3, $4::jsonb, 'pending',
        $5, 0, 0, 0, $6, 0, $7, $8, $9, NOW() + ($10 || ' days')::interval)
     RETURNING *`,
    [
      userId,
      cleaned,
      validMethods,
      JSON.stringify(opts),
      validMethods.length,
      budgetCap,
      purpose,
      clientIp || null,
      deepMode,
      String(Math.max(1, retentionDays)),
    ]
  );
  const row = insert.rows[0];
  logger.info(`IG.lookup.createJob: jobId=${row.id} user=${userId} username=${cleaned} methods=${validMethods.join(',')} deep=${deepMode}`);
  try {
    // eslint-disable-next-line global-require
    const lookupAudit = require('./lookupAuditService');
    lookupAudit.log({
      userId, jobId: row.id, username: cleaned, action: 'job_created',
      method: validMethods.join(','), statedPurpose: purpose, clientIp,
      meta: { methods: validMethods, deepMode, budgetCap },
    });
  } catch (_e) { /* swallow */ }
  return row;
}

async function startJob(jobId, { async = true } = {}) {
  const job = await getJob(jobId);
  if (!job) throw new AppError('Lookup job not found', 404, 'NOT_FOUND');
  if (job.status !== 'pending') {
    throw new AppError(`Cannot start job — current status is ${job.status}`, 400, 'INVALID_STATE');
  }
  await pool.query(`UPDATE lookup_jobs SET status = 'queued' WHERE id = $1`, [jobId]);
  if (async === false) {
    // eslint-disable-next-line global-require
    const igLookup = require('../providers/instagram/lookup');
    return igLookup.runJob(jobId);
  }
  const queueJob = await instagramLookupQueue.addJob({ jobId, userId: job.user_id });
  return { jobId, queueJobId: queueJob.id, status: 'queued' };
}

async function getJob(jobId) {
  const { rows } = await pool.query(
    `SELECT * FROM lookup_jobs WHERE id = $1`,
    [jobId]
  );
  return rows[0] || null;
}

async function listJobs({ userId, page = 1, limit = 50, status }) {
  const limitN = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const pageN = Math.max(1, parseInt(page, 10) || 1);
  const offset = (pageN - 1) * limitN;

  const where = [`user_id = $1`];
  const params = [userId];
  let idx = 2;
  if (status) {
    where.push(`status = $${idx}`);
    params.push(status);
    idx += 1;
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const countSql = `SELECT COUNT(*)::int AS total FROM lookup_jobs ${whereSql}`;
  const { rows: countRows } = await pool.query(countSql, params);
  const total = countRows[0] ? countRows[0].total : 0;

  const listSql = `
    SELECT * FROM lookup_jobs
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT $${idx} OFFSET $${idx + 1}`;
  const { rows } = await pool.query(listSql, [...params, limitN, offset]);
  return {
    jobs: rows,
    pagination: { page: pageN, limit: limitN, total, totalPages: Math.max(1, Math.ceil(total / limitN)) },
  };
}

async function getProgress(jobId) {
  const job = await getJob(jobId);
  if (!job) throw new AppError('Lookup job not found', 404, 'NOT_FOUND');
  const { rows: findings } = await pool.query(
    `SELECT method, kind, value, source_url, confidence, verified, created_at
       FROM lookup_findings
      WHERE job_id = $1
      ORDER BY created_at ASC
      LIMIT 500`,
    [jobId]
  );
  return { job, findings };
}

async function cancelJob(jobId, { userId } = {}) {
  const job = await getJob(jobId);
  if (!job) throw new AppError('Lookup job not found', 404, 'NOT_FOUND');
  if (userId && job.user_id !== userId) {
    throw new AppError('Not your job', 403, 'FORBIDDEN');
  }
  if (['completed', 'cancelled', 'failed'].includes(job.status)) return job;
  await pool.query(`UPDATE lookup_jobs SET status = 'cancelled', completed_at = NOW() WHERE id = $1`, [jobId]);
  return getJob(jobId);
}

async function deleteJob(jobId, { userId } = {}) {
  const job = await getJob(jobId);
  if (!job) throw new AppError('Lookup job not found', 404, 'NOT_FOUND');
  if (userId && job.user_id !== userId) {
    throw new AppError('Not your job', 403, 'FORBIDDEN');
  }
  await pool.query(`DELETE FROM lookup_jobs WHERE id = $1`, [jobId]);
  return { ok: true };
}

async function listFindings(jobId, { kind, limit = 500 } = {}) {
  const limitN = Math.min(2000, Math.max(1, parseInt(limit, 10) || 500));
  const params = [jobId];
  let where = `WHERE job_id = $1`;
  if (kind) {
    where += ` AND kind = $2`;
    params.push(kind);
  }
  const { rows } = await pool.query(
    `SELECT id, method, kind, value, source_url, confidence, verified, created_at, raw
       FROM lookup_findings
       ${where}
       ORDER BY confidence DESC, created_at ASC
       LIMIT ${limitN}`,
    params
  );
  return rows;
}

async function exportJob(jobId, format = 'csv') {
  const job = await getJob(jobId);
  if (!job) throw new AppError('Lookup job not found', 404, 'NOT_FOUND');
  const findings = await listFindings(jobId, { limit: 2000 });
  if (format === 'json') {
    return {
      mime: 'application/json',
      filename: `lookup_${job.username}_${jobId}.json`,
      body: JSON.stringify({ job, findings }, null, 2),
    };
  }
  const csv = stringify(findings, {
    header: true,
    columns: [
      'id', 'method', 'kind', 'value', 'source_url', 'confidence', 'verified', 'created_at',
    ],
  });
  return {
    mime: 'text/csv',
    filename: `lookup_${job.username}_${jobId}.csv`,
    body: csv,
  };
}

module.exports = {
  createJob,
  startJob,
  getJob,
  listJobs,
  getProgress,
  cancelJob,
  deleteJob,
  listFindings,
  exportJob,
  VALID_METHODS,
  DEFAULT_METHODS,
};
