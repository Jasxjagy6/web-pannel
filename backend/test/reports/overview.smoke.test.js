/**
 * Smoke test for the panel-wide report endpoints (overview + per-category
 * summaries). The DB is stubbed via Module._cache; we just want to
 * exercise the service methods enough to catch syntax errors and ensure
 * the parameter wiring matches.
 *
 * Run with:  node test/reports/overview.smoke.test.js
 */
'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

// Stub the DB pool so each query returns a deterministic shape based on
// what the service expects. The service does ~12 queries inside
// getOverview; we route each by inspecting the SQL fragment.
const fakePool = {
  async query(text, params) {
    const sql = String(text);
    if (/COUNT\(\*\)::int AS total/.test(sql)) {
      return { rows: [{ total: 0 }] };
    }
    if (/COUNT\(\*\) AS jobs,\s+COALESCE\(SUM\(mj.sent_count\), 0\) AS sent,\s+COALESCE\(SUM\(mj.failed_count\), 0\) AS failed,\s+COALESCE\(SUM\(mj.skipped_count\), 0\) AS skipped/.test(sql)) {
      return { rows: [{ jobs: '0', sent: '0', failed: '0', skipped: '0', attempted: '0' }] };
    }
    if (/COUNT\(\*\) AS jobs,\s+COALESCE\(SUM\(sj.total_found\), 0\) AS found,\s+COUNT\(\*\) FILTER \(WHERE sj.status = 'completed'\) AS completed/.test(sql)) {
      return { rows: [{ jobs: '0', found: '0', completed: '0', failed: '0', cancelled: '0' }] };
    }
    if (/COUNT\(\*\) AS ops,\s+COALESCE\(SUM\(go.success_count\), 0\) AS success/.test(sql)) {
      return { rows: [{ ops: '0', success: '0', failed: '0', attempted: '0' }] };
    }
    if (/to_char\(mj.created_at, 'YYYY-MM-DD'\) AS day/.test(sql)) return { rows: [] };
    if (/to_char\(sj.created_at, 'YYYY-MM-DD'\) AS day/.test(sql)) return { rows: [] };
    if (/to_char\(go.created_at, 'YYYY-MM-DD'\) AS day/.test(sql)) return { rows: [] };
    if (/COALESCE\(mj.job_type, 'unknown'\) AS job_type/.test(sql)) return { rows: [] };
    if (/COALESCE\(sj.target_type, 'unknown'\) AS target_type/.test(sql)) return { rows: [] };
    if (/COALESCE\(go.operation, 'unknown'\) AS operation/.test(sql)) return { rows: [] };
    if (/COALESCE\(mj.status, 'unknown'\) AS status/.test(sql)) return { rows: [] };
    // Dashboard stats fall-through: mimic shape getDashboardStats expects.
    if (/FROM sessions\s+WHERE user_id = \$1/.test(sql)) {
      return { rows: [{
        total: '0', active: '0', inactive: '0', uploaded: '0', error: '0',
        revoked: '0', expired: '0', logged_in: '0', logged_out: '0',
      }] };
    }
    if (/COUNT\(\*\) as total_entries/.test(sql)) {
      return { rows: [{ total_entries: '0', unique_users: '0' }] };
    }
    if (/scraped_today/.test(sql)) {
      return { rows: [{ scraped_today: '0', scraped_week: '0', scraped_month: '0' }] };
    }
    if (/total_jobs/.test(sql) && /messaging_jobs/.test(sql)) {
      return { rows: [{
        total_jobs: '0', total_sent: '0', total_failed: '0', total_skipped: '0',
        total_attempted: '0', completed_jobs: '0', failed_jobs: '0',
      }] };
    }
    if (/sent_today/.test(sql)) {
      return { rows: [{
        sent_today: '0', sent_week: '0', sent_month: '0',
        jobs_today: '0', jobs_week: '0', jobs_month: '0',
      }] };
    }
    if (/single_today/.test(sql)) {
      return { rows: [{
        single_today: '0', single_week: '0', single_month: '0',
        single_sent_today: '0', single_sent_week: '0', single_sent_month: '0',
      }] };
    }
    if (/total_jobs/.test(sql) && /scraping_jobs/.test(sql)) {
      return { rows: [{
        total_jobs: '0', total_found: '0',
        completed_jobs: '0', failed_jobs: '0', cancelled_jobs: '0',
      }] };
    }
    if (/jobs_today/.test(sql) && /scraping_jobs/.test(sql)) {
      return { rows: [{
        jobs_today: '0', jobs_week: '0', jobs_month: '0',
        found_today: '0', found_week: '0', found_month: '0',
      }] };
    }
    if (/total_ops/.test(sql)) {
      return { rows: [{
        total_ops: '0', total_success: '0', total_failed: '0', total_attempted: '0',
      }] };
    }
    if (/total_lists/.test(sql)) {
      return { rows: [{ total_lists: '0', total_items: '0' }] };
    }
    if (/SELECT s.id, s.phone, s.status,\s+COALESCE\(SUM\(mj.sent_count\)/.test(sql)) {
      return { rows: [] };
    }
    if (/FROM activity_logs/.test(sql)) {
      return { rows: [] };
    }
    if (/SELECT s.id, s.phone, s.status, s.created_at, s.is_logged_in/.test(sql)) {
      return { rows: [] };
    }
    if (/FROM messaging_jobs mj/.test(sql)) return { rows: [] };
    if (/FROM scraping_jobs sj/.test(sql)) return { rows: [] };
    if (/FROM group_operations go/.test(sql)) return { rows: [] };
    if (/FROM lists/.test(sql)) return { rows: [] };
    return { rows: [] };
  },
};

// Inject the stub before reportService is required.
const dbModulePath = require.resolve(path.join(__dirname, '..', '..', 'src', 'config', 'database.js'));
require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: { pool: fakePool, query: (...a) => fakePool.query(...a) },
};

