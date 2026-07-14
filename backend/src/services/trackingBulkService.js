const trackingAccountService = require('./trackingAccountService');
const trackingAssignmentService = require('./trackingAssignmentService');
const trackingTagService = require('./trackingTagService');

/**
 * Runs `fn(id)` for every id, isolating failures per-row so one bad row
 * doesn't abort the batch. Mirrors the succeeded/failed shape used by
 * sessionBulkAuthPurgeService for bulk session operations.
 */
async function runBulk(ids, fn) {
  const succeeded = [];
  const failed = [];
  for (const id of ids) {
    try {
      await fn(id);
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, error: err.message || 'Unknown error' });
    }
  }
  return { succeeded, failed, total: ids.length };
}

const trackingBulkService = {
  async bulkDelete(userId, ids) {
    return runBulk(ids, (id) => trackingAccountService.softDeleteAccount(userId, id));
  },

  async bulkStatusChange(userId, ids, status, opts = {}) {
    return runBulk(ids, (id) => trackingAccountService.changeStatus(userId, id, status, opts));
  },

  async bulkAssign(userId, ids, data) {
    return runBulk(ids, (id) => trackingAssignmentService.assign(userId, id, data));
  },

  async bulkTag(userId, ids, tagIds) {
    return runBulk(ids, (id) => trackingTagService.addTagsToAccount(id, userId, tagIds));
  },
};

module.exports = trackingBulkService;
