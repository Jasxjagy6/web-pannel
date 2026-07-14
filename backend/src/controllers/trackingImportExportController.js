const trackingImportExportService = require('../services/trackingImportExportService');
const trackingSessionZipImportService = require('../services/trackingSessionZipImportService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

function parseFilters(query) {
  // Mirrors trackingAccountController's parseFilters — export supports the
  // same filter set as the list page ("export filtered results").
  const filters = {};
  if (query.status) filters.status = Array.isArray(query.status) ? query.status : query.status.split(',');
  if (query.phone) filters.phone = query.phone;
  if (query.username) filters.username = query.username;
  if (query.telegramUserId) filters.telegramUserId = query.telegramUserId;
  if (query.country) filters.country = query.country;
  if (query.premium !== undefined) filters.premium = query.premium;
  if (query.buyer) filters.buyer = query.buyer;
  if (query.supplier) filters.supplier = query.supplier;
  if (query.salePriceMin !== undefined) filters.salePriceMin = query.salePriceMin;
  if (query.salePriceMax !== undefined) filters.salePriceMax = query.salePriceMax;
  if (query.purchasePriceMin !== undefined) filters.purchasePriceMin = query.purchasePriceMin;
  if (query.purchasePriceMax !== undefined) filters.purchasePriceMax = query.purchasePriceMax;
  if (query.dateFrom) filters.dateFrom = query.dateFrom;
  if (query.dateTo) filters.dateTo = query.dateTo;
  if (query.search) filters.search = query.search;
  return filters;
}

const trackingImportExportController = {
  importAccounts: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    if (!req.file) {
      throw new AppError('File is required', 400, 'MISSING_FILE');
    }
    const format = (req.body.format || req.query.format || 'csv').toLowerCase();
    const result = await trackingImportExportService.importAccounts(userId, req.file, format);

    await reportService.logActivity(userId, 'tracking_import', 'tracking_account', null, {
      format, imported: result.imported, total: result.total, errorCount: result.errors.length,
    });
    logger.info(`Tracking import by user ${userId}: ${result.imported}/${result.total} imported`);

    return res.status(200).json({ success: true, data: result });
  }),

  exportAccounts: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const format = (req.query.format || 'csv').toLowerCase();
    const filters = parseFilters(req.query);
    const permissions = req.trackingMember.permissions;

    const { content, filename, mimeType, totalItems } = await trackingImportExportService.exportAccounts(
      filters, format, permissions
    );

    await reportService.logActivity(userId, 'tracking_export', 'tracking_account', null, { format, totalItems });

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', mimeType);
    return res.status(200).send(content);
  }),

  /**
   * Bulk import of `<name>.session` + `<name>.json` pairs bundled in a
   * single ZIP (the common session-selling-tool export format). Each
   * pair auto-populates basic info, session/device fingerprint, 2FA
   * (encrypted), and passive Telegram metadata — the session file itself
   * is only ever stored, never parsed or connected to.
   */
  importSessionZip: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    if (!req.file) {
      throw new AppError('Zip file is required', 400, 'MISSING_FILE');
    }
    const result = await trackingSessionZipImportService.importZip(userId, req.file);

    await reportService.logActivity(userId, 'tracking_session_zip_import', 'tracking_account', null, {
      created: result.created, updated: result.updated, total: result.total, errorCount: result.errors.length,
    });
    logger.info(`Tracking session ZIP import by user ${userId}: ${result.created} created, ${result.updated} updated, ${result.errors.length} errors`);

    return res.status(200).json({ success: true, data: result });
  }),

  downloadTemplate: asyncHandler(async (req, res) => {
    const csv = trackingImportExportService.getTemplate();
    res.setHeader('Content-Disposition', 'attachment; filename="tracking-import-template.csv"');
    res.setHeader('Content-Type', 'text/csv');
    return res.status(200).send(csv);
  }),
};

module.exports = trackingImportExportController;
