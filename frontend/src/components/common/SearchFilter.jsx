import React, { useState, useCallback } from 'react';
import { Search, ChevronDown } from 'lucide-react';

/**
 * SearchFilter - Combined search input and filter dropdown bar.
 *
 * @param {Object} props
 * @param {Function} [props.onSearch]
 *   Callback invoked with the search query string (debounced by the caller if needed).
 * @param {Function} [props.onFilter]
 *   Callback invoked with an object of active filter key-value pairs.
 * @param {Array<{ key: string, label: string, options: Array<{ value: string, label: string }> }>} [props.filters=[]]
 *   Filter configurations, each producing a dropdown.
 * @param {string} [props.placeholder='Search...']
 *   Placeholder text for the search input.
 */
export function SearchFilter({
  onSearch,
  onFilter,
  filters = [],
  placeholder = 'Search...',
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilters, setActiveFilters] = useState({});
  const [openDropdown, setOpenDropdown] = useState(null);

  /** Handle search input changes */
  const handleSearchChange = useCallback(
    (e) => {
      const value = e.target.value;
      setSearchTerm(value);
      if (onSearch) {
        onSearch(value);
      }
    },
    [onSearch]
  );

  /** Handle filter selection */
  const handleFilterChange = useCallback(
    (filterKey, value) => {
      setActiveFilters((prev) => {
        const next = { ...prev };
        if (value === '' || value === undefined || value === null) {
          delete next[filterKey];
        } else {
          next[filterKey] = value;
        }
        return next;
      });

      if (onFilter) {
        const updated = { ...activeFilters };
        if (value === '' || value === undefined || value === null) {
          delete updated[filterKey];
        } else {
          updated[filterKey] = value;
        }
        onFilter(updated);
      }
    },
    [activeFilters, onFilter]
  );

  /** Toggle dropdown open/close */
  const toggleDropdown = (filterKey) => {
    setOpenDropdown((prev) => (prev === filterKey ? null : filterKey));
  };

  /** Close dropdown when clicking outside */
  const handleSelectOption = (filterKey, value) => {
    handleFilterChange(filterKey, value);
    setOpenDropdown(null);
  };

  /** Get the current label for a filter's selected value */
  const getFilterLabel = (filterKey) => {
    const filter = filters.find((f) => f.key === filterKey);
    if (!filter) return '';
    const selectedValue = activeFilters[filterKey];
    if (!selectedValue) return filter.label;
    const option = filter.options.find((o) => o.value === selectedValue);
    return option ? option.label : filter.label;
  };

  const hasActiveFilters = Object.keys(activeFilters).length > 0;

  /** Clear all active filters */
  const clearFilters = useCallback(() => {
    setActiveFilters({});
    setOpenDropdown(null);
    if (onFilter) {
      onFilter({});
    }
  }, [onFilter]);

  return (
    <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3 w-full">
      {/* Search Input */}
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          value={searchTerm}
          onChange={handleSearchChange}
          placeholder={placeholder}
          className="w-full pl-10 pr-4 py-2 bg-dark-900 border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition"
          aria-label={placeholder}
        />
      </div>

      {/* Filter Dropdowns */}
      {filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {filters.map((filter) => (
            <div key={filter.key} className="relative">
              <button
                onClick={() => toggleDropdown(filter.key)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                  activeFilters[filter.key]
                    ? 'bg-primary-500/15 border-primary-500/30 text-primary-500'
                    : 'bg-dark-900 border-white/10 text-gray-300 hover:border-white/20'
                }`}
                aria-haspopup="listbox"
                aria-expanded={openDropdown === filter.key}
                aria-label={`Filter by ${filter.label}`}
              >
                {getFilterLabel(filter.key)}
                <ChevronDown className="w-3.5 h-3.5 opacity-60" />
              </button>

              {/* Dropdown Menu */}
              {openDropdown === filter.key && (
                <div
                  className="absolute top-full left-0 mt-1 min-w-[12rem] bg-dark-800 border border-white/10 rounded-lg shadow-xl z-50 py-1 overflow-hidden"
                  role="listbox"
                >
                  <button
                    onClick={() => handleSelectOption(filter.key, '')}
                    className={`w-full text-left px-3 py-2 text-sm transition ${
                      !activeFilters[filter.key]
                        ? 'bg-primary-500/10 text-primary-500'
                        : 'text-gray-300 hover:bg-white/5'
                    }`}
                    role="option"
                    aria-selected={!activeFilters[filter.key]}
                  >
                    All
                  </button>
                  {filter.options.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => handleSelectOption(filter.key, option.value)}
                      className={`w-full text-left px-3 py-2 text-sm transition ${
                        activeFilters[filter.key] === option.value
                          ? 'bg-primary-500/10 text-primary-500'
                          : 'text-gray-300 hover:bg-white/5'
                      }`}
                      role="option"
                      aria-selected={activeFilters[filter.key] === option.value}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Clear Filters Button */}
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="px-3 py-2 text-sm text-gray-400 hover:text-white transition"
              aria-label="Clear all filters"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
