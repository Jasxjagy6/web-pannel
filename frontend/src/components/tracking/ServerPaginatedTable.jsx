import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Loader2 } from 'lucide-react';

/**
 * Server-driven table: the parent owns page/sort/filter state and fetches
 * each page from the API. Unlike components/common/DataTable.jsx (which
 * loads the full dataset client-side), this scales to 1000+ rows since
 * only one page is ever in memory.
 */
export default function ServerPaginatedTable({
  columns,
  rows,
  loading = false,
  page = 1,
  pageSize = 20,
  total = 0,
  onPageChange,
  sort,
  order = 'DESC',
  onSortChange,
  selectable = false,
  selectedIds = [],
  onSelectionChange,
  onRowClick,
  emptyMessage = 'No records found.',
  rowKey = 'id',
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selectedSet = new Set(selectedIds);
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selectedSet.has(r[rowKey]));

  const toggleAll = () => {
    if (!onSelectionChange) return;
    if (allOnPageSelected) {
      const rowIds = new Set(rows.map((r) => r[rowKey]));
      onSelectionChange(selectedIds.filter((id) => !rowIds.has(id)));
    } else {
      const merged = new Set(selectedIds);
      rows.forEach((r) => merged.add(r[rowKey]));
      onSelectionChange(Array.from(merged));
    }
  };

  const toggleOne = (id) => {
    if (!onSelectionChange) return;
    if (selectedSet.has(id)) {
      onSelectionChange(selectedIds.filter((v) => v !== id));
    } else {
      onSelectionChange([...selectedIds, id]);
    }
  };

  const handleSort = (col) => {
    if (!col.sortable || !onSortChange) return;
    if (sort === col.key) {
      onSortChange(col.key, order === 'ASC' ? 'DESC' : 'ASC');
    } else {
      onSortChange(col.key, 'ASC');
    }
  };

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800/50 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/5">
              {selectable && (
                <th className="px-4 py-2.5 w-10">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleAll}
                    className="h-4 w-4 rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500"
                  />
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col)}
                  className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 ${
                    col.sortable ? 'cursor-pointer select-none hover:text-gray-200' : ''
                  } ${col.className || ''}`}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {col.sortable && sort === col.key && (
                      order === 'ASC' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading ? (
              <tr>
                <td colSpan={columns.length + (selectable ? 1 : 0)} className="py-10 text-center">
                  <Loader2 className="h-5 w-5 mx-auto animate-spin text-gray-400" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (selectable ? 1 : 0)} className="py-8 text-center text-sm text-gray-400">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row[rowKey]}
                  onClick={() => onRowClick && onRowClick(row)}
                  className={`transition-colors hover:bg-white/[0.02] ${onRowClick ? 'cursor-pointer' : ''}`}
                >
                  {selectable && (
                    <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedSet.has(row[rowKey])}
                        onChange={() => toggleOne(row[rowKey])}
                        className="h-4 w-4 rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500"
                      />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td key={col.key} className={`px-4 py-2.5 text-sm text-gray-300 ${col.className || ''}`}>
                      {col.render ? col.render(row) : (row[col.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between px-4 py-3 border-t border-white/5">
        <p className="text-sm text-gray-400">
          {total === 0 ? 'No records' : `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
        </p>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page === 1}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm text-gray-400 px-2">{page} / {totalPages}</span>
          <button
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