const reportService = require('../../src/services/reportService');

(async () => {
  // getOverview
  const overview = await reportService.getOverview(1, '7d');
  assert.ok(overview.period && overview.period.start, 'period present');
  assert.ok(overview.allTime && overview.allTime.sessions, 'allTime present');
  assert.ok(overview.periodTotals && overview.periodTotals.messaging, 'periodTotals present');
  assert.ok(Array.isArray(overview.timeSeries), 'timeSeries is array');
  assert.ok(overview.distributions, 'distributions present');
  console.log('getOverview: OK');

  // getOverview('all')
  const all = await reportService.getOverview(1, 'all');
  assert.strictEqual(all.period.key, 'all');
  console.log('getOverview(all): OK');

  // getOverview('custom') - missing dates
  await assert.rejects(
    () => reportService.getOverview(1, 'custom'),
    (err) => err.errorCode === 'MISSING_CUSTOM_DATES'
  );
  console.log('getOverview(custom missing dates): OK');

  // Per-category summaries
  const sess = await reportService.getSessionsSummary(1, { page: 1, limit: 5 });
  assert.ok(Array.isArray(sess.sessions));
  assert.ok(sess.pagination);
  console.log('getSessionsSummary: OK');

  const msg = await reportService.getMessagingSummary(1, { page: 1, limit: 5, jobType: 'single_user_mass_dm' });
  assert.ok(Array.isArray(msg.jobs));
  console.log('getMessagingSummary: OK');

  const scr = await reportService.getScrapingSummary(1, { page: 1, limit: 5, status: 'completed' });
  assert.ok(Array.isArray(scr.jobs));
  console.log('getScrapingSummary: OK');

  const gop = await reportService.getGroupOpsSummary(1, { page: 1, limit: 5 });
  assert.ok(Array.isArray(gop.operations));
  console.log('getGroupOpsSummary: OK');

  const lists = await reportService.getListsSummary(1, { page: 1, limit: 5 });
  assert.ok(Array.isArray(lists.lists));
  console.log('getListsSummary: OK');

  // exportOverview JSON
  const json = await reportService.exportOverview(1, '7d', 'json');
  assert.strictEqual(json.mimeType, 'application/json');
  assert.ok(json.filename.endsWith('.json'));
  console.log('exportOverview(json): OK');

  // exportOverview CSV
  const csv = await reportService.exportOverview(1, '7d', 'csv');
  assert.strictEqual(csv.mimeType, 'text/csv');
  assert.ok(csv.filename.endsWith('.csv'));
  assert.ok(csv.content.startsWith('# Panel overview'));
  console.log('exportOverview(csv): OK');

  // Invalid format
  await assert.rejects(
    () => reportService.exportOverview(1, '7d', 'pdf'),
    (err) => err.errorCode === 'INVALID_FORMAT'
  );
  console.log('exportOverview(invalid format): OK');

  console.log('overview.smoke.test: OK');
})().catch((err) => {
  console.error('overview.smoke.test FAILED:', err);
  process.exit(1);
});
