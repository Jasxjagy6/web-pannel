/**
 * Session-Lists controller.
 *
 * Mounted under `/api/{platform}/session-lists` so the platform is
 * resolved by the platform middleware (`req.platform`).
 */

const sessionListService = require('../services/sessionListService');
const reportService = require('../services/reportService');
const { asyncHandler, AppError } = require('../utils/errorHandler');

function _platform(req) {
  return req.platform || 'telegram';
}

function _listId(req) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new AppError('Invalid list id', 400, 'BAD_ID');
  }
  return id;
}

module.exports = {
  /** GET /api/{platform}/session-lists */
  list: asyncHandler(async (req, res) => {
    const platform = _platform(req);
    const search = (req.query.search || '').trim() || null;
    const lists = await sessionListService.listLists({
      userId: req.user.id,
      platform,
      search,
    });
    return res.json({ success: true, data: { lists } });
  }),

  /** POST /api/{platform}/session-lists */
  create: asyncHandler(async (req, res) => {
    const platform = _platform(req);
    const { name, description, sessionIds } = req.body || {};
    const list = await sessionListService.createList({
      userId: req.user.id,
      platform,
      name,
      description,
      sessionIds,
    });
    reportService
      .logActivity(req.user.id, 'session_list_create', 'session_list', list.id, {
        platform,
        name: list.name,
        sessions: Array.isArray(sessionIds) ? sessionIds.length : 0,
      })
      .catch(() => {});
    return res.status(201).json({ success: true, data: list });
  }),

  /** GET /api/{platform}/session-lists/:id */
  get: asyncHandler(async (req, res) => {
    const id = _listId(req);
    const list = await sessionListService.getList({ userId: req.user.id, listId: id });
    return res.json({ success: true, data: list });
  }),

  /** GET /api/{platform}/session-lists/:id/sessions */
  getSessions: asyncHandler(async (req, res) => {
    const id = _listId(req);
    const includeAll = req.query.includeAll === 'true' || req.query.include_all === 'true';
    const sessions = await sessionListService.getListSessions({
      userId: req.user.id,
      listId: id,
      includeAll,
    });
    return res.json({ success: true, data: { sessions } });
  }),

  /** PUT /api/{platform}/session-lists/:id */
  update: asyncHandler(async (req, res) => {
    const id = _listId(req);
    const { name, description } = req.body || {};
    const list = await sessionListService.updateList({
      userId: req.user.id,
      listId: id,
      name,
      description,
    });
    reportService
      .logActivity(req.user.id, 'session_list_update', 'session_list', id, {
        name: list.name,
      })
      .catch(() => {});
    return res.json({ success: true, data: list });
  }),

  /** DELETE /api/{platform}/session-lists/:id */
  remove: asyncHandler(async (req, res) => {
    const id = _listId(req);
    await sessionListService.deleteList({ userId: req.user.id, listId: id });
    reportService
      .logActivity(req.user.id, 'session_list_delete', 'session_list', id, {})
      .catch(() => {});
    return res.json({ success: true, data: { id } });
  }),

  /** POST /api/{platform}/session-lists/:id/sessions  body: { sessionIds: [...] } */
  addSessions: asyncHandler(async (req, res) => {
    const id = _listId(req);
    const { sessionIds } = req.body || {};
    const list = await sessionListService.addSessions({
      userId: req.user.id,
      listId: id,
      sessionIds,
    });
    return res.json({ success: true, data: list });
  }),

  /** DELETE /api/{platform}/session-lists/:id/sessions  body: { sessionIds: [...] } */
  removeSessions: asyncHandler(async (req, res) => {
    const id = _listId(req);
    const { sessionIds } = req.body || {};
    const list = await sessionListService.removeSessions({
      userId: req.user.id,
      listId: id,
      sessionIds,
    });
    return res.json({ success: true, data: list });
  }),

  /** PUT /api/{platform}/session-lists/:id/sessions  body: { sessionIds: [...] } — replace */
  setSessions: asyncHandler(async (req, res) => {
    const id = _listId(req);
    const { sessionIds } = req.body || {};
    const list = await sessionListService.setSessions({
      userId: req.user.id,
      listId: id,
      sessionIds,
    });
    return res.json({ success: true, data: list });
  }),
};
