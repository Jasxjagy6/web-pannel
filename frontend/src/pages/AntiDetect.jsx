import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Fingerprint,
  Smartphone,
  Monitor,
  Apple,
  Globe,
  RotateCcw,
  Play,
  Activity,
  Loader2,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { useToast } from '../components/common/Toast';
import {
  getAntiDetectStatus,
  listIdentities,
  rotateIdentity,
  listBehaviorLogs,
  runWarmupTick,
  runWarmupForSession,
} from '../api/antiDetect';
import { parseApiError, formatRelativeTime } from '../utils/formatters';

const PLATFORM_ICONS = {
  android: Smartphone,
  ios: Apple,
  tdesktop: Monitor,
  web: Globe,
};

const PLATFORM_LABELS = {
  android: 'Android',
  ios: 'iOS',
  tdesktop: 'TDesktop',
  web: 'Web',
};

function PlatformBadge({ platform }) {
  const Icon = PLATFORM_ICONS[platform] || Globe;
  const label = PLATFORM_LABELS[platform] || platform || 'Unknown';
  const colors = {
    android: 'bg-green-500/10 text-green-400 border-green-500/20',
    ios: 'bg-gray-500/10 text-gray-300 border-gray-500/20',
    tdesktop: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    web: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  };
  const cls = colors[platform] || 'bg-white/5 text-gray-300 border-white/10';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium ${cls}`}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

function StatCard({ icon: Icon, label, value, subtitle, color = 'text-gray-300' }) {
  return (
    <div className="rounded-xl border border-white/5 bg-dark-800 p-4">
      <div className="flex items-center gap-2 text-gray-400 text-xs uppercase tracking-wider">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className={`mt-2 text-2xl font-bold ${color}`}>{value}</div>
      {subtitle && <div className="mt-1 text-xs text-gray-500">{subtitle}</div>}
    </div>
  );
}

export default function AntiDetect() {
  const { showSuccess, showError, showInfo } = useToast();
  const [status, setStatus] = useState(null);
  const [identities, setIdentities] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [rotatingId, setRotatingId] = useState(null);
  const [runningSessionId, setRunningSessionId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, listRes, logsRes] = await Promise.all([
        getAntiDetectStatus(),
        listIdentities(),
        listBehaviorLogs({ limit: 100 }),
      ]);
      setStatus(statusRes.data?.data || null);
      setIdentities(listRes.data?.data?.items || []);
      setLogs(logsRes.data?.data?.items || []);
    } catch (err) {
      showError(parseApiError(err), 'Anti-Detect');
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

  const handleRotate = async (sessionId) => {
    if (!confirm('Reassign device fingerprint for this session? Telegram will see a new device next reconnect.')) return;
    setRotatingId(sessionId);
    try {
      const r = await rotateIdentity(sessionId);
      const id = r.data?.data?.identity;
      showSuccess(
        `${id?.platform || ''} · ${id?.deviceModel || ''}`,
        'Identity rotated'
      );
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Rotate failed');
    } finally {
      setRotatingId(null);
    }
  };

  const handleRunSession = async (sessionId) => {
    setRunningSessionId(sessionId);
    try {
      const r = await runWarmupForSession(sessionId);
      const d = r.data?.data || {};
      if (d.succeeded) {
        showSuccess(`${d.action} · ${d.target || 'ok'}`, 'Warm-up performed');
      } else {
        showInfo(d.error || 'skipped', `Warm-up: ${d.action || ''}`);
      }
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Warm-up failed');
    } finally {
      setRunningSessionId(null);
    }
  };

  const handleRunTick = async () => {
    setRunning(true);
    try {
      const r = await runWarmupTick({});
      const d = r.data?.data || {};
      showSuccess(
        `picked ${d.picked || 0} · ok ${d.succeeded || 0} · skip ${d.skipped || 0} · fail ${d.failed || 0}`,
        'Warm-up tick complete'
      );
      await load();
    } catch (err) {
      showError(parseApiError(err), 'Warm-up tick failed');
    } finally {
      setRunning(false);
    }
  };

  const stats = useMemo(() => {
    const total = identities.length;
    const withId = identities.filter((s) => s.has_identity).length;
    const withProxy = identities.filter((s) => s.bound_proxy_id).length;
    const platforms = {};
    identities.forEach((s) => {
      const p = s.identity?.platform || 'unknown';
      platforms[p] = (platforms[p] || 0) + 1;
    });
    return { total, withId, withProxy, platforms };
  }, [identities]);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Fingerprint className="w-5 h-5 text-primary-500" />
            Anti-Detect
          </h2>
          <p className="text-sm text-gray-400">
            Per-session device fingerprints + proxy binding + read-only behavior
            simulation. Each account looks like a unique human-operated phone or
            desktop client.
          </p>
        </div>
        <button
          onClick={handleRunTick}
          disabled={running}
          className="flex items-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-xs font-medium text-white hover:bg-primary-700 disabled:opacity-50"
        >
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          Run warm-up tick now
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Fingerprint}
          label="Sessions w/ identity"
          value={`${stats.withId}/${stats.total}`}
          subtitle="Persisted device fingerprints"
          color="text-primary-400"
        />
        <StatCard
          icon={Globe}
          label="Sessions w/ bound proxy"
          value={`${stats.withProxy}/${stats.total}`}
          subtitle="1:1 proxy binding"
          color="text-green-400"
        />
        <StatCard
          icon={Activity}
          label="Behavior actions (24h)"
          value={status?.behavior?.last24h ?? '—'}
          subtitle={`${status?.behavior?.successful24h ?? 0} successful`}
          color="text-yellow-400"
        />
        <StatCard
          icon={Activity}
          label="Profile pool"
          value={status?.profilePool?.length ?? '—'}
          subtitle="Realistic device profiles"
          color="text-gray-300"
        />
      </div>

      {/* Per-session identities */}
      <div className="rounded-xl border border-white/5 bg-dark-800 overflow-hidden">
        <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Fingerprint className="w-4 h-4 text-primary-500" />
            Session identities ({identities.length})
          </h3>
          {loading && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-gray-400">
              <tr>
                <th className="px-4 py-2 text-left">Session</th>
                <th className="px-4 py-2 text-left">Phone</th>
                <th className="px-4 py-2 text-left">Platform</th>
                <th className="px-4 py-2 text-left">Device</th>
                <th className="px-4 py-2 text-left">App</th>
                <th className="px-4 py-2 text-left">Lang</th>
                <th className="px-4 py-2 text-left">Proxy</th>
                <th className="px-4 py-2 text-left">Last warm-up</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {identities.length === 0 && !loading && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    No sessions found.
                  </td>
                </tr>
              )}
              {identities.map((s) => {
                const id = s.identity || {};
                return (
                  <tr key={s.session_id} className="border-t border-white/5 hover:bg-white/5">
                    <td className="px-4 py-2 text-gray-300 font-mono">#{s.session_id}</td>
                    <td className="px-4 py-2 text-gray-300">{s.phone || '—'}</td>
                    <td className="px-4 py-2"><PlatformBadge platform={id.platform} /></td>
                    <td className="px-4 py-2 text-gray-300">{id.deviceModel || '—'}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">
                      {id.systemVersion ? `${id.systemVersion} · ` : ''}{id.appVersion || ''}
                    </td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{id.langCode || '—'}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">
                      {s.bound_proxy_id ? `#${s.bound_proxy_id}` : <span className="text-gray-600">unbound</span>}
                    </td>
                    <td className="px-4 py-2 text-gray-400 text-xs">
                      {s.last_warmup_at ? formatRelativeTime(s.last_warmup_at) : 'never'}
                    </td>
                    <td className="px-4 py-2 text-right space-x-2 whitespace-nowrap">
                      <button
                        onClick={() => handleRunSession(s.session_id)}
                        disabled={runningSessionId === s.session_id}
                        className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-gray-300 hover:bg-white/10 disabled:opacity-50"
                        title="Run one read-only warm-up action"
                      >
                        {runningSessionId === s.session_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                        Warm up
                      </button>
                      <button
                        onClick={() => handleRotate(s.session_id)}
                        disabled={rotatingId === s.session_id}
                        className="inline-flex items-center gap-1 rounded border border-yellow-500/30 bg-yellow-500/10 px-2 py-1 text-[11px] text-yellow-300 hover:bg-yellow-500/20 disabled:opacity-50"
                        title="Reassign a brand-new device fingerprint"
                      >
                        {rotatingId === s.session_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                        Rotate
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Behavior log */}
      <div className="rounded-xl border border-white/5 bg-dark-800 overflow-hidden">
        <div className="px-5 py-3 border-b border-white/5">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary-500" />
            Recent behavior actions
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-gray-400">
              <tr>
                <th className="px-4 py-2 text-left">When</th>
                <th className="px-4 py-2 text-left">Session</th>
                <th className="px-4 py-2 text-left">Action</th>
                <th className="px-4 py-2 text-left">Target</th>
                <th className="px-4 py-2 text-left">Result</th>
                <th className="px-4 py-2 text-left">Detail</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    No behavior actions recorded yet.
                  </td>
                </tr>
              )}
              {logs.map((row) => (
                <tr key={row.id} className="border-t border-white/5">
                  <td className="px-4 py-2 text-gray-400 text-xs">{formatRelativeTime(row.performed_at)}</td>
                  <td className="px-4 py-2 text-gray-300 font-mono text-xs">#{row.session_id}</td>
                  <td className="px-4 py-2 text-gray-300">{row.action}</td>
                  <td className="px-4 py-2 text-gray-400 text-xs">{row.target || '—'}</td>
                  <td className="px-4 py-2">
                    {row.succeeded ? (
                      <span className="inline-flex items-center gap-1 text-green-400 text-xs">
                        <CheckCircle2 className="w-3 h-3" /> ok
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-red-400 text-xs">
                        <XCircle className="w-3 h-3" /> {row.error_code || 'fail'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-500 text-xs truncate max-w-[260px]">
                    {row.error_message || (row.details ? JSON.stringify(row.details) : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
