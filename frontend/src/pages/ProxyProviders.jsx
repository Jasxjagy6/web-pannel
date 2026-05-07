import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Network,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  Wifi,
  Edit3,
  PlayCircle,
  Power,
  PowerOff,
} from 'lucide-react';
import { useToast } from '../components/common/Toast';
import {
  listProxyProviders,
  addProxyProvider,
  updateProxyProvider,
  testProxyProvider,
  deleteProxyProvider,
} from '../api/proxyProviders';
import { parseApiError, formatRelativeTime } from '../utils/formatters';

const ROTATION_POLICIES = [
  { value: 'per_session', label: 'Per session (default)' },
  { value: 'per_login', label: 'Per login' },
  { value: 'per_n_uses', label: 'Per N uses' },
  { value: 'time_based', label: 'Time-based' },
  { value: 'per_request', label: 'Per request' },
];

const PROTOCOLS = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
];

const EMPTY_FORM = {
  vendor: 'iproyal',
  label: '',
  endpoint_host: '',
  endpoint_port: '',
  endpoint_protocol: 'http',
  endpoint_username: '',
  endpoint_password: '',
  api_key: '',
  country_code: '',
  sticky_lifetime_minutes: 30,
  rotation_policy: 'per_session',
  rotate_after_uses: 0,
  max_sessions_per_ip: 1,
  // Custom-driver only
  suffix_template: '',
  suffix_join: '_',
  // SOAX-only convenience field
  package_id: '',
};

