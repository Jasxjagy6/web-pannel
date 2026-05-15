/**
 * Lookup-retention worker — PR #8.
 *
 * Hourly sweep:
 *   - DELETE `lookup_jobs` rows whose `retained_until` is in the past
 *     (cascades to lookup_findings via FK).
 *   - DELETE `lookup_snapshots` whose `snap_at < NOW() - 365 days`
 *     (longitudinal data kept 1y).
 *   - DELETE expired `lookup_audit_log` rows.
 *   - DELETE expired `lookup_api_cache` rows.
 *
 * Each delete is bounded (`LIMIT 500`) so a multi-year backlog can be
 * drained over many ticks without holding a long transaction.
 *
 * Disabled if `LOOKUP_RETENTION_ENABLED=false`.
 */

'use strict';

const logger = require('../utils/logger');
const { pool } = require('../config/database');
const lookupAudit = require('./lookupAuditService');
const lookupCache = require('./lookupCacheService');

const _POLL_INTERVAL_MS = parseInt(process.env.LOOKUP_RETENTION_POLL_MS || '3600000', 10);
const _SNAPSHOT_RETENTION_DAYS = parseInt(process.env.LOOKUP_SNAPSHOT_RETENTION_DAYS || '365', 10);
const _BATCH = 500;

let _running = false;
let _timer = null;

async function _purgeJobs() {
  // Delete bounded — findings cascade via ON DELETE CASCADE on FK.
  const res = await pool.query(
    `WITH dead AS (
       SELECT id FROM lookup_jobs
        WHERE retained_until IS NOT NULL
          AND retained_until < NOW()
          AND status IN ('completed', 'failed', 'cancelled')
        LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM lookup_jobs
      WHERE id IN (SELECT id FROM dead)
      RETURNING id`,
    [_BATCH]
  );
  return res.rowCount || 0;
}

async function _purgeSnapshots() {
  const res = await pool.query(
    `DELETE FROM lookup_snapshots
      WHERE snap_at < NOW() - ($1 || ' days')::interval
      RETURNING id`,
    [String(_SNAPSHOT_RETENTION_DAYS)]
  );
  return res.rowCount || 0;
}

async function _tick() {
  if (_running) return;
  _running = true;
  try {
    const [jobs, snaps, audits, caches] = await Promise.all([
      _purgeJobs().catch((e) => { logger.warn(`retention.purgeJobs: ${e.message}`); return 0; }),
      _purgeSnapshots().catch((e) => { logger.warn(`retention.purgeSnapshots: ${e.message}`); return 0; }),
      lookupAudit.purgeExpired(),
      lookupCache.purgeExpired(),
    ]);
    if (jobs || snaps || audits || caches) {
      logger.info(`lookupRetentionWorker: purged jobs=${jobs} snapshots=${snaps} audit=${audits} cache=${caches}`);
      if (jobs > 0) {
        lookupAudit.log({ action: 'retention_purge', meta: { jobs, snapshots: snaps, audit: audits, cache: caches } });
      }
    }
  } catch (err) {
    logger.warn(`lookupRetentionWorker.tick failed: ${err.message}`);
  } finally {
    _running = false;
  }
}

function start() {
  if (String(process.env.LOOKUP_RETENTION_ENABLED ?? 'true').toLowerCase() === 'false') {
    logger.info('lookupRetentionWorker: disabled via LOOKUP_RETENTION_ENABLED=false');
    return;
  }
  if (_timer) return;
  logger.info(`lookupRetentionWorker: starting, poll=${_POLL_INTERVAL_MS}ms`);
  _timer = setInterval(_tick, _POLL_INTERVAL_MS);
  // Boot tick — but with a 30s lag so we don't compete with start-up.
  setTimeout(() => _tick().catch((e) => logger.warn(`lookupRetentionWorker boot tick failed: ${e.message}`)), 30_000);
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, _tick };
