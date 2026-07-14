const trackingBulkService = require('../services/trackingBulkService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const trackingBulkController = {
  bulkDelete: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { ids } = req.body;
    const result = await trackingBulkService.bulkDelete(userId, ids);

    await reportService.logActivity(userId, 'tracking_bulk_delete', 'tracking_account', null, {
      total: result.total, succeeded: result.succeeded.length, failed: result.failed.length,
    });
    logger.info(`Bulk delete by user ${userId}: ${result.succeeded.length}/${result.total} succeeded`);

    return res.status(200).json({ success: true, data: result });
  }),

  bulkStatusChange: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { ids, status, reservedUntil } = req.body;
    if (!status) {
      throw new AppError('status is required', 400, 'MISSING_STATUS');
    }
    const result = await trackingBulkService.bulkStatusChange(userId, ids, status, { reservedUntil });

    await reportService.logActivity(userId, 'tracking_bulk_status_change', 'tracking_account', null, {
      status, total: result.total, succeeded: result.succeeded.length, failed: result.failed.length,
    });

    return res.status(200).json({ success: true, data: result });
  }),

  bulkAssign: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { ids, assignedToUserId, assignedToName, reason } = req.body;
    const result = await trackingBulkService.bulkAssign(userId, ids, { assignedToUserId, assignedToName, reason });

    await reportService.logActivity(userId, 'tracking_bulk_assign', 'tracking_account', null, {
      total: result.total, succeeded: result.succeeded.length, failed: result.failed.length,
    });

    return res.status(200).json({ success: true, data: result });
  }),

  bulkTag: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { ids, tagIds } = req.body;
    const result = await trackingBulkService.bulkTag(userId, ids, tagIds);

    await reportService.logActivity(userId, 'tracking_bulk_tag', 'tracking_account', null, {
      tagIds, total: result.total, succeeded: result.succeeded.length, failed: result.failed.length,
    });

    return res.status(200).json({ success: true, data: result });
  }),
};

module.exports = trackingBulkController;
