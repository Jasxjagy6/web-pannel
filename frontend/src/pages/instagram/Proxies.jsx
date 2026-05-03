import { apiError } from '../../utils/apiError';
import { useEffect, useState } from 'react';
import { Network, Plus, Trash2, RefreshCw, Globe, PlayCircle } from 'lucide-react';
// BYO Proxy (Phase 3): IG panel uses the shared /api/me/proxies surface
// so users only see their own proxies (never the admin pool).
import {
  listMyProxies,
  addMyProxy,
  deleteMyProxy,
  testMyProxy,
} from '@/api/userProxies';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';
import { useToast } from '../../components/common/Toast';

// Parse "http://user:pass@host:port" into the BYO payload shape.
function parseProxyUrl(input) {
  try {
    const u = new URL(input);
    let proto = (u.protocol || 'socks5:').replace(':', '').toLowerCase();
    if (!['socks5', 'socks4', 'http', 'https', 'mtproto'].includes(proto)) proto = 'socks5';
    return {
      host: u.hostname,
      port: Number(u.port) || (proto === 'http' ? 80 : proto === 'https' ? 443 : 1080),
      protocol: proto,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch (_e) {
    return null;
  }
}

export default function InstagramProxies() {
  const { showToast } = useToast();
  const [proxies, setProxies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ url: '', label: '' });
  const [trialBlocked, setTrialBlocked] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const r = await listMyProxies();
      setProxies(r.data?.data?.proxies || []);
      setTrialBlocked(false);
    } catch (err) {
      const code = err?.response?.data?.error?.code || err?.response?.data?.code;
      if (code === 'TRIAL_FEATURE_NOT_ALLOWED') {
        setTrialBlocked(true);
        setProxies([]);
      } else {
        showToast(apiError(err), 'error');
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  async function doAdd(e) {
    e.preventDefault();
    if (!form.url.trim()) return;
    const parsed = parseProxyUrl(form.url.trim());
    if (!parsed) {
      showToast('Use http://user:pass@host:port or socks5://host:port', 'error');
      return;
    }
    try {
      await addMyProxy({ ...parsed, label: form.label.trim() || undefined });
      showToast('Proxy added', 'success');
      setForm({ url: '', label: '' });
      await reload();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  async function doDelete(id) {
    if (!window.confirm('Delete this proxy? Sessions using it will lose their pinned egress.')) return;
    try {
      await deleteMyProxy(id);
      await reload();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  async function doTest(id) {
    try {
      await testMyProxy(id);
      await reload();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  return (
    <InstagramFeatureShell
      icon={Network}
      title="Proxies"
      subtitle="Stable IPs your Instagram accounts will route through. Each account is pinned to one of your proxies for life."
      actions={(
        <button
          onClick={reload}
          className="inline-flex items-center gap-1 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/20"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      )}
    >
      {trialBlocked ? (
        <div className="rounded-lg border-2 border-dashed border-pink-300 bg-pink-50 p-8 text-center dark:bg-pink-900/20">
          <Globe className="mx-auto h-8 w-8 text-pink-400" />
          <p className="mt-2 text-sm text-pink-700 dark:text-pink-200">
            Bring-your-own proxy is a paid feature.
          </p>
          <a href="/billing" className="mt-3 inline-block rounded-lg bg-pink-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-pink-500">
            Upgrade plan
          </a>
        </div>
      ) : (
        <>
          <form onSubmit={doAdd} className="grid gap-3 sm:grid-cols-[1fr,200px,auto] mb-4">
            <input
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              placeholder="http://user:pass@host:port"
              className="rounded-lg border border-pink-200 bg-white p-2.5 text-sm focus:border-pink-500 focus:outline-none focus:ring-2 focus:ring-pink-200 dark:border-pink-300/20 dark:bg-pink-950/30 dark:text-white"
            />
            <input
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="Label (optional)"
              className="rounded-lg border border-pink-200 bg-white p-2.5 text-sm focus:border-pink-500 focus:outline-none focus:ring-2 focus:ring-pink-200 dark:border-pink-300/20 dark:bg-pink-950/30 dark:text-white"
            />
            <button
              type="submit"
              className="bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] inline-flex items-center justify-center gap-1 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow"
            >
              <Plus className="h-4 w-4" /> Add proxy
            </button>
          </form>

          {loading && <div className="text-sm text-pink-500">Loading proxies…</div>}
          {!loading && proxies.length === 0 && (
            <div className="rounded-lg border-2 border-dashed border-pink-300 bg-pink-50 p-8 text-center dark:bg-pink-900/20">
              <Globe className="mx-auto h-8 w-8 text-pink-400" />
              <p className="mt-2 text-sm text-pink-700 dark:text-pink-200">
                No proxies configured yet — add one above.
              </p>
            </div>
          )}
          {!loading && proxies.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-pink-200 dark:border-pink-300/20">
              <table className="min-w-full text-sm">
                <thead className="bg-pink-50 text-left text-xs uppercase tracking-wide text-pink-700 dark:bg-pink-900/20 dark:text-pink-200">
                  <tr>
                    <th className="px-4 py-2">Label</th>
                    <th className="px-4 py-2">Proxy</th>
                    <th className="px-4 py-2">Egress</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {proxies.map((p) => (
                    <tr key={p.id} className="border-t border-pink-100 dark:border-pink-300/20">
                      <td className="px-4 py-2">{p.label || '—'}</td>
                      <td className="px-4 py-2">{p.protocol?.toUpperCase()} · {p.host}:{p.port}</td>
                      <td className="px-4 py-2 font-mono text-xs">{p.metadata?.egress_ip || '—'}</td>
                      <td className="px-4 py-2">
                        <span className={p.is_working ? 'text-green-600' : 'text-red-600'}>
                          {p.is_working ? 'Working' : 'Dead'}
                        </span>
                        {p.validated_for_instagram && (
                          <span className="ml-1 text-[10px] text-green-600">· IG✓</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="inline-flex gap-2">
                          <button onClick={() => doTest(p.id)} className="text-pink-500 hover:text-pink-700" title="Test">
                            <PlayCircle className="h-4 w-4" />
                          </button>
                          <button onClick={() => doDelete(p.id)} className="text-pink-500 hover:text-pink-700" title="Delete">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </InstagramFeatureShell>
  );
}
