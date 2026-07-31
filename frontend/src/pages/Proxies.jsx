import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Network,
  Plus,
  Trash2,
  Globe,
  Shield,
  Activity,
  Search,
  Loader2,
  CheckCircle2,
  XCircle,
  Wifi,
  Edit3,
  PlayCircle,
  FileArchive,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { useToast } from '../components/common/Toast';
import {
  listMyProxies,
  addMyProxy,
  updateMyProxy,
  testMyProxy,
  deleteMyProxy,
  importMyProxies,
  recheckMyProxies,
} from '../api/userProxies';
import { parseApiError, formatRelativeTime } from '../utils/formatters';

const PROTOCOLS = [
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'mtproto', label: 'MTProto' },
];

// Tiny country flag — emoji from ISO-3166 alpha-2 (e.g. 'us' → 🇺🇸).
function countryFlag(code) {
  if (!code || typeof code !== 'string' || code.length < 2) return '🌐';
  const cc = code.slice(0, 2).toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) return '🌐';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 97));
}

export default function Proxies() {
  const { showSuccess, showError, showInfo } = useToast();
  const [proxies, setProxies] = useState([]);
  const [constants, setConstants] = useState({ MAX_SESSIONS_PER_PROXY: 1 });
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | working | dead | tg | ig
  const [testingId, setTestingId] = useState(null);
  const [editing, setEditing] = useState(null); // { id, label, notes }
  const [form, setForm] = useState({
    host: '',
    port: '',
    protocol: 'socks5',
    username: '',
    password: '',
    label: '',
    country_code: '',
    notes: '',
    secret: '',
  });
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const importRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listMyProxies();
      setProxies(res.data?.data?.proxies || []);
       setConstants({ ...(res.data?.data?.constants || {}), MAX_SESSIONS_PER_PROXY: 1 });
    } catch (err) {
      // 402 from the entitlement gate is handled here so the empty
      // state can show the upgrade copy. Anything else surfaces as a
      // toast.
      const code = err?.response?.data?.error?.code || err?.response?.data?.code;
      if (code === 'TRIAL_FEATURE_NOT_ALLOWED') {
        setProxies([]);
        setConstants({ trialUpsell: true, MAX_SESSIONS_PER_PROXY: 1 });
      } else {
        showError(parseApiError(err), 'My proxies');
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  const handleAdd = async (e) => {
    e?.preventDefault?.();
    if (!form.host || !form.port) return showError('Host and port are required', 'Missing fields');
    setAdding(true);
    try {
      await addMyProxy({
        host: form.host.trim(),
        port: Number(form.port),
        protocol: form.protocol,
        username: form.username || undefined,
        password: form.password || undefined,
        label: form.label || undefined,
        country_code: form.country_code || undefined,
        notes: form.notes || undefined,
        secret: form.secret || undefined,
      });
      showSuccess(`${form.host}:${form.port} added`, 'Proxy added');
      setForm({ host: '', port: '', protocol: 'socks5', username: '', password: '', label: '', country_code: '', notes: '', secret: '' });
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Add proxy failed');
    } finally {
      setAdding(false);
    }
  };

  const handleImport = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const body = new FormData();
    body.append('file', file);
    body.append('protocol', 'socks5');
    setImporting(true);
    try {
      const res = await importMyProxies(body);
      const result = res.data?.data || {};
      showSuccess(
        `${result.added || 0} added, ${result.working || 0} working, ${result.duplicates || 0} duplicate, ${result.failed || 0} failed.`,
        'Proxy import complete'
      );
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Proxy import failed');
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = '';
    }
  };

  const handleRecheckAll = async () => {
    setRechecking(true);
    try {
      const res = await recheckMyProxies();
      showSuccess(`${res.data?.data?.checked || 0} proxies checked.`, 'Health refresh complete');
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Health refresh failed');
    } finally {
      setRechecking(false);
    }
  };

  const handleToggle = async (proxy) => {
    try {
      await updateMyProxy(proxy.id, { enabled: proxy.enabled === false });
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Proxy update failed');
    }
  };

  const handleTest = async (id) => {
    setTestingId(id);
    try {
      const res = await testMyProxy(id);
      const p = res.data?.data?.proxy;
      if (p?.is_working) {
        showSuccess(`Working · ${p?.metadata?.egress_ip || 'reachable'}`, 'Proxy test');
      } else {
        showError(p?.health_message || 'Probe failed', 'Proxy test');
      }
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Test failed');
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this proxy? Sessions bound to it will lose their pinned egress.')) return;
    try {
      await deleteMyProxy(id);
      showInfo('Proxy deleted', 'My proxies');
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Delete failed');
    }
  };

  const startEdit = (p) => {
    setEditing({ id: p.id, label: p.label || '', notes: p.notes || '', country_code: p.country_code || '' });
  };
  const saveEdit = async () => {
    if (!editing) return;
    try {
      await updateMyProxy(editing.id, {
        label: editing.label,
        notes: editing.notes,
        country_code: editing.country_code,
      });
      setEditing(null);
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Update failed');
    }
  };

  const filtered = useMemo(() => {
    return proxies.filter((p) => {
      if (filter === 'working' && !p.is_working) return false;
      if (filter === 'dead' && p.is_working) return false;
      if (filter === 'tg' && !p.validated_for_telegram) return false;
      if (filter === 'ig' && !p.validated_for_instagram) return false;
      if (search) {
        const q = search.toLowerCase();
        const text = `${p.host}:${p.port} ${p.protocol} ${p.label || ''} ${p.country_code || ''}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });
  }, [proxies, filter, search]);

  const stats = useMemo(() => {
    const total = proxies.length;
    const working = proxies.filter((p) => p.is_working).length;
    const tg = proxies.filter((p) => p.validated_for_telegram).length;
    const ig = proxies.filter((p) => p.validated_for_instagram).length;
    return { total, working, tg, ig };
  }, [proxies]);

  if (constants.trialUpsell) {
    return (
      <div className="rounded-xl border border-white/5 bg-dark-800 p-8 text-center space-y-4">
        <Network className="w-10 h-10 text-primary-500 mx-auto" />
        <div>
          <h2 className="text-xl font-semibold text-white">Bring-your-own proxies</h2>
          <p className="text-sm text-gray-400 mt-2 max-w-prose mx-auto">
            Each Telegram & Instagram account on this panel must egress through a
            proxy you own. The free trial doesn&apos;t include this feature — pick a
            paid plan to add and pin your own SOCKS5 or MTProto proxies.
          </p>
        </div>
        <a
          href="/billing"
          className="inline-flex items-center gap-2 rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-400"
        >
          Upgrade plan
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Network className="w-5 h-5 text-primary-500" />
            Dedicated Proxy Fleet
          </h2>
          <p className="text-sm text-gray-400">
            One working proxy per new Telegram session. The panel tests every
            route continuously and strict sessions never fall back to the VPS IP.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Wifi} label="Inventory" value={stats.total} subtitle="Private to your account" color="text-gray-300" />
        <StatCard icon={Shield} label="Working" value={stats.working} subtitle="Healthy now" color="text-green-400" />
        <StatCard icon={Activity} label="Telegram-validated" value={stats.tg} subtitle="DC4 reachable" color="text-primary-400" />
        <StatCard icon={Globe} label="Available" value={proxies.filter((p) => p.is_working && p.validated_for_telegram && !(p.assigned_sessions?.length)).length} subtitle="Ready for new sessions" color="text-yellow-400" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
        <div className="rounded-xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/10 to-dark-800 p-5">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-cyan-500/15 p-2 text-cyan-300"><Shield className="h-5 w-5" /></div>
            <div>
              <h3 className="font-semibold text-white">Strict routing policy</h3>
              <p className="mt-1 text-sm text-gray-300">Sessions uploaded after this rollout require a healthy dedicated proxy. Login, messaging, scraping, groups, OTP listeners, background jobs, and AI Chat all share that same proxied Telegram client.</p>
              <p className="mt-2 text-xs text-cyan-200/70">Existing panel sessions are grandfathered and are not automatically rebound.</p>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
          <div className="flex items-center gap-2"><FileArchive className="h-4 w-4 text-primary-400" /><h3 className="text-sm font-semibold text-white">Bulk import</h3></div>
          <p className="mt-2 text-xs text-gray-400">Upload TXT, CSV, JSON, or ZIP. Supported lines: <code>host:port:user:pass</code>, <code>user:pass@host:port</code>, or <code>socks5://user:pass@host:port</code>.</p>
          <div className="mt-4 flex gap-2">
            <input ref={importRef} type="file" accept=".txt,.csv,.json,.zip" onChange={handleImport} className="hidden" />
            <button onClick={() => importRef.current?.click()} disabled={importing} className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-xs font-semibold text-white hover:bg-primary-500 disabled:opacity-50">
              {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileArchive className="h-3.5 w-3.5" />} Import file
            </button>
            <button onClick={handleRecheckAll} disabled={rechecking} className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-dark-700 px-3 py-2 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-50">
              <RefreshCw className={`h-3.5 w-3.5 ${rechecking ? 'animate-spin' : ''}`} /> Check all
            </button>
          </div>
        </div>
      </div>

      {/* Add form */}
      <form onSubmit={handleAdd} className="rounded-xl border border-white/5 bg-dark-800 p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Plus className="w-4 h-4 text-primary-500" />
          <h3 className="text-sm font-semibold text-white">Add one dedicated proxy</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
          <FieldInput label="Label"   value={form.label}        onChange={(v) => setForm({ ...form, label: v })} placeholder="e.g. London residential" />
          <FieldInput label="Host"    value={form.host}         onChange={(v) => setForm({ ...form, host: v })}  placeholder="proxy.example.com" />
          <FieldInput label="Port"    value={form.port}         onChange={(v) => setForm({ ...form, port: v })}  placeholder="1080" type="number" />
          <FieldSelect label="Protocol" value={form.protocol}   onChange={(v) => setForm({ ...form, protocol: v })} options={PROTOCOLS} />
          <FieldInput label="Country" value={form.country_code} onChange={(v) => setForm({ ...form, country_code: v })} placeholder="us" />
          <FieldInput label="Username" value={form.username}    onChange={(v) => setForm({ ...form, username: v })} placeholder="(optional)" />
          <FieldInput label="Password" value={form.password}    onChange={(v) => setForm({ ...form, password: v })} placeholder="(optional)" type="password" />
          {form.protocol === 'mtproto' && (
            <FieldInput label="MTProto secret" value={form.secret} onChange={(v) => setForm({ ...form, secret: v })} placeholder="dd...secret" />
          )}
          <FieldInput label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} placeholder="(optional)" />
        </div>
        <div className="flex items-center justify-end">
          <button
            type="submit"
            disabled={adding || !form.host || !form.port}
            className="flex items-center gap-2 rounded-lg bg-primary-500 px-4 py-2 text-xs font-medium text-white hover:bg-primary-400 disabled:opacity-50"
          >
            {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Add proxy
          </button>
        </div>
      </form>

      <div className="flex items-center gap-3">
        <div className="flex items-center flex-1 rounded-lg border border-white/10 bg-dark-800 px-3">
          <Search className="w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by host, label or country"
            className="flex-1 bg-transparent px-2 py-2 text-sm text-white placeholder-gray-500 outline-none"
          />
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-lg border border-white/10 bg-dark-800 px-3 py-2 text-sm text-white outline-none"
        >
          <option value="all">All</option>
          <option value="working">Working</option>
          <option value="dead">Not working</option>
          <option value="tg">Telegram-validated</option>
          <option value="ig">Instagram-validated</option>
        </select>
      </div>

      <div className="rounded-xl border border-white/5 bg-dark-800 overflow-hidden">
        {loading && proxies.length === 0 ? (
          <div className="p-10 text-center text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin mx-auto" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="text-sm text-gray-300">
              {proxies.length === 0
                ? 'You have not added any proxies yet.'
                : 'No proxies match your filters.'}
            </p>
            {proxies.length === 0 && (
              <p className="text-xs text-gray-500">
                Add a SOCKS5 or MTProto proxy above. Each Telegram
                Instagram account you create from now on must use one of your
                proxies for egress.
              </p>
            )}
          </div>
        ) : (
          <>
            {/* Desktop table — visible on md+ where there's enough
                horizontal space for six columns. */}
            <table className="hidden md:table w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-gray-500 border-b border-white/5">
                  <th className="px-4 py-3 text-left">Proxy</th>
                  <th className="px-4 py-3 text-left">Egress</th>
                  <th className="px-4 py-3 text-left">Validated</th>
                  <th className="px-4 py-3 text-left">Sessions</th>
                  <th className="px-4 py-3 text-left">Last check</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id} className="border-b border-white/5 last:border-b-0 hover:bg-white/2">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-lg leading-none">{countryFlag(p.country_code)}</span>
                        <div>
                          <div className="font-medium text-white">{p.label || `${p.host}:${p.port}`}</div>
                          <div className="text-xs text-gray-500">
                            {p.protocol.toUpperCase()} · {p.host}:{p.port}
                            {p.username ? ` · ${p.username}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {p.metadata?.egress_ip ? (
                        <span className="text-xs text-gray-200 font-mono">{p.metadata.egress_ip}</span>
                      ) : (
                        <span className="text-xs text-gray-500">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        <Chip ok={p.validated_for_telegram} label="TG" />
                        <Chip ok={p.validated_for_instagram} label="IG" />
                        <Chip ok={p.is_working}            label="L4" />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-300">
                       {p.assigned_sessions?.length ? (p.assigned_sessions[0].phone || `Session #${p.assigned_sessions[0].sessionId}`) : 'Available'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">
                      {p.last_health_check ? formatRelativeTime(p.last_health_check) : '—'}
                      {p.health_message && (
                        <div className="text-[10px] text-gray-500 truncate max-w-[160px]" title={p.health_message}>
                          {p.health_message}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleToggle(p)}
                          className={`rounded-md border px-2 py-1 text-xs ${p.enabled === false ? 'border-gray-500/30 bg-gray-500/10 text-gray-400' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'}`}
                          title={p.enabled === false ? 'Enable proxy' : 'Disable proxy'}
                        >
                          {p.enabled === false ? <ToggleLeft className="w-3 h-3" /> : <ToggleRight className="w-3 h-3" />}
                        </button>
                        <button
                          onClick={() => handleTest(p.id)}
                          disabled={testingId === p.id}
                          className="rounded-md border border-white/10 bg-dark-700 px-2 py-1 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-50"
                          title="Re-run health probe"
                        >
                          {testingId === p.id
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <PlayCircle className="w-3 h-3" />}
                        </button>
                        <button
                          onClick={() => startEdit(p)}
                          className="rounded-md border border-white/10 bg-dark-700 px-2 py-1 text-xs text-gray-200 hover:bg-white/10"
                          title="Edit label / notes"
                        >
                          <Edit3 className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => handleDelete(p.id)}
                          className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-300 hover:bg-red-500/20"
                          title="Delete proxy"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile card layout — same data as the desktop table but
                stacked so the Remove button stays inside the viewport
                on a phone (the previous layout overflowed horizontally
                and the trash icon was unreachable). */}
            <ul className="md:hidden divide-y divide-white/5">
              {filtered.map((p) => (
                <li key={p.id} className="p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl leading-none mt-0.5">{countryFlag(p.country_code)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-white truncate">
                        {p.label || `${p.host}:${p.port}`}
                      </div>
                      <div className="text-xs text-gray-500 truncate">
                        {p.protocol.toUpperCase()} · {p.host}:{p.port}
                        {p.username ? ` · ${p.username}` : ''}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-gray-500">Egress IP</div>
                      <div className="mt-0.5 text-gray-200 font-mono truncate">
                        {p.metadata?.egress_ip || '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-gray-500">Sessions</div>
                      <div className="mt-0.5 text-gray-300">
                        {p.assigned_sessions?.length ? (p.assigned_sessions[0].phone || `Session #${p.assigned_sessions[0].sessionId}`) : 'Available'}
                      </div>
                    </div>
                    <div className="col-span-2">
                      <div className="text-[10px] uppercase tracking-wide text-gray-500">Validated</div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        <Chip ok={p.validated_for_telegram} label="TG" />
                        <Chip ok={p.validated_for_instagram} label="IG" />
                        <Chip ok={p.is_working}            label="L4" />
                      </div>
                    </div>
                    <div className="col-span-2">
                      <div className="text-[10px] uppercase tracking-wide text-gray-500">Last check</div>
                      <div className="mt-0.5 text-gray-400">
                        {p.last_health_check ? formatRelativeTime(p.last_health_check) : '—'}
                      </div>
                      {p.health_message && (
                        <div className="text-[10px] text-gray-500 break-words" title={p.health_message}>
                          {p.health_message}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => handleTest(p.id)}
                      disabled={testingId === p.id}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-white/10 bg-dark-700 px-3 py-2 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-50"
                    >
                      {testingId === p.id
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <PlayCircle className="w-3.5 h-3.5" />}
                      Test
                    </button>
                    <button
                      onClick={() => startEdit(p)}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-white/10 bg-dark-700 px-3 py-2 text-xs text-gray-200 hover:bg-white/10"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-500/20"
                      aria-label="Remove proxy"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="dialog">
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-dark-800 p-5 space-y-3">
            <h3 className="text-sm font-semibold text-white">Edit proxy</h3>
            <FieldInput label="Label"   value={editing.label}        onChange={(v) => setEditing({ ...editing, label: v })} />
            <FieldInput label="Country" value={editing.country_code} onChange={(v) => setEditing({ ...editing, country_code: v })} />
            <FieldInput label="Notes"   value={editing.notes}        onChange={(v) => setEditing({ ...editing, notes: v })} />
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditing(null)} className="rounded-lg border border-white/10 bg-dark-700 px-3 py-2 text-xs text-gray-200">Cancel</button>
              <button onClick={saveEdit} className="rounded-lg bg-primary-500 px-3 py-2 text-xs font-medium text-white hover:bg-primary-400">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, subtitle, color }) {
  return (
    <div className="rounded-xl border border-white/5 bg-dark-800 p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500">
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <span>{label}</span>
      </div>
      <div className={`mt-1 text-xl font-semibold ${color}`}>{value}</div>
      {subtitle && <div className="text-xs text-gray-500">{subtitle}</div>}
    </div>
  );
}

function Chip({ ok, label }) {
  if (ok) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-300">
        <CheckCircle2 className="w-2.5 h-2.5" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
      <XCircle className="w-2.5 h-2.5" />
      {label}
    </span>
  );
}

function FieldInput({ label, value, onChange, placeholder, type = 'text' }) {
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

function FieldSelect({ label, value, onChange, options }) {
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
