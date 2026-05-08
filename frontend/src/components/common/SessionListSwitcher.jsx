import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Layers,
  Users,
  Search,
  Check,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ListChecks,
} from 'lucide-react';
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
 *
 * UI redesign (May 2026):
 *   - Replaced the native `<select>` (which surfaced the browser's
 *     default Chrome listbox) with a custom row-by-row picker.
 *   - Each session list renders as a tappable card row with name,
 *     description, and member count — chosen by clicking the row.
 *   - Selecting a list lazily fetches and previews the actual member
 *     sessions ("phone · username · status") so the operator can see
 *     what they're about to send to.
 *   - Fully theme-aware (pure-black dark + clean white light) via the
 *     existing `bg-dark-*` / `text-white` overrides — no special
 *     palette code lives here.
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
  const [search, setSearch] = useState('');

  // Preview cache: listId -> { loading, error, sessions[] }
  const [memberCache, setMemberCache] = useState({});
  // Whether the inline preview panel is open for the current selection.
  const [previewOpen, setPreviewOpen] = useState(true);

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

  useEffect(() => { fetchLists(); }, [fetchLists]);

  const fetchMembers = useCallback(async (listId) => {
    if (!listId) return;
    setMemberCache((prev) => ({
      ...prev,
      [listId]: { ...(prev[listId] || {}), loading: true, error: null },
    }));
    try {
      const r = await sessionListsAPI.getSessions(listId);
      const sessions = r.data?.data?.sessions || [];
      setMemberCache((prev) => ({
        ...prev,
        [listId]: { loading: false, error: null, sessions },
      }));
    } catch (err) {
      setMemberCache((prev) => ({
        ...prev,
        [listId]: {
          loading: false,
          error: err?.response?.data?.error?.message || err.message || 'Failed to load sessions',
          sessions: [],
        },
      }));
    }
  }, []);

  // Lazy-load members for the currently selected list once.
  useEffect(() => {
    if (mode !== 'list') return;
    if (!selectedSessionListId) return;
    const id = Number(selectedSessionListId);
    if (memberCache[id]) return;
    fetchMembers(id);
  }, [mode, selectedSessionListId, memberCache, fetchMembers]);

  const filteredLists = useMemo(() => {
    if (!search) return lists;
    const q = search.toLowerCase();
    return lists.filter(
      (l) =>
        l.name?.toLowerCase().includes(q) ||
        (l.description || '').toLowerCase().includes(q)
    );
  }, [lists, search]);

  const selectedList = useMemo(
    () => lists.find((l) => Number(l.id) === Number(selectedSessionListId)) || null,
    [lists, selectedSessionListId]
  );
  const selectedMembers = selectedSessionListId
    ? memberCache[Number(selectedSessionListId)]
    : null;

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Mode switch (Pick sessions / Use session list) */}
      <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-dark-900 p-1">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onModeChange && onModeChange('sessions')}
          className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
            mode === 'sessions'
              ? 'bg-primary-500/15 text-primary-300 ring-1 ring-primary-500/40'
              : 'text-gray-400 hover:text-white hover:bg-white/5'
          }`}
          aria-pressed={mode === 'sessions'}
        >
          <Users className="w-3.5 h-3.5" />
          Pick sessions
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onModeChange && onModeChange('list')}
          className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
            mode === 'list'
              ? 'bg-primary-500/15 text-primary-300 ring-1 ring-primary-500/40'
              : 'text-gray-400 hover:text-white hover:bg-white/5'
          }`}
          aria-pressed={mode === 'list'}
        >
          <Layers className="w-3.5 h-3.5" />
          Use session list
        </button>
      </div>

      {mode === 'list' && (
        <div className="rounded-xl border border-white/10 bg-dark-900 overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search session lists..."
                disabled={disabled || loading}
                className="w-full rounded-lg border border-white/10 bg-dark-900 py-1.5 pl-8 pr-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500/40 transition"
              />
            </div>
            <button
              type="button"
              onClick={fetchLists}
              disabled={loading}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-white/5 transition disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Lists */}
          <div className="max-h-64 overflow-y-auto">
            {loading && lists.length === 0 ? (
              <div className="py-8 text-center">
                <Loader2 className="mx-auto h-5 w-5 animate-spin text-gray-500" />
                <p className="mt-2 text-xs text-gray-500">Loading session lists...</p>
              </div>
            ) : error ? (
              <div className="py-6 text-center">
                <AlertCircle className="mx-auto h-5 w-5 text-red-400" />
                <p className="mt-2 text-xs text-red-400">{error}</p>
              </div>
            ) : filteredLists.length === 0 ? (
              <div className="py-8 text-center">
                <ListChecks className="mx-auto h-6 w-6 text-gray-600" />
                <p className="mt-2 text-sm font-medium text-white">
                  {search ? 'No matching lists' : 'No session lists yet'}
                </p>
                {!search && (
                  <p className="mt-1 text-xs text-gray-500">
                    Create one in <span className="font-medium">Lists → Session Lists</span>.
                  </p>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-white/5">
                {filteredLists.map((list) => {
                  const isSelected = Number(list.id) === Number(selectedSessionListId);
                  const initials = (list.name || 'L').slice(0, 2).toUpperCase();
                  return (
                    <li key={list.id}>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          if (onSelectedSessionListIdChange) {
                            onSelectedSessionListIdChange(Number(list.id));
                          }
                          setPreviewOpen(true);
                        }}
                        className={`w-full text-left flex items-center gap-3 px-3 py-2.5 transition ${
                          isSelected
                            ? 'bg-primary-500/10'
                            : 'hover:bg-white/5'
                        }`}
                      >
                        <div
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${
                            isSelected
                              ? 'brand-gradient text-white'
                              : 'bg-white/5 text-gray-300'
                          }`}
                        >
                          {initials}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p
                            className={`text-sm font-medium truncate ${
                              isSelected ? 'text-primary-300' : 'text-white'
                            }`}
                          >
                            {list.name}
                          </p>
                          {list.description ? (
                            <p className="text-xs text-gray-500 truncate">{list.description}</p>
                          ) : (
                            <p className="text-xs text-gray-500">
                              {list.session_count} session{list.session_count === 1 ? '' : 's'}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {list.description && (
                            <span className="text-xs text-gray-500 hidden sm:inline">
                              {list.session_count} session{list.session_count === 1 ? '' : 's'}
                            </span>
                          )}
                          {isSelected ? (
                            <CheckCircle2 className="w-5 h-5 text-primary-400" />
                          ) : (
                            <span className="w-5 h-5 rounded-full border border-white/15" />
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Preview drawer for the currently-chosen list */}
          {selectedList && (
            <div className="border-t border-white/5">
              <button
                type="button"
                onClick={() => setPreviewOpen((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs text-gray-400 hover:text-white hover:bg-white/5 transition"
              >
                <span className="flex items-center gap-1.5">
                  <ListChecks className="w-3.5 h-3.5" />
                  {previewOpen ? 'Hide' : 'Show'} sessions in&nbsp;
                  <span className="font-medium text-white">{selectedList.name}</span>
                  <span className="text-gray-500">
                    · {selectedMembers?.sessions?.length ?? selectedList.session_count}
                  </span>
                </span>
                {previewOpen ? (
                  <ChevronUp className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </button>
              {previewOpen && (
                <SessionPreview
                  list={selectedList}
                  members={selectedMembers}
                  onRetry={() => fetchMembers(Number(selectedList.id))}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionPreview({ list, members, onRetry }) {
  if (!members || members.loading) {
    return (
      <div className="px-3 py-4 text-center">
        <Loader2 className="mx-auto h-4 w-4 animate-spin text-gray-500" />
        <p className="mt-1 text-xs text-gray-500">Loading sessions in “{list.name}”...</p>
      </div>
    );
  }
  if (members.error) {
    return (
      <div className="px-3 py-4 text-center">
        <AlertCircle className="mx-auto h-4 w-4 text-red-400" />
        <p className="mt-1 text-xs text-red-400">{members.error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-xs text-primary-400 hover:text-primary-300"
        >
          Try again
        </button>
      </div>
    );
  }
  const sessions = members.sessions || [];
  if (sessions.length === 0) {
    return (
      <div className="px-3 py-4 text-center">
        <p className="text-xs text-amber-400">
          “{list.name}” has no member sessions yet — add some in&nbsp;
          <span className="font-medium">Lists → Session Lists</span>.
        </p>
      </div>
    );
  }
  return (
    <ul className="max-h-48 overflow-y-auto divide-y divide-white/5 bg-dark-800">
      {sessions.map((s) => {
        const status = (s.status || '').toLowerCase();
        const isActive = status === 'active' || s.is_logged_in;
        const label = s.phone || s.username || `#${s.id}`;
        return (
          <li
            key={s.id}
            className="flex items-center gap-2.5 px-3 py-2 text-sm"
          >
            <span
              className={`w-1.5 h-6 rounded-full shrink-0 ${
                isActive ? 'bg-green-500' : 'bg-gray-600'
              }`}
              aria-hidden
            />
            <Check className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-green-400' : 'text-gray-500'}`} />
            <span className="text-white truncate">{label}</span>
            {s.username && s.phone ? (
              <span className="text-xs text-gray-500 truncate">@{s.username}</span>
            ) : null}
            <span
              className={`ml-auto text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full ${
                isActive
                  ? 'bg-green-500/10 text-green-400'
                  : 'bg-gray-500/15 text-gray-400'
              }`}
            >
              {status || 'unknown'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
