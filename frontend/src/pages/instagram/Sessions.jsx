import { apiError } from '../../utils/apiError';
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
  Upload,
  Activity,
  Shield,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import {
  listSessions,
  loginSession,
  logoutSession,
  deleteSession,
  bulkDeleteSessions,
  runSessionHealthCheck,
  setSessionProxy,
} from '@/api/sessions';
import { useToast } from '../../components/common/Toast';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

function StatusPill({ status, isLoggedIn, warmupState }) {
  // Anti-detect health takes priority over the legacy login pill —
  // a session can be is_logged_in=true and still be `needs_attention`
  // (e.g. mid-checkpoint) in which case the operator should NOT trust
  // it for scrapes.
  const health = warmupState && warmupState.state;
  if (health === 'needs_attention') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">
        <ShieldAlert className="h-3 w-3" /> Needs attention
      </span>
    );
  }
  if (health === 'dead') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
        <AlertCircle className="h-3 w-3" /> Dead
      </span>
    );
  }
  if (health === 'warming') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">
        <Activity className="h-3 w-3 animate-pulse" /> Probing
      </span>
    );
  }
  if (isLoggedIn && health === 'active') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
        <ShieldCheck className="h-3 w-3" /> Healthy
      </span>
    );
  }
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

function ProxyPill({ proxyUrl }) {
  if (!proxyUrl) {
    return (
      <span
        title="No proxy bound — IG will likely flag the session from this IP"
        className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500"
      >
        <Shield className="h-3 w-3" /> No proxy
      </span>
    );
  }
  // Mask the auth segment so we don't leak credentials in the row.
  let host;
  try {
    const u = new URL(proxyUrl);
    host = u.host;
  } catch (_e) {
    host = proxyUrl.replace(/^.*?:\/\//, '').replace(/^[^@]+@/, '');
  }
  return (
    <span
      title={proxyUrl}
      className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
    >
      <Shield className="h-3 w-3" /> {host}
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
  // { sessionId, currentUrl } when the proxy modal is open
  const [proxyModal, setProxyModal] = useState(null);
  const [proxyDraft, setProxyDraft] = useState('');

  async function reload() {
    setLoading(true);
    try {
      const r = await listSessions({ page: 1, limit: 100 });
      const data = r.data?.data || r.data || {};
      setSessions(data.sessions || []);
    } catch (err) {
      showToast(
        apiError(err, 'Failed to load Instagram sessions'),
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
      showToast(apiError(err), 'error');
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
      showToast(apiError(err), 'error');
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
      showToast(apiError(err), 'error');
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
      showToast(apiError(err), 'error');
    }
  }

  async function doHealthCheck(id) {
    setBusyId(id);
    try {
      const r = await runSessionHealthCheck(id);
      const data = r.data?.data || r.data || {};
      const ok = !!data.result?.ok;
      const kind = data.result?.kind;
      const username = data.result?.username;
      if (ok) {
        showToast(
          `Session healthy${username ? ` — IG sees you as @${username}` : ''}`,
          'success'
        );
      } else {
        showToast(
          `Health probe failed (${kind || 'error'}). Check the row for details.`,
          'warning'
        );
      }
      await reload();
    } catch (err) {
      showToast(apiError(err, 'Health probe failed'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  function openProxyModal(s) {
    setProxyModal({ id: s.id, username: s.username });
    setProxyDraft(s.proxy_url || '');
  }

  async function saveProxy() {
    if (!proxyModal) return;
    const url = (proxyDraft || '').trim();
    setBusyId(proxyModal.id);
    try {
      await setSessionProxy(proxyModal.id, url);
      showToast(
        url ? 'Proxy bound to session' : 'Proxy cleared',
        'success'
      );
      setProxyModal(null);
      setProxyDraft('');
      await reload();
    } catch (err) {
      showToast(apiError(err, 'Failed to set proxy'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div
        className={[
          'flex flex-col gap-4 rounded-xl px-4 py-4 text-white shadow-lg sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-5',
          IG_GRADIENT,
        ].join(' ')}
      >
        <div className="flex items-center gap-3 min-w-0">
          <Instagram className="h-7 w-7 shrink-0" />
          <div className="min-w-0">
            <div className="text-base sm:text-lg font-semibold truncate">Instagram accounts</div>
            <div className="text-xs sm:text-sm text-white/85 truncate">
              {loading ? 'Loading sessions…' : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={reload}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-xs sm:text-sm font-medium text-white transition hover:bg-white/20"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            <span className="hidden xs:inline">Refresh</span>
            <span className="xs:hidden">Refresh</span>
          </button>
          <Link
            to="/instagram/upload-session"
            className="inline-flex items-center gap-1 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-xs sm:text-sm font-medium text-white transition hover:bg-white/20"
          >
            <Upload className="h-4 w-4" />
            <span className="hidden sm:inline">Upload session</span>
            <span className="sm:hidden">Upload</span>
          </Link>
          <Link
            to="/instagram/create-session"
            className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-2 text-xs sm:text-sm font-semibold text-[#dc2743] shadow transition hover:bg-pink-50"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Create session</span>
            <span className="sm:hidden">Create</span>
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

      {/*
        Mobile (< md): card-based layout — every row gets its own
        card so the action buttons stack instead of overflowing the
        viewport. Desktop (md+): the existing 6-column table.
      */}
      <div className="md:hidden space-y-3">
        {loading && (
          <div className="rounded-xl border border-pink-100 bg-white px-4 py-6 text-center text-sm text-gray-400 dark:border-pink-900/30 dark:bg-dark-800">
            Loading…
          </div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="rounded-xl border border-pink-100 bg-white px-4 py-8 text-center dark:border-pink-900/30 dark:bg-dark-800">
            <div className="text-base font-semibold text-gray-700 dark:text-gray-200">
              No Instagram sessions yet
            </div>
            <div className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              Tap <strong>Create</strong> to log in your first Instagram account.
            </div>
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={() => navigate('/instagram/create-session')}
                className={`inline-flex items-center justify-center gap-1 rounded-lg ${IG_GRADIENT} px-4 py-2 text-sm font-semibold text-white shadow`}
              >
                <Plus className="h-4 w-4" /> Create session
              </button>
              <button
                onClick={() => navigate('/instagram/upload-session')}
                className="inline-flex items-center justify-center gap-1 rounded-lg border border-pink-200 bg-white px-4 py-2 text-sm font-semibold text-[#dc2743] shadow-sm hover:bg-pink-50 dark:border-pink-900/30 dark:bg-dark-700 dark:text-pink-300 dark:hover:bg-dark-600"
              >
                <Upload className="h-4 w-4" /> Upload session
              </button>
            </div>
          </div>
        )}
        {sessions.map((s) => (
          <div
            key={`m-${s.id}`}
            className="rounded-xl border border-pink-100 bg-white p-4 shadow-sm dark:border-pink-900/30 dark:bg-dark-800"
          >
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={() => toggleSelect(s.id)}
                className="mt-1.5 shrink-0"
              />
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white ${IG_GRADIENT}`}>
                <Instagram className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-gray-900 dark:text-white truncate">
                  @{s.username || '—'}
                </div>
                <div className="text-[11px] text-gray-400">id #{s.id}</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <StatusPill
                    status={s.status}
                    isLoggedIn={s.is_logged_in}
                    warmupState={s.warmup_state}
                  />
                  <ProxyPill proxyUrl={s.proxy_url} />
                </div>
                {s.warmup_state?.last_error && (
                  <div
                    className="mt-1 text-[11px] text-amber-700 dark:text-amber-400 break-words"
                    title={s.warmup_state.last_error}
                  >
                    {s.warmup_state.last_error}
                  </div>
                )}
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
              <dt className="font-medium uppercase tracking-wide text-gray-400">
                Last login
              </dt>
              <dt className="font-medium uppercase tracking-wide text-gray-400">
                Last warm-up
              </dt>
              <dd className="truncate">
                {s.last_login ? new Date(s.last_login).toLocaleString() : '—'}
              </dd>
              <dd className="truncate">
                {s.last_warmup_at ? new Date(s.last_warmup_at).toLocaleString() : '—'}
              </dd>
            </dl>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => doHealthCheck(s.id)}
                disabled={busyId === s.id}
                title="Run health probe"
                className="inline-flex items-center gap-1 rounded-md border border-blue-200 px-2.5 py-1.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-900/30"
              >
                <Activity className="h-3.5 w-3.5" /> Health
              </button>
              <button
                onClick={() => openProxyModal(s)}
                disabled={busyId === s.id}
                title="Bind / clear residential proxy"
                className="inline-flex items-center gap-1 rounded-md border border-emerald-200 px-2.5 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-900/30"
              >
                <Shield className="h-3.5 w-3.5" /> Proxy
              </button>
              {s.is_logged_in ? (
                <button
                  onClick={() => doLogout(s.id)}
                  disabled={busyId === s.id}
                  title="Logout"
                  className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-dark-600 dark:text-gray-300"
                >
                  <LogOut className="h-3.5 w-3.5" /> Logout
                </button>
              ) : (
                <button
                  onClick={() => doLogin(s.id)}
                  disabled={busyId === s.id}
                  title="Re-attach"
                  className="inline-flex items-center gap-1 rounded-md border border-pink-200 bg-pink-50 px-2.5 py-1.5 text-xs text-pink-600 hover:bg-pink-100 disabled:opacity-50 dark:border-pink-900/30 dark:bg-pink-900/10"
                >
                  <LogIn className="h-3.5 w-3.5" /> Login
                </button>
              )}
              <button
                onClick={() => doDelete(s.id)}
                disabled={busyId === s.id}
                title="Delete"
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-red-200 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-50 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden md:block overflow-x-auto rounded-xl border border-pink-100 bg-white shadow-sm dark:border-pink-900/30 dark:bg-dark-800">
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
              <th className="px-4 py-3">Health</th>
              <th className="px-4 py-3">Last login</th>
              <th className="px-4 py-3">Last warm-up</th>
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
                    <div className="mt-4 flex items-center justify-center gap-2">
                      <button
                        onClick={() => navigate('/instagram/create-session')}
                        className={`inline-flex items-center gap-1 rounded-lg ${IG_GRADIENT} px-4 py-2 text-sm font-semibold text-white shadow`}
                      >
                        <Plus className="h-4 w-4" /> Create session
                      </button>
                      <button
                        onClick={() => navigate('/instagram/upload-session')}
                        className="inline-flex items-center gap-1 rounded-lg border border-pink-200 bg-white px-4 py-2 text-sm font-semibold text-[#dc2743] shadow-sm hover:bg-pink-50 dark:border-pink-900/30 dark:bg-dark-700 dark:text-pink-300 dark:hover:bg-dark-600"
                      >
                        <Upload className="h-4 w-4" /> Upload session
                      </button>
                    </div>
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
                <td className="px-4 py-3">
                  <div className="flex flex-col items-start gap-1">
                    <StatusPill
                      status={s.status}
                      isLoggedIn={s.is_logged_in}
                      warmupState={s.warmup_state}
                    />
                    <ProxyPill proxyUrl={s.proxy_url} />
                    {s.warmup_state?.last_error && (
                      <div
                        className="max-w-[260px] truncate text-[10px] text-amber-700 dark:text-amber-400"
                        title={s.warmup_state.last_error}
                      >
                        {s.warmup_state.last_error}
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                  {s.last_login ? new Date(s.last_login).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                  {s.last_warmup_at
                    ? new Date(s.last_warmup_at).toLocaleString()
                    : '—'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => doHealthCheck(s.id)}
                      disabled={busyId === s.id}
                      title="Run health probe via bound proxy"
                      className="rounded-md border border-blue-200 p-1.5 text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-900/30"
                    >
                      <Activity className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => openProxyModal(s)}
                      disabled={busyId === s.id}
                      title="Bind / clear residential proxy"
                      className="rounded-md border border-emerald-200 p-1.5 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-900/30"
                    >
                      <Shield className="h-4 w-4" />
                    </button>
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

      {proxyModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setProxyModal(null)}
        >
          <div
            className="w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl dark:bg-dark-800"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center gap-2">
              <Shield className="h-5 w-5 text-emerald-600" />
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Bind proxy to @{proxyModal.username || `session #${proxyModal.id}`}
              </h2>
            </div>
            <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">
              Instagram aggressively flags requests from data-centre IPs.
              Bind a sticky residential or mobile proxy to this session
              so every API call (warm-up + scrape) exits through a
              consistent IP that matches the account's home country.
            </p>
            <label className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Proxy URL
            </label>
            <input
              type="text"
              value={proxyDraft}
              onChange={(e) => setProxyDraft(e.target.value)}
              placeholder="http://user:pass@gate.smartproxy.com:7000"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm shadow-sm focus:border-pink-500 focus:outline-none focus:ring-1 focus:ring-pink-500 dark:border-dark-600 dark:bg-dark-700 dark:text-white"
            />
            <p className="mt-2 text-xs text-gray-500">
              Accepts <code>http://</code>, <code>https://</code>,{' '}
              <code>socks5://</code>. Leave empty to clear the binding.
              Authentication credentials are stored encrypted at rest
              and masked in the UI.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={() => setProxyModal(null)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-dark-600 dark:text-gray-200 dark:hover:bg-dark-700"
              >
                Cancel
              </button>
              <button
                onClick={saveProxy}
                disabled={busyId === proxyModal.id}
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-700 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
