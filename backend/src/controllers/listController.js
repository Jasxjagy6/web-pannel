const listService = require('../services/listService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const listController = {
  /**
   * Import a contact list from an uploaded file (CSV, JSON, or TXT).
   *
   * Expects multipart/form-data with file under the "file" field name.
   * Query params: name (required), type (optional: users|groups|channels)
   * Multer middleware populates req.file before this handler runs.
   */
  importList: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    if (!req.file) {
      throw new AppError('File is required for import', 400, 'MISSING_FILE');
    }

    const listName = req.body.name;
    const type = req.body.type || 'users';

    if (!listName || listName.trim().length === 0) {
      throw new AppError('List name is required', 400, 'MISSING_LIST_NAME');
    }

    const result = await listService.importList(userId, req.file, listName, type);

    await reportService.logActivity(
      userId,
      'list_import',
      'list',
      result.listId,
      {
        listName: result.listName,
        type,
        totalImported: result.totalImported,
        totalParsed: result.totalParsed,
        totalDuplicate: result.totalDuplicate,
        fileName: req.file.originalname,
      }
    );

    logger.info(`List imported by user ${userId}`, {
      listId: result.listId,
      listName: result.listName,
      totalImported: result.totalImported,
    });

    return res.status(201).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Create a new list from the results of a completed scraping job.
   *
   * Expects req.body: { scrapeJobId, listName }
   */
  createFromScrape: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { scrapeJobId, listName } = req.body;

    if (!scrapeJobId) {
      throw new AppError('scrapeJobId is required', 400, 'MISSING_SCRAPE_JOB_ID');
    }

    if (!listName || listName.trim().length === 0) {
      throw new AppError('listName is required', 400, 'MISSING_LIST_NAME');
    }

    const result = await listService.createListFromScrape(userId, scrapeJobId, listName);

    await reportService.logActivity(
      userId,
      'list_import',
      'list',
      result.listId,
      {
        listName: result.listName,
        source: `job_${scrapeJobId}`,
        totalItems: result.totalItems,
      }
    );

    logger.info(`List created from scrape job by user ${userId}`, {
      listId: result.listId,
      scrapeJobId,
      totalItems: result.totalItems,
    });

    return res.status(201).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Merge multiple lists into a single new list, deduplicating by telegram_id.
   *
   * Expects req.body: { listIds: [number], newListName }
   */
  mergeLists: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { listIds, newListName } = req.body;

    if (!listIds || !Array.isArray(listIds) || listIds.length < 2) {
      throw new AppError('At least two list IDs are required for merging', 400, 'INSUFFICIENT_LISTS');
    }

    if (!newListName || newListName.trim().length === 0) {
      throw new AppError('newListName is required', 400, 'MISSING_LIST_NAME');
    }

    const result = await listService.mergeLists(userId, listIds, newListName);

    await reportService.logActivity(
      userId,
      'list_merge',
      'list',
      result.listId,
      {
        listName: result.listName,
        sourceListCount: result.sourceListCount,
        totalItems: result.totalItems,
        totalDuplicates: result.totalDuplicates,
        sourceListIds: listIds,
      }
    );

    logger.info(`Lists merged by user ${userId}`, {
      newListId: result.listId,
      sourceCount: result.sourceListCount,
      totalItems: result.totalItems,
    });

    return res.status(201).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Remove duplicate entries from a list based on telegram_id.
   *
   * List ID comes from req.params.id.
   */
  deduplicateList: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const listId = req.params.id;

    if (!listId) {
      throw new AppError('List ID is required', 400, 'MISSING_LIST_ID');
    }

    const result = await listService.deduplicateList(userId, listId);

    await reportService.logActivity(
      userId,
      'list_import',
      'list',
      listId,
      {
        action: 'deduplicate',
        totalBefore: result.totalBefore,
        totalAfter: result.totalAfter,
        duplicatesRemoved: result.duplicatesRemoved,
      }
    );

    logger.info(`List ${listId} deduplicated by user ${userId}`, {
      duplicatesRemoved: result.duplicatesRemoved,
      totalBefore: result.totalBefore,
      totalAfter: result.totalAfter,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Export a list in the specified format.
   *
   * List ID comes from req.params.id.
   * Query params: format (csv|json|txt, default: csv)
   */
  exportList: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const listId = req.params.id;
    const format = req.body.format || req.query.format || 'csv';

    if (!listId) {
      throw new AppError('List ID is required', 400, 'MISSING_LIST_ID');
    }

    const { content, filename, mimeType, totalItems } = await listService.exportList(userId, listId, format);

    await reportService.logActivity(
      userId,
      'list_export',
      'list',
      listId,
      { format, totalItems }
    );

    logger.info(`List ${listId} exported as ${format} by user ${userId}`, {
      totalItems,
      format,
    });

    // Set appropriate headers for file download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', Buffer.byteLength(content));

    return res.status(200).send(content);
  }),

  /**
   * List all contact lists for the authenticated user with pagination.
   *
   * Query params: page, limit, sort, order
   */
  listLists: asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const sort = req.query.sort || 'created_at';
    const order = req.query.order || 'DESC';

    const { lists, pagination } = await listService.listLists(userId, {
      page,
      limit,
      sort,
      order,
    });

    return res.status(200).json({
      success: true,
      data: {
        lists,
        pagination,
      },
    });
  }),

  /**
   * Get detailed information about a list including paginated items.
   *
   * List ID comes from req.params.id.
   * Query params: page, limit
   */
  getList: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const listId = req.params.id;

    if (!listId) {
      throw new AppError('List ID is required', 400, 'MISSING_LIST_ID');
    }

    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;

    const result = await listService.getListDetails(userId, listId, { page, limit });

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Get paginated list items with optional search.
   *
   * List ID comes from req.params.id.
   * Query params: page, limit, search
   */
  getListItems: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const listId = req.params.id;

    if (!listId) {
      throw new AppError('List ID is required', 400, 'MISSING_LIST_ID');
    }

    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const search = req.query.search || undefined;

    const result = await listService.getListItems(userId, listId, {
      page,
      limit,
      search,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Update a list's name.
   *
   * List ID comes from req.params.id.
   * Expects req.body: { name }
   */
  updateList: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const listId = req.params.id;

    if (!listId) {
      throw new AppError('List ID is required', 400, 'MISSING_LIST_ID');
    }

    const { name } = req.body;

    if (!name || name.trim().length === 0) {
      throw new AppError('New list name is required', 400, 'MISSING_LIST_NAME');
    }

    const result = await listService.updateList(userId, listId, name);

    logger.info(`List ${listId} renamed by user ${userId}`, {
      listId,
      newName: name.trim(),
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Delete a list and all of its items.
   *
   * List ID comes from req.params.id.
   */
  deleteList: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const listId = req.params.id;

    if (!listId) {
      throw new AppError('List ID is required', 400, 'MISSING_LIST_ID');
    }

    const result = await listService.deleteList(userId, listId);

    await reportService.logActivity(
      userId,
      'list_delete',
      'list',
      listId,
      {
        deletedItems: result.deletedItems,
      }
    );

    logger.info(`List ${listId} deleted by user ${userId}`, {
      listId,
      deletedItems: result.deletedItems,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Manually add items to an existing list.
   *
   * List ID comes from req.params.id.
   * Expects req.body: { items: [{ telegram_id?, username?, first_name?, last_name?, phone? }] }
   * Items can also be sent as a raw JSON string in req.body.itemsString.
   */
  addItems: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const listId = req.params.id;

    if (!listId) {
      throw new AppError('List ID is required', 400, 'MISSING_LIST_ID');
    }

    let items = req.body.items;

    // Support items sent as a JSON string
    if (!items && req.body.itemsString) {
      try {
        items = typeof req.body.itemsString === 'string'
          ? JSON.parse(req.body.itemsString)
          : req.body.itemsString;
      } catch (parseError) {
        throw new AppError('Invalid JSON in itemsString', 400, 'INVALID_JSON');
      }
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new AppError('At least one item is required', 400, 'NO_ITEMS');
    }

    const result = await listService.addItemsToList(userId, listId, items);

    logger.info(`Items added to list ${listId} by user ${userId}`, {
      listId,
      totalAdded: result.totalAdded,
      totalSubmitted: result.totalSubmitted,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Remove specific items from a list by their item IDs.
   *
   * List ID comes from req.params.id.
   * Expects req.body: { itemIds: [number] }
   */
  removeItems: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const listId = req.params.id;

    if (!listId) {
      throw new AppError('List ID is required', 400, 'MISSING_LIST_ID');
    }

    const { itemIds } = req.body;

    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
      throw new AppError('itemIds array is required and must not be empty', 400, 'NO_ITEM_IDS');
    }

    const result = await listService.removeItems(userId, listId, itemIds);

    logger.info(`Items removed from list ${listId} by user ${userId}`, {
      listId,
      removedCount: result.removedCount,
      remainingCount: result.remainingCount,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),

  /**
   * Get statistics for a specific list.
   *
   * List ID comes from req.params.id.
   */
  getListStats: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const listId = req.params.id;

    if (!listId) {
      throw new AppError('List ID is required', 400, 'MISSING_LIST_ID');
    }

    const stats = await listService.getListStats(userId, listId);

    return res.status(200).json({
      success: true,
      data: stats,
    });
  }),
};

module.exports = listController;
