import { useEffect, useState } from 'react';
import { Flame, Plus, Trash2, RefreshCw, ShieldOff, ShieldCheck, AlertTriangle } from 'lucide-react';
import {
  listBurners,
  addBurner,
  deleteBurner,
  blockBurner,
  getBurnerPoolStats,
} from '@/api/burners';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';
import { useToast } from '../../components/common/Toast';
import { apiError } from '../../utils/apiError';

/**
 * Instagram Burner-Cookie Pool (PR #4 §6.3).
 *
 * Lets the operator ingest IG burner-cookie blobs that the
 * email/phone enumeration probes draw from. NEVER displays the raw
 * cookie values — only label, ds_user_id, probe-count, risk-score,
 * blocked state.
 */
export default function InstagramBurners() {
  const { showToast } = useToast();
  const [burners, setBurners] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [includeBlocked, setIncludeBlocked] = useState(false);
  const [form, setForm] = useState({
    label: '',
    sessionid: '',
    ds_user_id: '',
    csrftoken: '',
    mid: '',
    rawBlob: '',
    useRawBlob: false,
  });

  async function reload() {
    setLoading(true);
    try {
      const [b, s] = await Promise.all([
        listBurners({ includeBlocked }),
        getBurnerPoolStats(),
      ]);
      setBurners(b.data?.data?.burners || []);
      setStats(s.data?.data?.stats || null);
    } catch (err) {
      showToast(apiError(err), 'error');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [includeBlocked]);

  async function doAdd(e) {
    e.preventDefault();
    let cookieBlob;
    if (form.useRawBlob) {
      try {
        cookieBlob = JSON.parse(form.rawBlob);
      } catch (_e) {
        showToast('Invalid JSON cookie blob', 'error');
        return;
      }
    } else {
      if (!form.sessionid || !form.ds_user_id || !form.csrftoken) {
        showToast('sessionid, ds_user_id, csrftoken are required', 'error');
        return;
      }
      cookieBlob = {
        sessionid: form.sessionid.trim(),
        ds_user_id: form.ds_user_id.trim(),
        csrftoken: form.csrftoken.trim(),
        mid: form.mid.trim() || undefined,
      };
    }
    try {
      await addBurner({
        cookieBlob,
        label: form.label.trim() || undefined,
      });
      showToast('Burner added to pool', 'success');
      setForm({
        label: '',
        sessionid: '',
        ds_user_id: '',
        csrftoken: '',
        mid: '',
        rawBlob: '',
        useRawBlob: false,
      });
      await reload();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  async function doDelete(id) {
    if (!window.confirm('Permanently delete this burner row? Cookie blob is encrypted but this cannot be undone.')) return;
    try {
      await deleteBurner(id);
      await reload();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  async function doBlock(id) {
    if (!window.confirm('Mark this burner as blocked? It will be skipped by future probes.')) return;
    try {
      await blockBurner(id, 'manual');
      await reload();
    } catch (err) {
      showToast(apiError(err), 'error');
    }
  }

  return (
    <InstagramFeatureShell
      icon={Flame}
      title="Burner Pool"
      subtitle="Sacrificial IG cookies used by the email/phone enumeration probes (§2.2 stage 3+4). Cookies are encrypted at rest and never re-displayed."
      actions={(
        <button
          onClick={reload}
          className="inline-flex items-center gap-1 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/20"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      )}
    >
      {/* Stats strip */}
      {stats && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Alive" value={stats.alive ?? 0} hint="non-blocked burners" />
          <Stat label="Blocked" value={stats.blocked ?? 0} hint="checkpoint/decrypt/etc." />
          <Stat label="Probes total" value={stats.probes_total ?? 0} hint="cumulative across pool" />
          <Stat label="Avg risk" value={stats.avg_risk_alive?.toFixed?.(1) ?? '0.0'} hint="0=fresh · 100=burned" />
        </div>
      )}

      {/* Add form */}
      <form onSubmit={doAdd} className="rounded-lg border border-pink-200 bg-pink-50/40 p-4 mb-4 dark:border-pink-300/20 dark:bg-pink-950/20">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-pink-900 dark:text-pink-100">Add burner cookie</h3>
          <label className="text-xs text-pink-700 dark:text-pink-200 flex items-center gap-1">
            <input
              type="checkbox"
              checked={form.useRawBlob}
              onChange={(e) => setForm((f) => ({ ...f, useRawBlob: e.target.checked }))}
            />
            Paste raw blob (advanced)
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <input
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            placeholder="Label (e.g. burner_01_us_residential)"
            className="rounded-lg border border-pink-200 bg-white p-2.5 text-sm focus:border-pink-500 focus:outline-none focus:ring-2 focus:ring-pink-200 dark:border-pink-300/20 dark:bg-pink-950/30 dark:text-white"
          />
          {!form.useRawBlob && (
            <>
              <input
                value={form.sessionid}
                onChange={(e) => setForm((f) => ({ ...f, sessionid: e.target.value }))}
                placeholder="sessionid (required)"
                className="rounded-lg border border-pink-200 bg-white p-2.5 text-sm font-mono dark:border-pink-300/20 dark:bg-pink-950/30 dark:text-white"
              />
              <input
                value={form.ds_user_id}
                onChange={(e) => setForm((f) => ({ ...f, ds_user_id: e.target.value }))}
                placeholder="ds_user_id (required)"
                className="rounded-lg border border-pink-200 bg-white p-2.5 text-sm font-mono dark:border-pink-300/20 dark:bg-pink-950/30 dark:text-white"
              />
              <input
                value={form.csrftoken}
                onChange={(e) => setForm((f) => ({ ...f, csrftoken: e.target.value }))}
                placeholder="csrftoken (required)"
                className="rounded-lg border border-pink-200 bg-white p-2.5 text-sm font-mono dark:border-pink-300/20 dark:bg-pink-950/30 dark:text-white"
              />
              <input
                value={form.mid}
                onChange={(e) => setForm((f) => ({ ...f, mid: e.target.value }))}
                placeholder="mid (optional)"
                className="rounded-lg border border-pink-200 bg-white p-2.5 text-sm font-mono dark:border-pink-300/20 dark:bg-pink-950/30 dark:text-white"
              />
            </>
          )}
          {form.useRawBlob && (
            <textarea
              value={form.rawBlob}
              onChange={(e) => setForm((f) => ({ ...f, rawBlob: e.target.value }))}
              placeholder='{"cookies":[{"name":"sessionid","value":"...","domain":".instagram.com"},...]}'
              rows={5}
              className="md:col-span-2 rounded-lg border border-pink-200 bg-white p-2.5 text-xs font-mono dark:border-pink-300/20 dark:bg-pink-950/30 dark:text-white"
            />
          )}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-pink-700/80 dark:text-pink-200/80">
            <AlertTriangle className="inline h-3.5 w-3.5 mr-1" />
            Burners get burned fast (~30 probes apiece). Bind each to a sticky residential IP and rotate aggressively.
          </p>
          <button
            type="submit"
            className="bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] inline-flex items-center justify-center gap-1 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow"
          >
            <Plus className="h-4 w-4" /> Add to pool
          </button>
        </div>
      </form>

      {/* Filter + table */}
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs text-pink-700 dark:text-pink-200 flex items-center gap-1">
          <input
            type="checkbox"
            checked={includeBlocked}
            onChange={(e) => setIncludeBlocked(e.target.checked)}
          />
          Include blocked
        </label>
        <span className="text-xs text-pink-500">{burners.length} row{burners.length === 1 ? '' : 's'}</span>
      </div>

      {loading && <div className="text-sm text-pink-500">Loading burners…</div>}
      {!loading && burners.length === 0 && (
        <div className="rounded-lg border-2 border-dashed border-pink-300 bg-pink-50 p-8 text-center dark:bg-pink-900/20">
          <Flame className="mx-auto h-8 w-8 text-pink-400" />
          <p className="mt-2 text-sm text-pink-700 dark:text-pink-200">
            No burners in the pool yet. Add at least one before running email/phone enumeration jobs.
          </p>
        </div>
      )}
      {!loading && burners.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-pink-200 dark:border-pink-300/20">
          <table className="min-w-full text-sm">
            <thead className="bg-pink-50 text-left text-xs uppercase tracking-wide text-pink-700 dark:bg-pink-900/20 dark:text-pink-200">
              <tr>
                <th className="px-4 py-2">Label</th>
                <th className="px-4 py-2">ds_user_id</th>
                <th className="px-4 py-2">Proxy</th>
                <th className="px-4 py-2 text-right">Probes</th>
                <th className="px-4 py-2 text-right">Risk</th>
                <th className="px-4 py-2">Last used</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {burners.map((b) => (
                <tr key={b.id} className="border-t border-pink-100 dark:border-pink-300/20">
                  <td className="px-4 py-2">{b.label || `burner #${b.id}`}</td>
                  <td className="px-4 py-2 font-mono text-xs">{b.ds_user_id || '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs">{b.bound_proxy_url || (b.bound_proxy_id ? `id=${b.bound_proxy_id}` : '—')}</td>
                  <td className="px-4 py-2 text-right">{b.probe_count}</td>
                  <td className="px-4 py-2 text-right">{b.risk_score}</td>
                  <td className="px-4 py-2 text-xs">{b.last_used_at ? new Date(b.last_used_at).toLocaleString() : '—'}</td>
                  <td className="px-4 py-2">
                    {b.blocked ? (
                      <span className="text-red-600 inline-flex items-center gap-1">
                        <ShieldOff className="h-3.5 w-3.5" /> {b.blocked_reason || 'blocked'}
                      </span>
                    ) : (
                      <span className="text-green-600 inline-flex items-center gap-1">
                        <ShieldCheck className="h-3.5 w-3.5" /> alive
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="inline-flex gap-2">
                      {!b.blocked && (
                        <button
                          onClick={() => doBlock(b.id)}
                          title="Block"
                          className="inline-flex items-center gap-1 rounded-md border border-amber-300 px-2 py-1 text-xs text-amber-700 hover:bg-amber-50"
                        >
                          <ShieldOff className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => doDelete(b.id)}
                        title="Delete"
                        className="inline-flex items-center gap-1 rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
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

function Stat({ label, value, hint }) {
  return (
    <div className="rounded-lg border border-pink-200 bg-white p-3 dark:border-pink-300/20 dark:bg-pink-950/40">
      <div className="text-xs uppercase tracking-wide text-pink-700 dark:text-pink-200">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold text-pink-900 dark:text-pink-50">{value}</div>
      {hint && <div className="text-[10px] text-pink-500">{hint}</div>}
    </div>
  );
}
