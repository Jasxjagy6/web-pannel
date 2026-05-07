// Hard ceiling for "unbounded" list calls. Lets the Sessions tab show
// every uploaded row even when the user has thousands of sessions, but
// stops a malformed query from pulling 10M rows into Node memory.
// Override via env if a real customer ever blows past it.
const MAX_UNBOUNDED_LIST = Math.max(
  1000,
  parseInt(process.env.MAX_UNBOUNDED_LIST || '20000', 10) || 20000
);

// Internal helper: returns either a normal { offset, pageSize } pair, or
// the special unbounded shape { offset: 0, pageSize: MAX_UNBOUNDED_LIST,
// unbounded: true } when the caller passed limit=0 / 'all' / -1. The
// unbounded shape is only honoured by callers that opted in (see
// sessionService.listSessions); other callers still hit the 100-row cap.
const isUnboundedLimit = (limit) => {
  if (limit == null) return false;
  if (limit === 0 || limit === '0') return true;
  if (typeof limit === 'string' && limit.toLowerCase() === 'all') return true;
  const n = parseInt(limit, 10);
  return Number.isFinite(n) && n < 0;
};

const buildPagination = (page = 1, limit = 20, total = 0, opts = {}) => {
  const currentPage = Math.max(1, parseInt(page) || 1);
  if (opts.allowUnbounded && isUnboundedLimit(limit)) {
    return {
      currentPage: 1,
      pageSize: total,
      totalPages: 1,
      total,
      hasNext: false,
      hasPrev: false,
      unbounded: true,
    };
  }
  const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 20));
  const totalPages = Math.ceil(total / pageSize);
  return {
    currentPage,
    pageSize,
    totalPages,
    total,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1,
  };
};

const applyPagination = (query, page = 1, limit = 20, opts = {}) => {
  if (opts.allowUnbounded && isUnboundedLimit(limit)) {
    return { offset: 0, limit: MAX_UNBOUNDED_LIST, unbounded: true };
  }
  const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 20));
  const offset = (Math.max(1, parseInt(page) || 1) - 1) * pageSize;
  return { offset, limit: pageSize };
};

const applySorting = (sortField, sortOrder, allowedFields = []) => {
  const field = allowedFields.includes(sortField) ? sortField : 'created_at';
  const order = ['ASC', 'DESC'].includes((sortOrder || 'DESC').toUpperCase())
    ? sortOrder.toUpperCase()
    : 'DESC';
  return { field, order };
};

const paginateResults = (items, page = 1, limit = 20) => {
  const { offset, limit: pageSize } = applyPagination(null, page, limit);
  const paginatedItems = items.slice(offset, offset + pageSize);
  const pagination = buildPagination(page, limit, items.length);
  return { items: paginatedItems, pagination };
};

module.exports = {
  buildPagination,
  applyPagination,
  applySorting,
  paginateResults,
  MAX_UNBOUNDED_LIST,
};
