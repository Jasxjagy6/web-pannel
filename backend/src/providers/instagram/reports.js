/**
 * Instagram reports (provider.reports.*).
 *
 * Reports are platform-aware via the `platform` column on the reports
 * table; the shared reportService accepts a `platform` option. This module
 * just pins it to 'instagram'.
 */

const reportService = require('../../services/reportService');

async function generate(args = {}) {
  return reportService.generateReport({ ...args, platform: 'instagram' });
}
async function listReports(userId, opts = {}) {
  if (typeof reportService.listReports === 'function') {
    return reportService.listReports(userId, { ...opts, platform: 'instagram' });
  }
  return { reports: [], total: 0 };
}

module.exports = {
  generate,
  generateReport: generate,
  list: listReports,
  listReports,
};
