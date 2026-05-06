import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  KeyRound,
  Search,
  PlayCircle,
  Loader2,
  CheckCircle2,
  Hourglass,
  Clock,
  RefreshCcw,
  Copy,
  Eye,
  ListChecks,
  AlertTriangle,
} from 'lucide-react';
import { useToast } from '../components/common/Toast';
import { useWebSocket } from '../hooks/useWebSocket';
import { listSessions } from '../api/sessions';
import { startScan, listJobs, getJob } from '../api/otp';
import { parseApiError, formatRelativeTime } from '../utils/formatters';
import SessionListSwitcher from '../components/common/SessionListSwitcher';

const DURATION_OPTIONS = [
  { value: 60, label: '1 minute' },
  { value: 180, label: '3 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
];

function CountdownPill({ expiresAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!expiresAt) return null;
  const remaining = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30 px-2.5 py-0.5 text-[11px] font-mono font-semibold">
      <Clock className="w-3 h-3" />
      {String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}
    </span>
  );
}

function ItemRow({ item, onCopy }) {
  const isDetected = item.status === 'detected' && item.otp_code;
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 transition-colors ${
        isDetected ? 'bg-green-600/10 animate-pulse-slow' : ''
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm text-white truncate">{item.phone || `Session ${item.session_id}`}</div>
        {item.raw_message && (
          <div className="text-[11px] text-gray-500 truncate" title={item.raw_message}>
            {item.raw_message}
          </div>
        )}
        {!item.raw_message && (
          <div className="text-[11px] text-gray-500">
            {item.status === 'scanning' && 'Listening for code…'}
            {item.status === 'expired' && 'No code received within window'}
            {item.status === 'failed' && 'Failed to attach listener'}
          </div>
        )}
      </div>
      {isDetected ? (
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-green-300 bg-green-500/15 border border-green-500/30 rounded px-2 py-0.5">
            {item.otp_code}
          </span>
          <button
            className="text-gray-400 hover:text-white"
            onClick={() => onCopy(item.otp_code)}
            title="Copy"
          >
            <Copy className="w-4 h-4" />
          </button>
        </div>
      ) : item.status === 'expired' || item.status === 'failed' ? (
        <Hourglass className="w-4 h-4 text-gray-400" />
      ) : (
        <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
      )}
    </div>
  );
}