export default function ProxyProviders() {
  const { showSuccess, showError } = useToast();
  const [providers, setProviders] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listProxyProviders();
      setProviders(res.data?.data?.providers || []);
      setVendors(res.data?.data?.vendors || []);
    } catch (err) {
      showError(parseApiError(err), 'Proxy providers');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  const vendorMeta = useMemo(() => {
    const map = new Map();
    for (const v of vendors) map.set(v.vendor, v);
    return map;
  }, [vendors]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const onVendorChange = (vendor) => {
    const v = vendorMeta.get(vendor);
    setForm((f) => ({
      ...f,
      vendor,
      endpoint_host: v?.defaults?.gatewayHost || f.endpoint_host,
      endpoint_port: v?.defaults?.gatewayPort || f.endpoint_port,
      endpoint_protocol: v?.defaults?.gatewayProtocol || f.endpoint_protocol,
    }));
  };

  const buildPayload = () => {
    const payload = {
      vendor: form.vendor,
      label: form.label || null,
      endpoint_host: form.endpoint_host,
      endpoint_port: form.endpoint_port ? parseInt(form.endpoint_port, 10) : 0,
      endpoint_protocol: form.endpoint_protocol,
      endpoint_username: form.endpoint_username || null,
      endpoint_password: form.endpoint_password || null,
      api_key: form.api_key || null,
      country_code: form.country_code || null,
      sticky_lifetime_minutes: parseInt(form.sticky_lifetime_minutes, 10) || 30,
      rotation_policy: form.rotation_policy,
      rotate_after_uses: parseInt(form.rotate_after_uses, 10) || 0,
      max_sessions_per_ip: parseInt(form.max_sessions_per_ip, 10) || 1,
    };
    if (form.vendor === 'custom') {
      payload.api_extra = {
        suffix_template: form.suffix_template || undefined,
        suffix_join: form.suffix_join || undefined,
      };
    } else if (form.vendor === 'soax' && form.package_id) {
      payload.api_extra = { package_id: form.package_id };
    }
    return payload;
  };

  const onAdd = async (e) => {
    e?.preventDefault?.();
    setAdding(true);
    try {
      if (editingId) {
        await updateProxyProvider(editingId, buildPayload());
        showSuccess('Provider updated.');
      } else {
        await addProxyProvider(buildPayload());
        showSuccess('Provider added — auto-rotation is now active for new sessions.');
      }
      setForm(EMPTY_FORM);
      setEditingId(null);
      await load();
    } catch (err) {
      showError(parseApiError(err), editingId ? 'Update failed' : 'Add failed');
    } finally {
      setAdding(false);
    }
  };

  const onEdit = (provider) => {
    setEditingId(provider.id);
    setForm({
      vendor: provider.vendor,
      label: provider.label || '',
      endpoint_host: provider.endpoint_host,
      endpoint_port: provider.endpoint_port,
      endpoint_protocol: provider.endpoint_protocol,
      endpoint_username: '',
      endpoint_password: '',
      api_key: '',
      country_code: provider.country_code || '',
      sticky_lifetime_minutes: provider.sticky_lifetime_minutes,
      rotation_policy: provider.rotation_policy,
      rotate_after_uses: provider.rotate_after_uses,
      max_sessions_per_ip: provider.max_sessions_per_ip,
      suffix_template: provider.api_extra?.suffix_template || '',
      suffix_join: provider.api_extra?.suffix_join || '_',
      package_id: provider.api_extra?.package_id || '',
    });
  };

  const onCancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const onToggle = async (provider) => {
    try {
      await updateProxyProvider(provider.id, { enabled: !provider.enabled });
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Toggle failed');
    }
  };

  const onTest = async (id) => {
    setTestingId(id);
    try {
      const res = await testProxyProvider(id);
      const result = res.data?.data?.result;
      if (result?.ok) {
        showSuccess(result.message || 'Provider credentials accepted.', 'Test');
      } else {
        showError(result?.message || 'Provider test failed.', 'Test');
      }
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Test failed');
    } finally {
      setTestingId(null);
    }
  };

  const onDelete = async (provider) => {
    if (!window.confirm(`Delete provider "${provider.label || provider.vendor_label}"?`)) return;
    try {
      await deleteProxyProvider(provider.id);
      showSuccess('Provider removed.');
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Delete failed');
    }
  };

  const selectedVendor = vendorMeta.get(form.vendor);
  const suffixHelp = selectedVendor?.defaults?.suffixHelp || '';

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Network className="w-6 h-6" />
            Auto-rotating proxy providers
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Hook up an upstream rotating-proxy provider (IPRoyal, SOAX,
            ProxyEmpire, Smartproxy, or any custom gateway) and the panel
            mints a unique sticky IP per session automatically. Bulk
            login of 100 sessions = 100 distinct IPs, no manual proxy
            list required. Default behaviour stays unchanged when no
            provider is enabled.
          </p>
        </div>
      </header>

      {/* Add / edit form */}
      <form
        onSubmit={onAdd}
        className="border border-gray-700 rounded-lg p-4 bg-gray-900/50 space-y-4"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-sm text-gray-300 flex flex-col">
            Vendor
            <select
              value={form.vendor}
              onChange={(e) => onVendorChange(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
            >
              {vendors.map((v) => (
                <option key={v.vendor} value={v.vendor}>{v.label}</option>
              ))}
            </select>
          </label>

          <label className="text-sm text-gray-300 flex flex-col">
            Label
            <input
              type="text"
              value={form.label}
              onChange={(e) => setField('label', e.target.value)}
              placeholder="e.g. IPRoyal mobile US"
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
            />
          </label>

          <label className="text-sm text-gray-300 flex flex-col">
            Country (ISO-3166 alpha-2; blank = any)
            <input
              type="text"
              value={form.country_code}
              onChange={(e) => setField('country_code', e.target.value.toLowerCase())}
              placeholder="us, gb, in…"
              maxLength={2}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
            />
          </label>

          <label className="text-sm text-gray-300 flex flex-col">
            Gateway host
            <input
              type="text"
              value={form.endpoint_host}
              onChange={(e) => setField('endpoint_host', e.target.value)}
              placeholder={selectedVendor?.defaults?.gatewayHost || 'gateway.example.com'}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
              required
            />
          </label>

          <label className="text-sm text-gray-300 flex flex-col">
            Gateway port
            <input
              type="number"
              value={form.endpoint_port}
              onChange={(e) => setField('endpoint_port', e.target.value)}
              placeholder={selectedVendor?.defaults?.gatewayPort || '12321'}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
              required
            />
          </label>

          <label className="text-sm text-gray-300 flex flex-col">
            Protocol
            <select
              value={form.endpoint_protocol}
              onChange={(e) => setField('endpoint_protocol', e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
            >
              {PROTOCOLS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </label>

          <label className="text-sm text-gray-300 flex flex-col">
            Endpoint username
            <input
              type="text"
              value={form.endpoint_username}
              onChange={(e) => setField('endpoint_username', e.target.value)}
              placeholder={editingId ? '(unchanged)' : 'gateway username'}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
            />
          </label>

          <label className="text-sm text-gray-300 flex flex-col">
            Endpoint password
            <input
              type="password"
              value={form.endpoint_password}
              onChange={(e) => setField('endpoint_password', e.target.value)}
              placeholder={editingId ? '(unchanged)' : 'gateway password'}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
            />
          </label>

          <label className="text-sm text-gray-300 flex flex-col">
            API key (dashboard / reseller — optional)
            <input
              type="password"
              value={form.api_key}
              onChange={(e) => setField('api_key', e.target.value)}
              placeholder={editingId ? '(unchanged)' : 'api key for balance / quota'}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
            />
          </label>

          <label className="text-sm text-gray-300 flex flex-col">
            Sticky lifetime (minutes)
            <input
              type="number"
              min={1}
              max={1440}
              value={form.sticky_lifetime_minutes}
              onChange={(e) => setField('sticky_lifetime_minutes', e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
            />
          </label>

          <label className="text-sm text-gray-300 flex flex-col">
            Rotation policy
            <select
              value={form.rotation_policy}
              onChange={(e) => setField('rotation_policy', e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
            >
              {ROTATION_POLICIES.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </label>

          <label className="text-sm text-gray-300 flex flex-col">
            Rotate after N uses {form.rotation_policy !== 'per_n_uses' && <span className="text-xs text-gray-500">(only used when policy=per_n_uses)</span>}
            <input
              type="number"
              min={0}
              value={form.rotate_after_uses}
              onChange={(e) => setField('rotate_after_uses', e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
            />
          </label>

          <label className="text-sm text-gray-300 flex flex-col">
            Max sessions per IP
            <input
              type="number"
              min={1}
              max={10}
              value={form.max_sessions_per_ip}
              onChange={(e) => setField('max_sessions_per_ip', e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
            />
          </label>

          {form.vendor === 'soax' && (
            <label className="text-sm text-gray-300 flex flex-col md:col-span-3">
              SOAX package ID
              <input
                type="text"
                value={form.package_id}
                onChange={(e) => setField('package_id', e.target.value)}
                placeholder="numeric package id from your SOAX dashboard"
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1"
              />
            </label>
          )}
          {form.vendor === 'custom' && (
            <>
              <label className="text-sm text-gray-300 flex flex-col md:col-span-2">
                Suffix template
                <input
                  type="text"
                  value={form.suffix_template}
                  onChange={(e) => setField('suffix_template', e.target.value)}
                  placeholder="country-{country}_session-{token}_lifetime-{minutes}m"
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1 font-mono"
                />
              </label>
              <label className="text-sm text-gray-300 flex flex-col">
                Suffix separator
                <input
                  type="text"
                  value={form.suffix_join}
                  onChange={(e) => setField('suffix_join', e.target.value)}
                  placeholder="_"
                  maxLength={2}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 mt-1 font-mono"
                />
              </label>
            </>
          )}
        </div>

        {suffixHelp && (
          <p className="text-xs text-gray-400 font-mono">{suffixHelp}</p>
        )}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={adding}
            className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded inline-flex items-center gap-2 disabled:opacity-50"
          >
            {adding
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Plus className="w-4 h-4" />}
            {editingId ? 'Save changes' : 'Add provider'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={onCancelEdit}
              className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded"
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      {/* Provider list */}
      <div className="border border-gray-700 rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-700">
          <thead className="bg-gray-800/50">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-400">Vendor</th>
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-400">Label</th>
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-400">Endpoint</th>
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-400">Sticky / Policy</th>
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-400">Country</th>
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-400">Health</th>
              <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-400">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {loading && (
              <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…
              </td></tr>
            )}
            {!loading && providers.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-500">
                No providers yet. The panel works without a provider; add one
                here to enable per-session sticky-IP auto-rotation across
                bulk login and ongoing operations.
              </td></tr>
            )}
            {providers.map((p) => (
              <tr key={p.id} className={p.enabled ? '' : 'opacity-60'}>
                <td className="px-3 py-2 text-sm">{p.vendor_label}</td>
                <td className="px-3 py-2 text-sm">{p.label || '—'}</td>
                <td className="px-3 py-2 text-sm font-mono">
                  {p.endpoint_protocol}://{p.endpoint_host}:{p.endpoint_port}
                  {p.has_endpoint_username && (
                    <span className="text-xs text-gray-500 ml-1">(auth)</span>
                  )}
                </td>
                <td className="px-3 py-2 text-sm">
                  {p.sticky_lifetime_minutes}m / {p.rotation_policy}
                </td>
                <td className="px-3 py-2 text-sm">{p.country_code || 'any'}</td>
                <td className="px-3 py-2 text-sm">
                  {p.last_health_ok === true && (
                    <span className="text-emerald-400 inline-flex items-center gap-1">
                      <CheckCircle2 className="w-4 h-4" />ok
                    </span>
                  )}
                  {p.last_health_ok === false && (
                    <span className="text-rose-400 inline-flex items-center gap-1">
                      <XCircle className="w-4 h-4" />fail
                    </span>
                  )}
                  {p.last_health_ok == null && (
                    <span className="text-gray-500">untested</span>
                  )}
                  {p.last_health_check_at && (
                    <div className="text-xs text-gray-500">
                      {formatRelativeTime(p.last_health_check_at)}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-sm whitespace-nowrap">
                  <button
                    onClick={() => onTest(p.id)}
                    disabled={testingId === p.id}
                    className="text-blue-400 hover:text-blue-300 mr-2 inline-flex items-center gap-1"
                    title="Run health check"
                  >
                    {testingId === p.id
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <Wifi className="w-4 h-4" />}
                    Test
                  </button>
                  <button
                    onClick={() => onToggle(p)}
                    className={(p.enabled ? 'text-amber-400' : 'text-emerald-400') + ' hover:opacity-80 mr-2 inline-flex items-center gap-1'}
                    title={p.enabled ? 'Disable provider' : 'Enable provider'}
                  >
                    {p.enabled ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
                    {p.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => onEdit(p)}
                    className="text-gray-300 hover:text-white mr-2 inline-flex items-center gap-1"
                    title="Edit"
                  >
                    <Edit3 className="w-4 h-4" />Edit
                  </button>
                  <button
                    onClick={() => onDelete(p)}
                    className="text-rose-400 hover:text-rose-300 inline-flex items-center gap-1"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-gray-500">
        <PlayCircle className="w-4 h-4 inline mr-1" />
        Once a provider is enabled, the next login or reauth on every session
        binds a fresh sticky IP via the gateway. Bulk-login orchestration
        gets 1 IP per session automatically. Anti-detect risk gating still
        applies — the panel rotates the sticky IP when a session's risk
        spikes.
      </div>
    </div>
  );
}
