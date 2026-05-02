import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Instagram,
  Plus,
  RefreshCw,
  LogIn,
  LogOut,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Power,
} from 'lucide-react';
import {
  listSessions,
  loginSession,
  logoutSession,
  deleteSession,
  bulkDeleteSessions,
} from '@/api/sessions';
import { useToast } from '../../components/common/Toast';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

function StatusPill({ status, isLoggedIn }) {
  if (isLoggedIn) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
        <CheckCircle2 className="h-3 w-3" /> Active
      </span>
    );
  }
  if (status === 'expired') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">
        <AlertCircle className="h-3 w-3" /> Expired
      </span>
    );
  }
  if (status === 'banned') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
        <AlertCircle className="h-3 w-3" /> Banned
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">
      <Power className="h-3 w-3" /> Inactive
    </span>
  );
}

export default function InstagramSessions() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [selected, setSelected] = useState(new Set());

  async function reload() {
    setLoading(true);
    try {
      const r = await listSessions({ page: 1, limit: 100 });
      const data = r.data?.data || r.data || {};
      setSessions(data.sessions || []);
    } catch (err) {
      showToast(
        err?.response?.data?.error || err.message || 'Failed to load Instagram sessions',
        'error'
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); }, []);

  function toggleSelect(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  async function doLogin(id) {
    setBusyId(id);
    try {
      await loginSession(id);
      showToast('Session re-attached', 'success');
      await reload();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function doLogout(id) {
    setBusyId(id);
    try {
      await logoutSession(id);
      showToast('Logged out', 'info');
      await reload();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function doDelete(id) {
    if (!window.confirm('Delete this Instagram session? This will revoke its cookies and remove it from the panel.')) return;
    setBusyId(id);
    try {
      await deleteSession(id);
      showToast('Session deleted', 'info');
      await reload();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function doBulkDelete() {
    if (!selected.size) return;
    if (!window.confirm(`Delete ${selected.size} session(s)?`)) return;
    try {
      await bulkDeleteSessions([...selected]);
      setSelected(new Set());
      showToast('Sessions deleted', 'info');
      await reload();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message, 'error');
    }
  }

  return (
    <div className="space-y-6">
      <div className={`flex items-center justify-between rounded-xl ${IG_GRADIENT} px-6 py-5 text-white shadow-lg`}>
        <div className="flex items-center gap-3">
          <Instagram className="h-7 w-7" />
          <div>
            <div className="text-lg font-semibold">Instagram accounts</div>
            <div className="text-sm text-white/85">
              {loading ? 'Loading sessions…' : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={reload}
            disabled={loading}
            className="flex items-center gap-1 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-sm font-medium text-white transition hover:bg-white/20"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <Link
            to="/instagram/create-session"
            className="flex items-center gap-1 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-[#dc2743] shadow transition hover:bg-pink-50"
          >
            <Plus className="h-4 w-4" /> Create session
          </Link>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-pink-200 bg-pink-50 px-4 py-2 dark:border-pink-900/30 dark:bg-pink-900/10">
          <div className="text-sm text-pink-800 dark:text-pink-200">
            {selected.size} session(s) selected
          </div>
          <button
            onClick={doBulkDelete}
            className="flex items-center gap-1 rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
          >
            <Trash2 className="h-4 w-4" /> Delete selected
          </button>
        </div>
      )}

      <div className="rounded-xl border border-pink-100 bg-white shadow-sm dark:border-pink-900/30 dark:bg-dark-800">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-pink-100 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-pink-900/30 dark:text-gray-400">
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={selected.size > 0 && selected.size === sessions.length}
                  onChange={(e) => {
                    if (e.target.checked) setSelected(new Set(sessions.map((s) => s.id)));
                    else setSelected(new Set());
                  }}
                />
              </th>
              <th className="px-4 py-3">Username</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Last login</th>
              <th className="px-4 py-3">Last used</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
            )}
            {!loading && sessions.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center">
                  <div className="mx-auto max-w-md">
                    <div className="text-base font-semibold text-gray-700 dark:text-gray-200">
                      No Instagram sessions yet
                    </div>
                    <div className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                      Click <strong>Create session</strong> to log in your first Instagram account.
                    </div>
                    <button
                      onClick={() => navigate('/instagram/create-session')}
                      className={`mt-4 inline-flex items-center gap-1 rounded-lg ${IG_GRADIENT} px-4 py-2 text-sm font-semibold text-white shadow`}
                    >
                      <Plus className="h-4 w-4" /> Create session
                    </button>
                  </div>
                </td>
              </tr>
            )}
            {sessions.map((s) => (
              <tr key={s.id} className="border-b border-pink-50 last:border-0 hover:bg-pink-50/40 dark:border-pink-900/30 dark:hover:bg-pink-900/5">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={() => toggleSelect(s.id)}
                  />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-full text-white ${IG_GRADIENT}`}>
                      <Instagram className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="font-semibold text-gray-900 dark:text-white">@{s.username || '—'}</div>
                      <div className="text-xs text-gray-400">id #{s.id}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3"><StatusPill status={s.status} isLoggedIn={s.is_logged_in} /></td>
                <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                  {s.last_login ? new Date(s.last_login).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                  {s.last_used ? new Date(s.last_used).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {s.is_logged_in ? (
                      <button
                        onClick={() => doLogout(s.id)}
                        disabled={busyId === s.id}
                        title="Logout"
                        className="rounded-md border border-gray-200 p-1.5 text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-dark-600 dark:text-gray-300"
                      >
                        <LogOut className="h-4 w-4" />
                      </button>
                    ) : (
                      <button
                        onClick={() => doLogin(s.id)}
                        disabled={busyId === s.id}
                        title="Re-attach"
                        className="rounded-md border border-pink-200 bg-pink-50 p-1.5 text-pink-600 hover:bg-pink-100 disabled:opacity-50 dark:border-pink-900/30 dark:bg-pink-900/10"
                      >
                        <LogIn className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={() => doDelete(s.id)}
                      disabled={busyId === s.id}
                      title="Delete"
                      className="rounded-md border border-red-200 p-1.5 text-red-500 hover:bg-red-50 disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
