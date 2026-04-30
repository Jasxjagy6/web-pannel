import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Network,
  Plus,
  Trash2,
  RefreshCcw,
  Globe,
  Shield,
  Activity,
  Search,
  Loader2,
  CheckCircle2,
  XCircle,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useToast } from '../components/common/Toast';
import { listProxies, addProxy, deleteProxy, refreshProxies } from '../api/proxies';
import { parseApiError, formatRelativeTime } from '../utils/formatters';

const PROTOCOLS = [
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'socks4', label: 'SOCKS4' },
  { value: 'mtproto', label: 'MTProto' },
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
];

export default function Proxies() {
  const { showSuccess, showError, showInfo } = useToast();
  const [proxies, setProxies] = useState([]);
  const [constants, setConstants] = useState({ FREE_PROXY_POOL_SIZE: 20, MAX_SESSIONS_PER_PROXY: 4 });
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | manual | free | working | dead

  // Add form
  const [form, setForm] = useState({
    host: '',
    port: '',
    protocol: 'socks5',
    username: '',
    password: '',
    secret: '',
    priority: '500',
  });
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listProxies();
      setProxies(res.data?.data?.proxies || []);
      setConstants(res.data?.data?.constants || constants);
    } catch (err) {
      showError(parseApiError(err), 'Proxies');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const handleAdd = async (e) => {
    e?.preventDefault?.();
    if (!form.host || !form.port) return showError('Host and port are required', 'Missing fields');
    setAdding(true);
    try {
      await addProxy({
        host: form.host.trim(),
        port: Number(form.port),
        protocol: form.protocol,
        username: form.username || undefined,
        password: form.password || undefined,
        secret: form.secret || undefined,
        priority: Number(form.priority) || 500,
      });
      showSuccess(`${form.host}:${form.port} added`, 'Proxy added');
      setForm((f) => ({ ...f, host: '', port: '', username: '', password: '', secret: '' }));
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Add proxy failed');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this proxy?')) return;
    try {
      await deleteProxy(id);
      showInfo('Proxy deleted', 'Proxies');
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Delete failed');
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await refreshProxies();
      const r = res.data?.data?.refreshed;
      const v = res.data?.data?.revalidated;
      showSuccess(
        `Scraped: +${r?.added || 0} new · Re-validated ${v?.checked || 0} (evicted ${v?.evicted || 0})`,
        'Proxy pool refresh'
      );
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const filtered = useMemo(() => {
    return proxies.filter((p) => {
      if (filter === 'manual' && p.source !== 'manual') return false;
      if (filter === 'free' && p.source !== 'free') return false;
      if (filter === 'working' && !p.is_working) return false;
      if (filter === 'dead' && p.is_working) return false;
      if (search) {
        const q = search.toLowerCase();
        const text = `${p.host}:${p.port} ${p.protocol} ${p.username || ''}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });
  }, [proxies, filter, search]);

  const stats = useMemo(() => {
    const direct = proxies.find((p) => p.host === '__direct__');
    const free = proxies.filter((p) => p.source === 'free');
    const manual = proxies.filter((p) => p.source === 'manual' && p.host !== '__direct__');
    const workingFree = free.filter((p) => p.is_working).length;
    const workingManual = manual.filter((p) => p.is_working).length;
    return { direct, free: free.length, manual: manual.length, workingFree, workingManual };
  }, [proxies]);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Network className="w-5 h-5 text-primary-500" />
            Proxy Pool
          </h2>
          <p className="text-sm text-gray-400">
            Manual paid proxies take priority over the auto-scraped free pool. New sessions are
            rotated across IPs with a hard cap of {constants.MAX_SESSIONS_PER_PROXY} accounts per IP.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-dark-800 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 disabled:opacity-50"
        >
          {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCcw className="w-3.5 h-3.5" />}
          Scrape & re-validate
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Wifi}
          label="VPS direct"
          value={stats.direct ? `${stats.direct.active_assignments}/${constants.MAX_SESSIONS_PER_PROXY}` : '—'}
          subtitle="Local egress IP"
          color="text-green-400"
        />
        <StatCard
          icon={Shield}
          label="Manual proxies"
          value={`${stats.workingManual}/${stats.manual}`}
          subtitle="Top priority"
          color="text-primary-400"
        />
        <StatCard
          icon={Globe}
          label="Free pool"
          value={`${stats.workingFree}/${constants.FREE_PROXY_POOL_SIZE}`}
          subtitle="Auto-scraped"
          color="text-yellow-400"
        />
        <StatCard
          icon={Activity}
          label="Total"
          value={proxies.length}
          subtitle="All entries"
          color="text-gray-300"
        />
      </div>

      {/* Add form */}
      <form onSubmit={handleAdd} className="rounded-xl border border-white/5 bg-dark-800 p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Plus className="w-4 h-4 text-primary-500" />
          <h3 className="text-sm font-semibold text-white">Add manual proxy</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
          <FieldInput label="Host" value={form.host} onChange={(v) => setForm({ ...form, host: v })} placeholder="proxy.example.com" />
          <FieldInput label="Port" value={form.port} onChange={(v) => setForm({ ...form, port: v })} placeholder="1080" type="number" />
          <FieldSelect label="Protocol" value={form.protocol} onChange={(v) => setForm({ ...form, protocol: v })} options={PROTOCOLS} />
          <FieldInput label="Username" value={form.username} onChange={(v) => setForm({ ...form, username: v })} placeholder="(optional)" />
          <FieldInput label="Password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} placeholder="(optional)" type="password" />
          <FieldInput label="Priority" value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} placeholder="500" type="number" />
        </div>
        {form.protocol === 'mtproto' && (
          <FieldInput label="MTProto secret" value={form.secret} onChange={(v) => setForm({ ...form, secret: v })} placeholder="hex secret" />
        )}
        <button
          type="submit"
          disabled={adding}
          className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-primary-600/20 hover:bg-primary-700 disabled:opacity-50"
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Add proxy
        </button>
      </form>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {[
          { id: 'all', label: 'All' },
          { id: 'manual', label: 'Manual' },
          { id: 'free', label: 'Free' },
          { id: 'working', label: 'Working' },
          { id: 'dead', label: 'Dead' },
        ].map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filter === f.id
                ? 'border-primary-500 bg-primary-600/15 text-white'
                : 'border-white/10 bg-dark-800 text-gray-300 hover:border-white/20'
            }`}
          >
            {f.label}
          </button>
        ))}
        <div className="relative ml-auto w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-dark-800 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-white/5 bg-dark-800 overflow-hidden">
        <div className="grid grid-cols-12 gap-3 px-4 py-2 text-[11px] uppercase tracking-wider text-gray-500 border-b border-white/5">
          <div className="col-span-3">Host</div>
          <div className="col-span-2">Protocol</div>
          <div className="col-span-1">Source</div>
          <div className="col-span-1">Status</div>
          <div className="col-span-1">Latency</div>
          <div className="col-span-2">Assignments</div>
          <div className="col-span-1">Checked</div>
          <div className="col-span-1 text-right">Actions</div>
        </div>
        {loading && proxies.length === 0 && (
          <div className="p-6 text-center text-sm text-gray-500">Loading…</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="p-6 text-center text-sm text-gray-500">No proxies match the current filter.</div>
        )}
        <div className="divide-y divide-white/5">
          {filtered.map((p) => {
            const isDirect = p.host === '__direct__' || (p.metadata && p.metadata.direct);
            return (
              <div key={p.id} className="grid grid-cols-12 gap-3 px-4 py-3 items-center text-sm">
                <div className="col-span-3 font-mono text-white truncate">
                  {isDirect ? <span className="text-green-400">VPS direct</span> : `${p.host}:${p.port}`}
                  {p.username && <span className="text-gray-500 ml-1">({p.username})</span>}
                </div>
                <div className="col-span-2 text-gray-300 uppercase">{p.protocol}</div>
                <div className="col-span-1">
                  <span className={`text-xs rounded-full px-2 py-0.5 border ${
                    p.source === 'manual' ? 'bg-primary-600/15 border-primary-500/30 text-primary-300'
                    : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300'
                  }`}>{p.source}</span>
                </div>
                <div className="col-span-1">
                  {p.is_working
                    ? <span className="inline-flex items-center gap-1 text-green-400"><CheckCircle2 className="w-3.5 h-3.5" /> up</span>
                    : <span className="inline-flex items-center gap-1 text-red-400"><XCircle className="w-3.5 h-3.5" /> down</span>}
                </div>
                <div className="col-span-1 text-gray-400">
                  {p.last_latency_ms ? `${p.last_latency_ms}ms` : '—'}
                </div>
                <div className="col-span-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <div
                        className={`h-full ${p.active_assignments >= constants.MAX_SESSIONS_PER_PROXY ? 'bg-red-500' : 'bg-primary-500'}`}
                        style={{ width: `${Math.min(100, (p.active_assignments / constants.MAX_SESSIONS_PER_PROXY) * 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-400 font-mono">
                      {p.active_assignments}/{constants.MAX_SESSIONS_PER_PROXY}
                    </span>
                  </div>
                </div>
                <div className="col-span-1 text-xs text-gray-500">
                  {p.last_checked_at ? formatRelativeTime(p.last_checked_at) : '—'}
                </div>
                <div className="col-span-1 text-right">
                  {!isDirect && (
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="text-gray-400 hover:text-red-400"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FieldInput({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
      />
    </div>
  );
}

function FieldSelect({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1.5">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, subtitle, color }) {
  return (
    <div className="rounded-xl border border-white/5 bg-dark-800 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-gray-500">{label}</span>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-[11px] text-gray-500 mt-0.5">{subtitle}</div>
    </div>
  );
}
