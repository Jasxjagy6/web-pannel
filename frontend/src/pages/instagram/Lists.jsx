import { apiError } from '../../utils/apiError';
import { useEffect, useState } from 'react';
import {
  ListChecks,
  Plus,
  RefreshCw,
  Trash2,
  Download,
  Search,
  Users,
  Sparkles,
} from 'lucide-react';
import { listsAPI } from '@/api';
import { useToast } from '../../components/common/Toast';
import { formatNumber } from '@/utils/formatters';
import SessionListsTab from '../../components/common/SessionListsTab';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

export default function InstagramLists() {
  const { showToast } = useToast();
  const [lists, setLists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  async function reload() {
    setLoading(true);
    try {
      const r = await listsAPI.list({ page: 1, limit: 50 });
      const data = r.data?.data || r.data || {};
      setLists(data.lists || data || []);
    } catch (err) {
      showToast(apiError(err, 'Failed to load lists'), 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); }, []);

  async function doDelete(id) {
    if (!window.confirm('Delete this list and all its members?')) return;
    try {
      await listsAPI.delete(id);
      showToast('List deleted', 'info');
      await reload();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  async function doExport(id) {
    try {
      const r = await listsAPI.exportList(id, 'csv');
      const blob = r.data;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `instagram-list-${id}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  async function doDeduplicate(id) {
    try {
      await listsAPI.deduplicate(id);
      showToast('Deduplication queued', 'success');
      await reload();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  async function doCreate(evt) {
    evt?.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      // We use createFromScrape with no scrapeJobId to make an empty list
      // when the backend supports it; otherwise import a CSV. For now we
      // use addItems on a freshly merged empty list.
      const r = await listsAPI.merge({ name, lists: [], description: 'Created from Instagram panel' });
      showToast('List created', 'success');
      setNewName('');
      setCreating(false);
      await reload();
    } catch (err) {
      showToast(apiError(err, 'Failed to create list'), 'error');
    }
  }

  const filtered = lists.filter((l) =>
    !search.trim() || (l.name || '').toLowerCase().includes(search.toLowerCase())
  );

  const [tab, setTab] = useState('user');

  if (tab === 'session') {
    return (
      <div className="space-y-6">
        <div className={`rounded-2xl ${IG_GRADIENT} px-6 py-5 text-white shadow-lg`}>
          <div className="flex items-center gap-3">
            <ListChecks className="h-7 w-7" />
            <div>
              <div className="text-lg font-semibold">Lists</div>
              <div className="text-sm text-white/85">
                Switch between contact lists (saved audiences from scrapes) and session lists (named groupings of your Instagram sessions).
              </div>
            </div>
          </div>
        </div>
        <div className="border-b border-white/10 flex gap-1">
          <button
            onClick={() => setTab('user')}
            className="px-4 py-2 text-sm font-medium text-gray-400 hover:text-white border-b-2 border-transparent"
          >
            User lists
          </button>
          <button
            onClick={() => setTab('session')}
            className="px-4 py-2 text-sm font-medium text-white border-b-2 border-pink-500"
          >
            Session lists
          </button>
        </div>
        <SessionListsTab />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className={`rounded-2xl ${IG_GRADIENT} px-6 py-5 text-white shadow-lg`}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <ListChecks className="h-7 w-7" />
            <div>
              <div className="text-lg font-semibold">Saved lists</div>
              <div className="text-sm text-white/85">
                Curated audiences pulled from Instagram scrapes — ready to message or export.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={reload}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-sm font-medium text-white hover:bg-white/20"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <button
              onClick={() => setCreating((c) => !c)}
              className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-[#dc2743] shadow hover:bg-pink-50"
            >
              <Plus className="h-4 w-4" /> New list
            </button>
          </div>
        </div>
      </div>

      {creating && (
        <form
          onSubmit={doCreate}
          className="rounded-xl border border-pink-200 bg-white p-4 shadow-sm dark:border-pink-300/20 dark:bg-pink-950/40"
        >
          <div className="flex items-end gap-3 flex-wrap">
            <label className="flex-1 min-w-[260px]">
              <div className="mb-1 text-sm font-medium text-pink-900 dark:text-pink-100">
                List name
              </div>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. xjashan_ followers — May 2026"
                className="block w-full rounded-lg border border-pink-200 bg-white p-2.5 text-sm focus:border-pink-500 focus:outline-none focus:ring-2 focus:ring-pink-200 dark:border-pink-300/20 dark:bg-pink-950/30 dark:text-white"
              />
            </label>
            <button
              type="submit"
              className={`${IG_GRADIENT} inline-flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow`}
            >
              <Sparkles className="h-4 w-4" /> Create empty list
            </button>
            <button
              type="button"
              onClick={() => { setCreating(false); setNewName(''); }}
              className="rounded-lg border border-pink-200 bg-white px-3 py-2 text-sm font-medium text-pink-700 hover:bg-pink-50 dark:border-pink-300/20 dark:bg-pink-950/40 dark:text-pink-100"
            >
              Cancel
            </button>
          </div>
          <p className="mt-2 text-xs text-pink-700/70 dark:text-pink-200/70">
            Tip: most lists are created automatically with the <em>“Save to list”</em>
            option on the Scraping page.
          </p>
        </form>
      )}

      {/* Search bar */}
      <div className="rounded-xl border border-pink-200 bg-white p-3 shadow-sm dark:border-pink-300/20 dark:bg-pink-950/40">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-pink-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search saved lists…"
            className="w-full rounded-lg border border-pink-100 bg-white py-2 pl-9 pr-3 text-sm focus:border-pink-500 focus:outline-none focus:ring-2 focus:ring-pink-200 dark:border-pink-300/20 dark:bg-pink-950/30 dark:text-white"
          />
        </div>
      </div>

      {/* Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {loading && (
          <div className="col-span-full rounded-xl border border-pink-200 bg-white p-8 text-center text-pink-500 dark:border-pink-300/20 dark:bg-pink-950/40">
            Loading lists…
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="col-span-full rounded-xl border-2 border-dashed border-pink-300 bg-white p-10 text-center dark:bg-pink-950/40">
            <Users className="mx-auto h-10 w-10 text-pink-400" />
            <div className="mt-3 text-base font-semibold text-pink-900 dark:text-pink-100">
              No saved lists yet
            </div>
            <p className="mt-1 max-w-md mx-auto text-sm text-pink-600/80 dark:text-pink-200/70">
              Run a scraping job from the <strong>Scraping</strong> page and tick the
              <em> “Save to list”</em> option — your audience will land here.
            </p>
          </div>
        )}
        {!loading && filtered.map((l) => (
          <div
            key={l.id}
            className="group flex flex-col gap-3 rounded-xl border border-pink-200 bg-white p-4 shadow-sm transition hover:shadow-md dark:border-pink-300/20 dark:bg-pink-950/40"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-pink-900 dark:text-pink-100 truncate">
                  {l.name || `List #${l.id}`}
                </div>
                {l.description && (
                  <div className="mt-1 text-xs text-pink-700/70 dark:text-pink-200/70 line-clamp-2">
                    {l.description}
                  </div>
                )}
              </div>
              <div className={`flex h-8 w-8 items-center justify-center rounded-lg text-white ${IG_GRADIENT}`}>
                <ListChecks className="h-4 w-4" />
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded-full bg-pink-100 px-2 py-0.5 text-pink-700 font-medium">
                {formatNumber(l.itemCount || l.member_count || 0)} members
              </span>
              {l.createdAt && (
                <span className="text-pink-500/80">
                  {new Date(l.createdAt).toLocaleDateString()}
                </span>
              )}
            </div>
            <div className="mt-auto flex items-center gap-2 pt-2">
              <button
                onClick={() => doExport(l.id)}
                className="flex-1 inline-flex items-center justify-center gap-1 rounded-md border border-pink-200 bg-white px-3 py-1.5 text-xs font-medium text-pink-700 hover:bg-pink-50 dark:border-pink-300/20 dark:bg-pink-950/40 dark:text-pink-100"
              >
                <Download className="h-3.5 w-3.5" /> Export CSV
              </button>
              <button
                onClick={() => doDeduplicate(l.id)}
                className="inline-flex items-center justify-center gap-1 rounded-md border border-pink-200 bg-white px-3 py-1.5 text-xs font-medium text-pink-700 hover:bg-pink-50 dark:border-pink-300/20 dark:bg-pink-950/40 dark:text-pink-100"
                title="Deduplicate"
              >
                <Sparkles className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => doDelete(l.id)}
                className="inline-flex items-center justify-center gap-1 rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
