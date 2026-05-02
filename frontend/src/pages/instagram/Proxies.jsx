import { apiError } from '../../utils/apiError';
import { useEffect, useState } from 'react';
import { Network, Plus, Trash2, RefreshCw, Globe } from 'lucide-react';
import { listProxies, addProxy, deleteProxy, refreshProxies } from '@/api/proxies';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';
import { useToast } from '../../components/common/Toast';

export default function InstagramProxies() {
  const { showToast } = useToast();
  const [proxies, setProxies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ url: '', label: '' });

  async function reload() {
    setLoading(true);
    try {
      const r = await listProxies();
      setProxies(r.data?.data?.proxies || r.data?.proxies || r.data || []);
    } catch (err) {
      showToast(apiError(err), 'error');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  async function doAdd(e) {
    e.preventDefault();
    if (!form.url.trim()) return;
    try {
      await addProxy({ url: form.url.trim(), label: form.label.trim() || undefined });
      showToast('Proxy added', 'success');
      setForm({ url: '', label: '' });
      await reload();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  async function doDelete(id) {
    if (!window.confirm('Delete this proxy? Sessions using it will fall back to direct connection.')) return;
    try {
      await deleteProxy(id);
      await reload();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  return (
    <InstagramFeatureShell
      icon={Network}
      title="Proxies"
      subtitle="Stable IPs your Instagram accounts will route through. Recommended for institutional workflows."
      actions={(
        <>
          <button
            onClick={reload}
            className="inline-flex items-center gap-1 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/20"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button
            onClick={async () => {
              try { await refreshProxies(); await reload(); }
              catch (err) { showToast(apiError(err), 'error'); }
            }}
            className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-[#dc2743] shadow hover:bg-pink-50"
          >
            Re-check
          </button>
        </>
      )}
    >
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
                <th className="px-4 py-2">URL</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {proxies.map((p) => (
                <tr key={p.id} className="border-t border-pink-100 dark:border-pink-300/20">
                  <td className="px-4 py-2 font-medium text-pink-900 dark:text-pink-100">{p.label || '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-pink-700 dark:text-pink-200">{p.url}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      p.status === 'healthy' || p.healthy ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                    }`}>
                      {p.status || (p.healthy ? 'healthy' : 'unknown')}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => doDelete(p.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-3 w-3" /> Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </InstagramFeatureShell>
  );
}
