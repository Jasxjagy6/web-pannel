const trackingAccountService = require('../services/trackingAccountService');
const trackingSessionInfoService = require('../services/trackingSessionInfoService');
const trackingSimInfoService = require('../services/trackingSimInfoService');
const trackingSecurityService = require('../services/trackingSecurityService');
const trackingPurchaseService = require('../services/trackingPurchaseService');
const trackingSalesService = require('../services/trackingSalesService');
const trackingAssignmentService = require('../services/trackingAssignmentService');
const trackingNoteService = require('../services/trackingNoteService');
const trackingTagService = require('../services/trackingTagService');
const trackingAttachmentService = require('../services/trackingAttachmentService');
const trackingTelegramSyncService = require('../services/trackingTelegramSyncService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

function parseFilters(query) {
  const filters = {};
  if (query.status) filters.status = Array.isArray(query.status) ? query.status : query.status.split(',');
  if (query.phone) filters.phone = query.phone;
  if (query.username) filters.username = query.username;
  if (query.telegramUserId) filters.telegramUserId = query.telegramUserId;
  if (query.country) filters.country = query.country;
  if (query.premium !== undefined) filters.premium = query.premium;
  if (query.assignedToUserId) filters.assignedToUserId = query.assignedToUserId;
  if (query.salePriceMin !== undefined) filters.salePriceMin = query.salePriceMin;
  if (query.salePriceMax !== undefined) filters.salePriceMax = query.salePriceMax;
  if (query.purchasePriceMin !== undefined) filters.purchasePriceMin = query.purchasePriceMin;
  if (query.purchasePriceMax !== undefined) filters.purchasePriceMax = query.purchasePriceMax;
  if (query.dateFrom) filters.dateFrom = query.dateFrom;
  if (query.dateTo) filters.dateTo = query.dateTo;
  if (query.buyer) filters.buyer = query.buyer;
  if (query.supplier) filters.supplier = query.supplier;
  if (query.tagIds) {
    filters.tagIds = (Array.isArray(query.tagIds) ? query.tagIds : query.tagIds.split(','))
      .map((v) => parseInt(v, 10))
      .filter((v) => Number.isFinite(v));
  }
  if (query.search) filters.search = query.search;
  if (query.includeDeleted === 'true') filters.includeDeleted = true;
  return filters;
}

const trackingAccountController = {
  listAccounts: asyncHandler(async (req, res) => {
    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const sort = req.query.sort || 'created_at';
    const order = req.query.order || 'DESC';
    const filters = parseFilters(req.query);

    const result = await trackingAccountService.listAccounts(filters, { page, limit, sort, order });

    return res.status(200).json({ success: true, data: result });
  }),

  getAccount: asyncHandler(async (req, res) => {
    const account = await trackingAccountService.getAccountDetail(req.params.id);
    return res.status(200).json({ success: true, data: account });
  }),

  createAccount: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const account = await trackingAccountService.createAccount(userId, req.body);

    await reportService.logActivity(userId, 'tracking_account_created', 'tracking_account', account.id, {
      internalCode: account.internalCode,
      username: account.username,
      phoneNumber: account.phoneNumber,
    });
    logger.info(`Tracking account ${account.id} created by user ${userId}`);

    return res.status(201).json({ success: true, data: account });
  }),

  updateAccount: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const account = await trackingAccountService.updateAccount(userId, id, req.body);

    await reportService.logActivity(userId, 'tracking_account_updated', 'tracking_account', id, {
      fields: Object.keys(req.body || {}),
    });

    return res.status(200).json({ success: true, data: account });
  }),

  deleteAccount: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const result = await trackingAccountService.softDeleteAccount(userId, id);

    await reportService.logActivity(userId, 'tracking_account_deleted', 'tracking_account', id, {});
    logger.info(`Tracking account ${id} soft-deleted by user ${userId}`);

    return res.status(200).json({ success: true, data: result });
  }),

  restoreAccount: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const account = await trackingAccountService.restoreAccount(userId, id);

    await reportService.logActivity(userId, 'tracking_account_restored', 'tracking_account', id, {});

    return res.status(200).json({ success: true, data: account });
  }),

  changeStatus: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const { status, reservedUntil } = req.body;

    if (!status) {
      throw new AppError('status is required', 400, 'MISSING_STATUS');
    }

    const account = await trackingAccountService.changeStatus(userId, id, status, { reservedUntil });

    await reportService.logActivity(userId, 'tracking_account_status_changed', 'tracking_account', id, {
      status,
      reservedUntil: reservedUntil || null,
    });
    logger.info(`Tracking account ${id} status changed to ${status} by user ${userId}`);

    return res.status(200).json({ success: true, data: account });
  }),
  // ---------------------------------------------------------------------
  // Session Information
  // ---------------------------------------------------------------------
  getSession: asyncHandler(async (req, res) => {
    const session = await trackingSessionInfoService.getByAccount(req.params.id);
    return res.status(200).json({ success: true, data: session });
  }),

  updateSession: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const session = await trackingSessionInfoService.upsert(id, req.body);
    await reportService.logActivity(userId, 'tracking_session_updated', 'tracking_account', id, {});
    return res.status(200).json({ success: true, data: session });
  }),

  uploadSessionFile: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    if (!req.file) {
      throw new AppError('File is required', 400, 'MISSING_FILE');
    }
    const session = await trackingSessionInfoService.attachSessionFile(id, userId, req.file);
    await reportService.logActivity(userId, 'tracking_session_updated', 'tracking_account', id, {
      action: 'session_file_uploaded',
      fileName: req.file.originalname,
      fileSize: req.file.size,
    });
    logger.info(`Tracking session file uploaded for account ${id} by user ${userId}`);
    return res.status(200).json({ success: true, data: session });
  }),

  uploadBackupFile: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    if (!req.file) {
      throw new AppError('File is required', 400, 'MISSING_FILE');
    }
    const session = await trackingSessionInfoService.attachBackupFile(id, userId, req.file);
    await reportService.logActivity(userId, 'tracking_session_updated', 'tracking_account', id, {
      action: 'backup_file_uploaded',
      fileName: req.file.originalname,
      fileSize: req.file.size,
    });
    return res.status(200).json({ success: true, data: session });
  }),

  // ---------------------------------------------------------------------
  // SIM Information
  // ---------------------------------------------------------------------
  getSim: asyncHandler(async (req, res) => {
    const sim = await trackingSimInfoService.getByAccount(req.params.id);
    return res.status(200).json({ success: true, data: sim });
  }),

  updateSim: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const sim = await trackingSimInfoService.upsert(id, req.body);
    await reportService.logActivity(userId, 'tracking_sim_updated', 'tracking_account', id, {});
    return res.status(200).json({ success: true, data: sim });
  }),

  // ---------------------------------------------------------------------
  // Security (encrypted) — gated by the `security` permission at the
  // route level, in addition to `view`/`edit`.
  // ---------------------------------------------------------------------
  getSecurity: asyncHandler(async (req, res) => {
    const security = await trackingSecurityService.getByAccount(req.params.id);
    return res.status(200).json({ success: true, data: security });
  }),

  updateSecurity: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const security = await trackingSecurityService.upsert(id, req.body);
    // Never log field values for security actions.
    await reportService.logActivity(userId, 'tracking_security_updated', 'tracking_account', id, {
      fields: Object.keys(req.body || {}),
    });
    return res.status(200).json({ success: true, data: security });
  }),

  // ---------------------------------------------------------------------
  // Purchase Information
  // ---------------------------------------------------------------------
  getPurchase: asyncHandler(async (req, res) => {
    const purchase = await trackingPurchaseService.getByAccount(req.params.id);
    return res.status(200).json({ success: true, data: purchase });
  }),

  updatePurchase: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const purchase = await trackingPurchaseService.upsert(id, req.body);
    await reportService.logActivity(userId, 'tracking_purchase_updated', 'tracking_account', id, {
      purchasePrice: purchase.purchasePrice,
      supplierName: purchase.supplierName,
    });
    return res.status(200).json({ success: true, data: purchase });
  }),

  // ---------------------------------------------------------------------
  // Sales Tracking
  // ---------------------------------------------------------------------
  getSales: asyncHandler(async (req, res) => {
    const sales = await trackingSalesService.listByAccount(req.params.id);
    return res.status(200).json({ success: true, data: sales });
  }),

  addSale: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const sale = await trackingSalesService.recordSale(userId, id, req.body);

    await reportService.logActivity(userId, 'tracking_account_sold', 'tracking_account', id, {
      saleId: sale.id,
      salePrice: sale.salePrice,
      paymentStatus: sale.paymentStatus,
    });
    logger.info(`Tracking account ${id} sold (sale ${sale.id}) by user ${userId}`);

    return res.status(201).json({ success: true, data: sale });
  }),

  updateSale: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const saleId = req.params.saleId;
    const sale = await trackingSalesService.updateSale(userId, id, saleId, req.body);

    await reportService.logActivity(userId, 'tracking_sale_updated', 'tracking_account', id, {
      saleId: sale.id,
      fields: Object.keys(req.body || {}),
    });

    return res.status(200).json({ success: true, data: sale });
  }),

  // ---------------------------------------------------------------------
  // Assignments (append-only history)
  // ---------------------------------------------------------------------
  getAssignments: asyncHandler(async (req, res) => {
    const assignments = await trackingAssignmentService.listByAccount(req.params.id);
    return res.status(200).json({ success: true, data: assignments });
  }),

  assign: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const assignment = await trackingAssignmentService.assign(userId, id, req.body);

    await reportService.logActivity(userId, 'tracking_account_assigned', 'tracking_account', id, {
      assignmentId: assignment.id,
      assignedToUserId: assignment.assignedToUserId,
      assignedToName: assignment.assignedToName,
    });
    logger.info(`Tracking account ${id} assigned by user ${userId}`);

    return res.status(201).json({ success: true, data: assignment });
  }),

  returnAssignment: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const assignmentId = req.params.assignmentId;
    const assignment = await trackingAssignmentService.returnAssignment(userId, id, assignmentId);

    await reportService.logActivity(userId, 'tracking_account_returned', 'tracking_account', id, {
      assignmentId: assignment.id,
    });

    return res.status(200).json({ success: true, data: assignment });
  }),

  // ---------------------------------------------------------------------
  // Notes (unlimited, timestamped)
  // ---------------------------------------------------------------------
  getNotes: asyncHandler(async (req, res) => {
    const notes = await trackingNoteService.listByAccount(req.params.id);
    return res.status(200).json({ success: true, data: notes });
  }),

  addNote: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const note = await trackingNoteService.addNote(userId, id, req.body.note);

    await reportService.logActivity(userId, 'tracking_note_added', 'tracking_account', id, { noteId: note.id });

    return res.status(201).json({ success: true, data: note });
  }),

  // ---------------------------------------------------------------------
  // Attachments (session file / screenshots / documents / backups)
  // ---------------------------------------------------------------------
  getAttachments: asyncHandler(async (req, res) => {
    const attachments = await trackingAttachmentService.listByAccount(req.params.id);
    return res.status(200).json({ success: true, data: attachments });
  }),

  uploadAttachment: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    if (!req.file) {
      throw new AppError('File is required', 400, 'MISSING_FILE');
    }
    const category = req.body.category || 'other';
    const attachment = await trackingAttachmentService.upload(id, userId, req.file, category);

    await reportService.logActivity(userId, 'tracking_attachment_uploaded', 'tracking_account', id, {
      attachmentId: attachment.id,
      category,
      fileName: req.file.originalname,
    });

    return res.status(201).json({ success: true, data: attachment });
  }),

  downloadAttachment: asyncHandler(async (req, res) => {
    const attachment = await trackingAttachmentService.getForDownload(req.params.id, req.params.attachmentId);
    res.download(attachment.file_path, attachment.file_name);
  }),

  deleteAttachment: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const attachmentId = req.params.attachmentId;
    const result = await trackingAttachmentService.remove(id, attachmentId);

    await reportService.logActivity(userId, 'tracking_attachment_deleted', 'tracking_account', id, { attachmentId });

    return res.status(200).json({ success: true, data: result });
  }),

  // ---------------------------------------------------------------------
  // Tags (per-account assignment — catalog CRUD lives in trackingTagController)
  // ---------------------------------------------------------------------
  getAccountTags: asyncHandler(async (req, res) => {
    const tags = await trackingTagService.getTagsForAccount(req.params.id);
    return res.status(200).json({ success: true, data: tags });
  }),

  addAccountTags: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const { tagIds } = req.body;
    const tags = await trackingTagService.addTagsToAccount(id, userId, tagIds);

    await reportService.logActivity(userId, 'tracking_tag_added', 'tracking_account', id, { tagIds });

    return res.status(200).json({ success: true, data: tags });
  }),

  removeAccountTag: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const tagId = req.params.tagId;
    const tags = await trackingTagService.removeTagFromAccount(id, tagId);

    await reportService.logActivity(userId, 'tracking_tag_removed', 'tracking_account', id, { tagId });

    return res.status(200).json({ success: true, data: tags });
  }),

  // ---------------------------------------------------------------------
  // Live Telegram session sync
  // ---------------------------------------------------------------------
  syncAccount: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const id = req.params.id;
    const account = await trackingAccountService.getAccountRow(id);
    if (!account) {
      throw new AppError('Account not found', 404, 'TRACKING_ACCOUNT_NOT_FOUND');
    }
    if (!account.source_session_id) {
      throw new AppError('This account is not linked to a logged-in session', 400, 'NOT_SESSION_LINKED');
    }
    const detail = await trackingTelegramSyncService.syncFromSession(account.source_session_id, { actorUserId: userId });
    if (!detail) {
      throw new AppError('Source session is not a syncable Telegram session', 400, 'SESSION_NOT_SYNCABLE');
    }
    await reportService.logActivity(userId, 'tracking_session_synced', 'tracking_account', id, {});
    return res.status(200).json({ success: true, data: detail });
  }),

  syncAllLoggedIn: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const result = await trackingTelegramSyncService.syncAllLoggedIn({ actorUserId: userId });
    await reportService.logActivity(userId, 'tracking_session_synced', 'tracking_account', null, {
      candidates: result.candidates, synced: result.synced, errorCount: result.errors.length,
    });
    return res.status(200).json({ success: true, data: result });
  }),
};

module.exports = trackingAccountController;