export default function GetOTP() {
  const { showSuccess, showError, showInfo } = useToast();
  const ws = useWebSocket();

  const [sessions, setSessions] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [sessionPickMode, setSessionPickMode] = useState('sessions');
  const [selectedSessionListId, setSelectedSessionListId] = useState('');
  const [duration, setDuration] = useState(300);
  const [submitting, setSubmitting] = useState(false);

  const [jobs, setJobs] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const activeIdRef = useRef(null);

  const loadSessions = useCallback(async () => {
    try {
      const res = await listSessions({ limit: 200 });
      setSessions(res.data?.data?.sessions || []);
    } catch (err) {
      showError(parseApiError(err), 'Sessions');
    }
  }, [showError]);

  const loadJobs = useCallback(async () => {
    try {
      const res = await listJobs({ limit: 30 });
      setJobs(res.data?.data?.jobs || []);
    } catch (err) {
      console.warn('listJobs', err);
    }
  }, []);

  const refreshActive = useCallback(async (jobId) => {
    if (!jobId) return;
    try {
      const res = await getJob(jobId);
      setActiveJob(res.data?.data?.job || null);
    } catch (err) {
      console.warn('getJob', err);
    }
  }, []);

  useEffect(() => {
    loadSessions();
    loadJobs();
  }, [loadSessions, loadJobs]);

  useEffect(() => { activeIdRef.current = activeJob?.id; }, [activeJob?.id]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    ws.connect(token);
    const handlers = [
      ws.on('otp:detected', (payload) => {
        showSuccess(`OTP for session ${payload.sessionId}: ${payload.otp}`, 'OTP detected');
        loadJobs();
        if (activeIdRef.current === payload.jobId) refreshActive(payload.jobId);
      }),
      ws.on('otp:item:update', () => {
        if (activeIdRef.current) refreshActive(activeIdRef.current);
      }),
      ws.on('otp:job:done', () => {
        loadJobs();
        if (activeIdRef.current) refreshActive(activeIdRef.current);
      }),
      ws.on('otp:job:started', () => loadJobs()),
    ];
    return () => handlers.forEach((h) => h && h());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const activeSessions = useMemo(
    () => sessions.filter((s) => s.is_logged_in || (s.status || '').toLowerCase() === 'active'),
    [sessions]
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activeSessions;
    return activeSessions.filter((s) => {
      const phone = (s.phone || '').toLowerCase();
      const username = (s.account_info?.username || '').toLowerCase();
      return phone.includes(q) || username.includes(q);
    });
  }, [activeSessions, search]);

  const toggle = (id) =>
    setSelectedIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const startJob = async () => {
    const usingList = sessionPickMode === 'list' && selectedSessionListId;
    if (!usingList && selectedIds.length === 0) return showError('Select at least one session (or pick a session list)', 'No selection');
    if (sessionPickMode === 'list' && !selectedSessionListId) return showError('Pick a session list', 'No selection');
    setSubmitting(true);
    try {
      const scanPayload = { durationSeconds: duration };
      if (usingList) {
        scanPayload.sessionListId = Number(selectedSessionListId);
      } else {
        scanPayload.sessionIds = selectedIds;
      }
      const res = await startScan(scanPayload);
      const jobId = res.data?.data?.jobId;
      showSuccess(`Scan #${jobId} started for ${res.data.data.total} session(s)`, 'Scanning');
      setSelectedIds([]);
      setSelectedSessionListId('');
      await loadJobs();
      await refreshActive(jobId);
    } catch (err) {
      showError(parseApiError(err), 'Failed to start scan');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = (code) => {
    navigator.clipboard?.writeText(code);
    showInfo?.(`Copied ${code}`, 'OTP');
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-primary-500" />
            Get OTP
          </h2>
          <p className="text-sm text-gray-400">
            Scan selected sessions for incoming Telegram login codes. Updates appear live as messages
            arrive.
          </p>
        </div>
        <button
          onClick={() => { loadSessions(); loadJobs(); if (activeJob?.id) refreshActive(activeJob.id); }}
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-dark-800 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10"
        >
          <RefreshCcw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="space-y-4">
          <SessionListSwitcher
            mode={sessionPickMode}
            onModeChange={setSessionPickMode}
            selectedSessionListId={selectedSessionListId}
            onSelectedSessionListIdChange={setSelectedSessionListId}
          />
          <div className={`rounded-xl border border-white/5 bg-dark-800 ${sessionPickMode === 'list' ? 'hidden' : ''}`}>
            <div className="p-4 border-b border-white/5 flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search sessions…"
                  className="w-full pl-9 pr-3 py-2 rounded-lg bg-dark-900 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                />
              </div>
              <button onClick={() => setSelectedIds(filtered.map((s) => s.id))} className="text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300">Select all</button>
              <button onClick={() => setSelectedIds([])} className="text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300">Clear</button>
            </div>
            <div className="max-h-72 overflow-y-auto divide-y divide-white/5">
              {filtered.length === 0 && (
                <div className="p-6 text-center text-sm text-gray-500">No active sessions.</div>
              )}
              {filtered.map((s) => {
                const sel = selectedIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => toggle(s.id)}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                      sel ? 'bg-primary-600/15' : 'hover:bg-white/5'
                    }`}
                  >
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                      sel ? 'border-primary-500 bg-primary-500' : 'border-white/20 bg-dark-900'
                    }`}>
                      {sel && <CheckCircle2 className="w-4 h-4 text-white" />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white truncate">{s.phone}</div>
                      <div className="text-xs text-gray-500 truncate">
                        {(s.account_info?.firstName || '') + ' ' + (s.account_info?.lastName || '')}
                        {s.account_info?.username && <span className="ml-2">@{s.account_info.username}</span>}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="text-xs text-gray-400">
            {sessionPickMode === 'list' ? (
              <span className="text-primary-400 font-semibold">Session list mode</span>
            ) : (
              <>
                <span className="text-primary-400 font-semibold">{selectedIds.length}</span> session(s) selected.
              </>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-white/5 bg-dark-800 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary-500" />
            <h3 className="text-sm font-semibold text-white">Scan window</h3>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {DURATION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDuration(opt.value)}
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                  duration === opt.value
                    ? 'border-primary-500 bg-primary-600/15 text-white'
                    : 'border-white/10 bg-dark-900 text-gray-300 hover:border-white/20'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={startJob}
            disabled={
              submitting ||
              (sessionPickMode === 'list' ? !selectedSessionListId : selectedIds.length === 0)
            }
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-600/20 hover:bg-primary-700 transition-colors disabled:opacity-50"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
            Start scan ({sessionPickMode === 'list' ? 'session list' : selectedIds.length})
          </button>
          <div className="text-[11px] text-gray-500 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-yellow-400" />
            <span>The panel listens for new messages from the Telegram service account during the window. Detected codes appear instantly via WebSocket.</span>
          </div>
        </div>
      </div>

      {/* History + Active */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-1 rounded-xl border border-white/5 bg-dark-800">
          <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
            <ListChecks className="w-4 h-4 text-primary-500" />
            <h3 className="text-sm font-semibold text-white">History</h3>
          </div>
          <div className="max-h-[380px] overflow-y-auto divide-y divide-white/5">
            {jobs.length === 0 && (
              <div className="p-4 text-center text-xs text-gray-500">No scans yet.</div>
            )}
            {jobs.map((j) => (
              <button
                key={j.id}
                onClick={() => refreshActive(j.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                  activeJob?.id === j.id ? 'bg-primary-600/15' : 'hover:bg-white/5'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white">#{j.id} · {j.detected_count}/{j.total_count}</div>
                  <div className="text-[11px] text-gray-500">{formatRelativeTime(j.created_at)} · {j.duration_seconds}s</div>
                </div>
                {j.status === 'scanning'
                  ? <CountdownPill expiresAt={j.expires_at} />
                  : <span className="rounded-full bg-gray-500/20 text-gray-300 border border-gray-500/30 px-2 py-0.5 text-[11px]">{j.status}</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="xl:col-span-2 rounded-xl border border-white/5 bg-dark-800">
          <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
            <Eye className="w-4 h-4 text-primary-500" />
            <h3 className="text-sm font-semibold text-white">
              {activeJob ? `Scan #${activeJob.id}` : 'Scan details'}
            </h3>
            {activeJob?.status === 'scanning' && <CountdownPill expiresAt={activeJob.expires_at} />}
            {activeJob && activeJob.status !== 'scanning' && (
              <span className="rounded-full bg-green-500/20 text-green-300 border border-green-500/30 px-2 py-0.5 text-[11px]">{activeJob.status}</span>
            )}
          </div>
          {!activeJob ? (
            <div className="p-6 text-center text-sm text-gray-500">Select a scan from the history.</div>
          ) : (
            <div className="max-h-[380px] overflow-y-auto divide-y divide-white/5">
              {(activeJob.items || []).map((it) => <ItemRow key={it.id} item={it} onCopy={handleCopy} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
