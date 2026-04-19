const buildPagination = (page = 1, limit = 20, total = 0) => {
  const currentPage = Math.max(1, parseInt(page));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit)));
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

const applyPagination = (query, page = 1, limit = 20) => {
  const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, Math.max(1, parseInt(limit)));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit)));
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
};
