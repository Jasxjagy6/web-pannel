import { useState } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';

const STATUS_OPTIONS = [
  'available', 'reserved', 'sold', 'dead', 'banned', 'deleted', 'lost_access',
];

const inputClass = 'w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500';
const labelClass = 'block text-xs font-medium text-gray-400 mb-1';

/**
 * Search + filter bar for TrackingAccounts. `filters` mirrors the query
 * params trackingAccountController.parseFilters() accepts server-side.
 */
export default function FilterBar({ filters, onChange }) {
  const [expanded, setExpanded] = useState(false);

  const set = (key, value) => {
    const next = { ...filters };
    if (value === '' || value === undefined || value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  };

  const toggleStatus = (status) => {
    const current = filters.status || [];
    const next = current.includes(status) ? current.filter((s) => s !== status) : [...current, status];
    set('status', next.length ? next : undefined);
  };

  const activeCount = Object.keys(filters).filter((k) => k !== 'search').length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <input
            id="tracking-search-input"
            type="text"
            value={filters.search || ''}
            onChange={(e) => set('search', e.target.value)}
            placeholder="Search phone, username, ID, code... ( / to focus)"
            className={`${inputClass} pl-9`}
          />
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
            expanded || activeCount > 0
              ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
              : 'border-white/10 text-gray-300 hover:bg-white/5'
          }`}
        >
          <SlidersHorizontal className="h-4 w-4" />
          Filters {activeCount > 0 && `(${activeCount})`}
        </button>
        {activeCount > 0 && (
          <button
            onClick={() => onChange({})}
            className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            <X className="h-4 w-4" /> Clear
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => toggleStatus(s)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium border transition-colors capitalize ${
              (filters.status || []).includes(s)
                ? 'border-primary-500/50 bg-primary-500/15 text-primary-300'
                : 'border-white/10 text-gray-400 hover:bg-white/5'
            }`}
          >
            {s.replace('_', ' ')}
          </button>
        ))}
      </div>

      {expanded && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 rounded-xl border border-white/5 bg-dark-800/50 p-4">
          <div>
            <label className={labelClass}>Country</label>
            <input className={inputClass} value={filters.country || ''} onChange={(e) => set('country', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Premium</label>
            <select
              className={inputClass}
              value={filters.premium === undefined ? '' : String(filters.premium)}
              onChange={(e) => set('premium', e.target.value === '' ? undefined : e.target.value)}
            >
              <option value="">Any</option>
              <option value="true">Premium only</option>
              <option value="false">Non-premium only</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Buyer</label>
            <input className={inputClass} value={filters.buyer || ''} onChange={(e) => set('buyer', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Supplier</label>
            <input className={inputClass} value={filters.supplier || ''} onChange={(e) => set('supplier', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Sale price min</label>
            <input type="number" className={inputClass} value={filters.salePriceMin || ''} onChange={(e) => set('salePriceMin', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Sale price max</label>
            <input type="number" className={inputClass} value={filters.salePriceMax || ''} onChange={(e) => set('salePriceMax', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Purchase price min</label>
            <input type="number" className={inputClass} value={filters.purchasePriceMin || ''} onChange={(e) => set('purchasePriceMin', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Purchase price max</label>
            <input type="number" className={inputClass} value={filters.purchasePriceMax || ''} onChange={(e) => set('purchasePriceMax', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Created from</label>
            <input type="date" className={inputClass} value={filters.dateFrom || ''} onChange={(e) => set('dateFrom', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Created to</label>
            <input type="date" className={inputClass} value={filters.dateTo || ''} onChange={(e) => set('dateTo', e.target.value)} />
          </div>
        </div>
      )}
    </div>
  );
}
