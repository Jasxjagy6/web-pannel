import React, { useState, useMemo } from 'react';
import { Search, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

/**
 * DataTable - A sortable, filterable, paginated table component.
 *
 * @param {Object} props
 * @param {Array<{ key: string, label: string, sortable?: boolean, render?: Function, className?: string }>} props.columns
 *   Column definitions for the table.
 * @param {Array<Object>} props.data
 *   Array of row data objects.
 * @param {boolean} [props.loading=false]
 *   Whether to display a loading state.
 * @param {Function} [props.onRowClick]
 *   Callback invoked with the row data when a row is clicked.
 * @param {Array<{ label: string, icon: React.ReactNode, onClick: Function, variant?: string }>} [props.actions=[]]
 *   Action buttons rendered in the actions column.
 * @param {string} [props.searchPlaceholder='Search...']
 *   Placeholder text for the search input.
 * @param {boolean} [props.searchable=true]
 *   Whether to show the search input.
 * @param {boolean} [props.paginated=true]
 *   Whether to paginate results.
 * @param {number} [props.pageSize=10]
 *   Number of rows per page.
 */
export default function DataTable({
  columns,
  data = [],
  loading = false,
  onRowClick,
  actions = [],
  searchPlaceholder = 'Search...',
  searchable = true,
  paginated = true,
  pageSize = 10,
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortField, setSortField] = useState(null);
  const [sortOrder, setSortOrder] = useState('asc');
  const [currentPage, setCurrentPage] = useState(1);

  /** Filter data by search term across all string values */
  const filteredData = useMemo(() => {
    if (!searchTerm.trim()) return data;
    const lower = searchTerm.toLowerCase();
    return data.filter((row) =>
      columns.some((col) => {
        const value = row[col.key];
        if (typeof value === 'string') return value.toLowerCase().includes(lower);
        if (value !== null && value !== undefined) return String(value).toLowerCase().includes(lower);
        return false;
      })
    );
  }, [data, searchTerm, columns]);

  /** Sort filtered data by field and order */
  const sortedData = useMemo(() => {
    if (!sortField) return filteredData;
    const sorted = [...filteredData].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return sortOrder === 'asc' ? -1 : 1;
      if (bVal == null) return sortOrder === 'asc' ? 1 : -1;
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
      }
      return sortOrder === 'asc'
        ? String(aVal).localeCompare(String(bVal))
        : String(bVal).localeCompare(String(aVal));
    });
    return sorted;
  }, [filteredData, sortField, sortOrder]);

  /** Paginate sorted data */
  const paginatedData = useMemo(() => {
    if (!paginated) return sortedData;
    const start = (currentPage - 1) * pageSize;
    return sortedData.slice(start, start + pageSize);
  }, [sortedData, currentPage, pageSize, paginated]);

  const totalPages = paginated ? Math.ceil(sortedData.length / pageSize) : 1;

  /** Reset to page 1 when search or sort changes */
  const handleSearch = (value) => {
    setSearchTerm(value);
    setCurrentPage(1);
  };

  const handleSort = (key, sortable) => {
    if (!sortable) return;
    if (sortField === key) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(key);
      setSortOrder('asc');
    }
    setCurrentPage(1);
  };

  /** Generate page numbers with ellipsis for large page counts */
  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    if (totalPages <= maxVisible + 2) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (currentPage > 3) pages.push('...');
      const start = Math.max(2, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (currentPage < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    return pages;
  };

  const renderSortIcon = (col) => {
    if (!col.sortable) return null;
    if (sortField !== col.key) {
      return (
        <span className="ml-1 opacity-40">
          <ChevronUp className="w-3.5 h-3.5" />
        </span>
      );
    }
    return (
      <span className="ml-1 text-primary-500">
        {sortOrder === 'asc' ? (
          <ChevronUp className="w-3.5 h-3.5" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5" />
        )}
      </span>
    );
  };

  /** Action button variant styles */
  const variantStyles = {
    primary: 'text-primary-500 hover:bg-primary-500/10',
    danger: 'text-red-400 hover:bg-red-500/10',
    warning: 'text-yellow-400 hover:bg-yellow-500/10',
    success: 'text-green-400 hover:bg-green-500/10',
    default: 'text-gray-300 hover:bg-white/5',
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 bg-dark-800 rounded-xl border border-white/5">
        <Loader2 className="w-8 h-8 text-primary-500 animate-spin mb-3" />
        <p className="text-gray-400 text-sm">Loading data...</p>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 bg-dark-800 rounded-xl border border-white/5">
        <div className="w-12 h-12 rounded-full bg-dark-900 flex items-center justify-center mb-3">
          <Search className="w-5 h-5 text-gray-500" />
        </div>
        <p className="text-gray-400 font-medium">No data available</p>
        <p className="text-gray-500 text-sm mt-1">Add some data to get started</p>
      </div>
    );
  }

  return (
    <div className="bg-dark-800 rounded-xl border border-white/5 overflow-hidden">
      {/* Search Bar */}
      {searchable && (
        <div className="p-4 border-b border-white/5">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full pl-10 pr-4 py-2 bg-dark-900 border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition"
              aria-label={searchPlaceholder}
            />
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/5">
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key, col.sortable)}
                  className={`px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider ${
                    col.sortable ? 'cursor-pointer hover:text-gray-200 select-none' : ''
                  } ${col.className || ''}`}
                  role={col.sortable ? 'columnheader button' : 'columnheader'}
                  aria-sort={
                    sortField === col.key
                      ? sortOrder === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <span className="inline-flex items-center">
                    {col.label}
                    {renderSortIcon(col)}
                  </span>
                </th>
              ))}
              {actions.length > 0 && (
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {paginatedData.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                onClick={() => onRowClick && onRowClick(row)}
                className={`transition-colors ${
                  onRowClick ? 'cursor-pointer hover:bg-white/[0.02]' : ''
                }`}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-4 py-3 text-sm text-gray-300 whitespace-nowrap ${col.className || ''}`}
                  >
                    {col.render ? col.render(row[col.key], row) : row[col.key]}
                  </td>
                ))}
                {actions.length > 0 && (
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-1">
                      {actions.map((action, actionIndex) => (
                        <button
                          key={actionIndex}
                          onClick={(e) => {
                            e.stopPropagation();
                            action.onClick(row);
                          }}
                          className={`p-1.5 rounded-lg transition-colors ${
                            variantStyles[action.variant] || variantStyles.default
                          }`}
                          title={action.label}
                          aria-label={action.label}
                        >
                          {action.icon}
                        </button>
                      ))}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* No results after filtering */}
      {paginatedData.length === 0 && searchable && searchTerm && (
        <div className="flex flex-col items-center justify-center py-12">
          <Search className="w-8 h-8 text-gray-600 mb-2" />
          <p className="text-gray-400 text-sm">No results found for &quot;{searchTerm}&quot;</p>
        </div>
      )}

      {/* Pagination Footer */}
      {paginated && totalPages > 1 && (
        <div className="px-4 py-3 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-sm text-gray-400">
            Showing{' '}
            <span className="text-gray-200 font-medium">
              {(currentPage - 1) * pageSize + 1}
            </span>{' '}
            to{' '}
            <span className="text-gray-200 font-medium">
              {Math.min(currentPage * pageSize, sortedData.length)}
            </span>{' '}
            of{' '}
            <span className="text-gray-200 font-medium">{sortedData.length}</span>{' '}
            results
          </p>
          <nav className="flex items-center gap-1" aria-label="Pagination">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition"
              aria-label="Previous page"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            {getPageNumbers().map((page, i) =>
              typeof page === 'number' ? (
                <button
                  key={i}
                  onClick={() => setCurrentPage(page)}
                  className={`min-w-[2rem] h-8 rounded-lg text-sm font-medium transition ${
                    page === currentPage
                      ? 'bg-primary-600 text-white'
                      : 'text-gray-400 hover:text-white hover:bg-white/5'
                  }`}
                  aria-current={page === currentPage ? 'page' : undefined}
                  aria-label={`Page ${page}`}
                >
                  {page}
                </button>
              ) : (
                <span key={i} className="px-1 text-gray-500 text-sm">
                  ...
                </span>
              )
            )}
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition"
              aria-label="Next page"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </nav>
        </div>
      )}
    </div>
  );
}
