/**
 * Lookup-watch background worker — PR #7.
 *
 * Polls `lookupWatchService.pickDueRows()` once a minute and runs
 * `resetOracleWatch.run()` on each. The watch service has already
 * claimed the row by bumping next_run_at into the future, so two
 * concurrent worker instances never double-process.
 *
 * Concurrency is bounded by `LOOKUP_WATCH_CONCURRENCY` (default 2)
 * so we don't blast IG with 50 parallel /account_recovery_send_ajax
 * POSTs from one cron tick.
 */

'use strict';

const logger = require('../utils/logger');
const lookupWatchService = require('./lookupWatchService');
const resetOracleWatch   = require('../providers/instagram/lookup/resetOracleWatch');
const lookupRetentionWorker = require('./lookupRetentionWorker');

const _POLL_INTERVAL_MS = parseInt(process.env.LOOKUP_WATCH_POLL_INTERVAL_MS || '60000', 10);
const _CONCURRENCY = Math.max(1, parseInt(process.env.LOOKUP_WATCH_CONCURRENCY || '2', 10));
const _BATCH_SIZE  = Math.max(1, parseInt(process.env.LOOKUP_WATCH_BATCH_SIZE || '20', 10));

let _running = false;
let _timer = null;

async function _runOne(row) {
  try {
    await resetOracleWatch.run({
      username: row.username,
      userId:   row.user_id,
      watchId:  row.id,
    });
    await lookupWatchService.markRunResult({
      id: row.id,
      cadenceHours: row.cadence_hours,
    });
    return { id: row.id, ok: true };
  } catch (err) {
    logger.warn(`lookupWatchWorker: watch=${row.id} error: ${err.message}`);
    await lookupWatchService.markRunResult({
      id: row.id,
      cadenceHours: row.cadence_hours,
      error: err.message,
    });
    return { id: row.id, ok: false, error: err.message };
  }
}

async function _tick() {
  if (_running) return;
  _running = true;
  try {
    const due = await lookupWatchService.pickDueRows(_BATCH_SIZE);
    if (!due.length) return;
    logger.info(`lookupWatchWorker: tick claimed ${due.length} due watch(es)`);
    // Bounded concurrency.
    const queue = due.slice();
    const workers = Array.from({ length: Math.min(_CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const row = queue.shift();
        // eslint-disable-next-line no-await-in-loop
        await _runOne(row);
      }
    });
    await Promise.allSettled(workers);
  } catch (err) {
    logger.warn(`lookupWatchWorker: tick failed: ${err.message}`);
  } finally {
    _running = false;
  }
}

function start() {
  if (_timer) return;
  logger.info(`lookupWatchWorker: starting, poll=${_POLL_INTERVAL_MS}ms concurrency=${_CONCURRENCY} batch=${_BATCH_SIZE}`);
  _timer = setInterval(_tick, _POLL_INTERVAL_MS);
  // Boot tick — catches any watch whose next_run_at elapsed during
  // a panel restart.
  setTimeout(() => _tick().catch((e) => logger.warn(`lookupWatchWorker boot tick failed: ${e.message}`)), 5000);

  // Co-locate the retention sweeper. Runs once an hour; cheap.
  lookupRetentionWorker.start();
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  lookupRetentionWorker.stop();
}

module.exports = { start, stop, _tick };
