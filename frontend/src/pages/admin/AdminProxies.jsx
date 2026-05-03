import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Network, Plus, Trash2, RefreshCcw, Loader2, Wifi, Activity, Users,
} from 'lucide-react';
import { useToast } from '../../components/common/Toast';
import {
  adminListProxies,
  adminAddProxy,
  adminDeleteProxy,
  adminRefreshProxies,
  adminProxyUsage,
} from '../../api/admin';
import { parseApiError, formatRelativeTime } from '../../utils/formatters';

const PROTOCOLS = [
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'socks4', label: 'SOCKS4' },
  { value: 'mtproto', label: 'MTProto' },
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
];

export default function AdminProxies() {
  const { showSuccess, showError, showInfo } = useToast();
  const [proxies, setProxies] = useState([]);
  const [usage, setUsage] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    host: '', port: '', protocol: 'socks5',
    username: '', password: '', secret: '', priority: '500',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, b] = await Promise.all([adminListProxies(), adminProxyUsage()]);
      setProxies(a.data?.data?.proxies || []);
      setUsage(b.data?.data?.rows || []);
    } catch (err) {
      showError(parseApiError(err), 'Admin proxies');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (e) => {
    e?.preventDefault?.();
    if (!form.host || !form.port) return showError('Host and port are required', 'Missing fields');
    setAdding(true);
    try {
      await adminAddProxy({
        host: form.host.trim(),
        port: Number(form.port),
        protocol: form.protocol,
        username: form.username || undefined,
        password: form.password || undefined,
        secret: form.secret || undefined,
        priority: Number(form.priority) || 500,
      });
      showSuccess(`${form.host}:${form.port} added`, 'Admin pool');
      setForm((f) => ({ ...f, host: '', port: '', username: '', password: '', secret: '' }));
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Add failed');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this admin-pool proxy?')) return;
    try {
      await adminDeleteProxy(id);
      showInfo('Deleted', 'Admin pool');
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Delete failed');
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await adminRefreshProxies();
      const r = res.data?.data?.refreshed;
      const v = res.data?.data?.revalidated;
      showSuccess(
        `Scraped: +${r?.added || 0} new · Re-validated ${v?.checked || 0} (evicted ${v?.evicted || 0})`,
        'Free pool refresh'
      );
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  // Cross-user usage matrix: each proxy → list of (sessionId, userId).
  const usageByProxy = useMemo(() => {
    const map = new Map();
    for (const r of usage) {
      if (!r.session_id) continue;
      const list = map.get(r.proxy_id) || [];
      list.push(r);
      map.set(r.proxy_id, list);
    }
    return map;
  }, [usage]);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Network className="w-5 h-5 text-primary-500" />
            Admin proxy pool
          </h2>
          <p className="text-sm text-gray-400">
            The shared free + manual pool (rows where <code>user_id IS NULL</code>).
            Regular users go through <a href="/proxies" className="text-primary-400 hover:underline">My Proxies</a>;
            this surface is admin-only.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-dark-800 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 disabled:opacity-50"
        >
          {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCcw className="w-3.5 h-3.5" />}
          Scrape free pool & re-validate
        </button>
      </div>

      <form onSubmit={handleAdd} className="rounded-xl border border-white/5 bg-dark-800 p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Plus className="w-4 h-4 text-primary-500" />
          <h3 className="text-sm font-semibold text-white">Add admin-pool proxy</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
          <Field label="Host"     value={form.host}     onChange={(v) => setForm({ ...form, host: v })} placeholder="proxy.example.com" />
          <Field label="Port"     value={form.port}     onChange={(v) => setForm({ ...form, port: v })} type="number" />
          <Select label="Protocol" value={form.protocol} onChange={(v) => setForm({ ...form, protocol: v })} options={PROTOCOLS} />
          <Field label="Username" value={form.username} onChange={(v) => setForm({ ...form, username: v })} />
          <Field label="Password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} type="password" />
          <Field label="Priority" value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} type="number" />
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={adding}
            className="rounded-lg bg-primary-500 px-4 py-2 text-xs font-medium text-white hover:bg-primary-400 disabled:opacity-50"
          >
            {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin inline mr-2" /> : null}
            Add
          </button>
        </div>
      </form>

      <div className="rounded-xl border border-white/5 bg-dark-800 overflow-hidden">
        {loading && proxies.length === 0 ? (
          <div className="p-10 text-center text-gray-400"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
        ) : proxies.length === 0 ? (
          <div className="p-10 text-center text-sm text-gray-400">No admin-pool proxies yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-gray-500 border-b border-white/5">
                <th className="px-4 py-3 text-left">Proxy</th>
                <th className="px-4 py-3 text-left">Source</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Sessions / users</th>
                <th className="px-4 py-3 text-left">Last check</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {proxies.map((p) => {
                const rows = usageByProxy.get(p.id) || [];
                const userCount = new Set(rows.map((r) => r.session_user_id)).size;
                return (
                  <tr key={p.id} className="border-b border-white/5 last:border-b-0 hover:bg-white/2">
                    <td className="px-4 py-3">
                      <div className="font-medium text-white">{p.host}:{p.port}</div>
                      <div className="text-xs text-gray-500">{p.protocol.toUpperCase()}{p.username ? ` · ${p.username}` : ''}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-300">{p.source}</td>
                    <td className="px-4 py-3 text-xs">
                      {p.is_working ? (
                        <span className="text-green-400">working</span>
                      ) : (
                        <span className="text-red-400">dead</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-300">
                      <span className="inline-flex items-center gap-1">
                        <Activity className="w-3 h-3" /> {rows.length}
                        <span className="text-gray-500">·</span>
                        <Users className="w-3 h-3" /> {userCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">
                      {p.last_health_check ? formatRelativeTime(p.last_health_check) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleDelete(p.id)}
                        className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-300 hover:bg-red-500/20"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-xl border border-white/5 bg-dark-800 overflow-hidden">
        <div className="px-5 py-3 border-b border-white/5 flex items-center gap-2">
          <Wifi className="w-4 h-4 text-primary-500" />
          <h3 className="text-sm font-semibold text-white">Cross-user usage matrix</h3>
        </div>
        {usage.length === 0 ? (
          <div className="p-6 text-sm text-gray-400">No proxy assignments yet.</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-gray-500 border-b border-white/5">
                <th className="px-4 py-2 text-left">Proxy</th>
                <th className="px-4 py-2 text-left">Owner user_id</th>
                <th className="px-4 py-2 text-left">Session</th>
                <th className="px-4 py-2 text-left">Session user_id</th>
                <th className="px-4 py-2 text-left">Platform</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((r, i) => (
                <tr key={`${r.proxy_id}-${r.session_id || 'none'}-${i}`} className="border-b border-white/5 last:border-b-0">
                  <td className="px-4 py-2 text-white">{r.host}:{r.port}</td>
                  <td className="px-4 py-2 text-gray-300">{r.user_id || <span className="text-gray-500">admin pool</span>}</td>
                  <td className="px-4 py-2 text-gray-300">{r.session_id ? `#${r.session_id} ${r.session_username || ''}` : '—'}</td>
                  <td className="px-4 py-2 text-gray-300">{r.session_user_id || '—'}</td>
                  <td className="px-4 py-2 text-gray-300">{r.platform || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-white/10 bg-dark-900 px-2 py-2 text-xs text-white placeholder-gray-500 outline-none focus:border-primary-500"
      />
    </label>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-white/10 bg-dark-900 px-2 py-2 text-xs text-white outline-none focus:border-primary-500"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
