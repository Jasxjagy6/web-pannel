import { useEffect, useState, useCallback } from 'react';
import { Layers, Users, ChevronDown } from 'lucide-react';
import { sessionListsAPI } from '../../api';

/**
 * SessionListSwitcher — drop-in component that adds a "Pick by Session List"
 * toggle to any bulk-action page that today builds a `sessionIds` array.
 *
 * The parent owns three pieces of state:
 *   - mode: 'sessions' | 'list'
 *   - selectedSessionListId: number | ''
 *   - render its own existing session multi-select only when mode === 'sessions'
 *
 * On submit, the parent decides which payload key to send:
 *   if (mode === 'list' && selectedSessionListId) -> { sessionListId }
 *   else                                          -> { sessionIds }
 */
export default function SessionListSwitcher({
  mode,
  onModeChange,
  selectedSessionListId,
  onSelectedSessionListIdChange,
  className = '',
  disabled = false,
}) {
  const [lists, setLists] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchLists = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await sessionListsAPI.list();
      setLists(r.data.data?.lists || []);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Failed to load session lists');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLists();
  }, [fetchLists]);

  const selectedList = lists.find((l) => Number(l.id) === Number(selectedSessionListId)) || null;

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onModeChange && onModeChange('sessions')}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
            mode === 'sessions'
              ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
              : 'border-white/10 bg-dark-900 text-gray-400 hover:border-white/20'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          Pick sessions
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onModeChange && onModeChange('list')}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
            mode === 'list'
              ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
              : 'border-white/10 bg-dark-900 text-gray-400 hover:border-white/20'
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          Use session list
        </button>
      </div>

      {mode === 'list' && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-300 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-gray-500" />
            Session list
          </label>
          <div className="relative">
            <select
              value={selectedSessionListId || ''}
              onChange={(e) =>
                onSelectedSessionListIdChange &&
                onSelectedSessionListIdChange(e.target.value ? Number(e.target.value) : '')
              }
              disabled={disabled || loading}
              className="w-full appearance-none rounded-lg border border-white/10 bg-dark-900 py-2.5 px-3 pr-9 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition disabled:opacity-50"
            >
              <option value="">{loading ? 'Loading session lists...' : 'Select a session list...'}</option>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name} &middot; {list.session_count} session(s)
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          </div>
          {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
          {!loading && !error && lists.length === 0 && (
            <p className="mt-1 text-xs text-amber-400">
              No session lists yet. Create one in <span className="font-medium">Lists &rarr; Session Lists</span>.
            </p>
          )}
          {selectedList && (
            <p className="mt-1 text-xs text-gray-500">
              Will use {selectedList.session_count} session(s) from &quot;{selectedList.name}&quot;.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
