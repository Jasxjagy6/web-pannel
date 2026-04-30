import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ShieldCheck,
  KeyRound,
  Search,
  Users,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCcw,
  PlayCircle,
  ListChecks,
  Eye,
  EyeOff,
  X,
  AlertTriangle,
} from 'lucide-react';
import { useToast } from '../components/common/Toast';
import { useWebSocket } from '../hooks/useWebSocket';
import { listSessions } from '../api/sessions';
import {
  createBulkJob,
  createIndividualJob,
  listJobs,
  getJob,
} from '../api/twoFAJobs';
import { parseApiError, formatRelativeTime } from '../utils/formatters';

const TABS = [
  { id: 'bulk', label: 'Bulk change', desc: 'Same old/new password for many sessions', icon: Users },
  { id: 'individual', label: 'One by one', desc: 'Per-session passwords', icon: KeyRound },
];

function PasswordField({ label, value, onChange, placeholder }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1.5">{label}</label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 pr-10 text-sm text-white placeholder:text-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

function SessionPicker({ sessions, selected, onToggle, onSelectAll, onClear, search, onSearch, multi = true }) {
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const phone = (s.phone || '').toLowerCase();
      const name = ((s.account_info?.firstName || '') + ' ' + (s.account_info?.lastName || '')).toLowerCase();
      const username = (s.account_info?.username || '').toLowerCase();
      return phone.includes(q) || name.includes(q) || username.includes(q);
    });
  }, [sessions, search]);

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800">
      <div className="p-4 border-b border-white/5 flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search by phone, username, name…"
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-dark-900 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
        </div>
        {multi && (
          <>
            <button onClick={onSelectAll} className="text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300">Select all</button>
            <button onClick={onClear} className="text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300">Clear</button>
          </>
        )}
      </div>
      <div className="max-h-72 overflow-y-auto divide-y divide-white/5">
        {filtered.length === 0 && (
          <div className="p-6 text-center text-sm text-gray-500">No active sessions found.</div>
        )}
        {filtered.map((s) => {
          const isSel = selected.includes(s.id);
          return (
            <button
              key={s.id}
              onClick={() => onToggle(s.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                isSel ? 'bg-primary-600/15' : 'hover:bg-white/5'
              }`}
            >
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                isSel ? 'border-primary-500 bg-primary-500' : 'border-white/20 bg-dark-900'
              }`}>
                {isSel && <CheckCircle2 className="w-4 h-4 text-white" />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white truncate">
                  {s.phone}
                  {s.account_info?.username && <span className="text-gray-400 ml-2">@{s.account_info.username}</span>}
                </div>
                <div className="text-xs text-gray-500 truncate">
                  {(s.account_info?.firstName || '') + ' ' + (s.account_info?.lastName || '')} · {s.is_logged_in ? 'logged in' : 'inactive'}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StatusPill({ status, success, total, failed }) {
  const pct = total > 0 ? Math.round(((success + failed) / total) * 100) : 0;
  const color = status === 'completed'
    ? failed > 0 ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30'
    : 'bg-green-500/20 text-green-300 border-green-500/30'
    : status === 'running' ? 'bg-blue-500/20 text-blue-300 border-blue-500/30'
    : 'bg-gray-500/20 text-gray-300 border-gray-500/30';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${color}`}>
      {status === 'running' && <Loader2 className="w-3 h-3 animate-spin" />}
      {status === 'running' ? `${pct}%` : status}
    </span>
  );
}

export default function Change2FA() {
  const { showSuccess, showError } = useToast();
  const ws = useWebSocket();

  const [tab, setTab] = useState('bulk');
  const [sessions, setSessions] = useState([]);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Bulk state
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkOld, setBulkOld] = useState('');
  const [bulkNew, setBulkNew] = useState('');

  // Individual state - list of items keyed by session id
  const [individualItems, setIndividualItems] = useState([]); // {sessionId, oldPassword, newPassword}
  const [pickedIndividual, setPickedIndividual] = useState('');

  // History
  const [jobs, setJobs] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      const res = await listSessions({ limit: 200 });
      const list = res.data?.data?.sessions || [];
      setSessions(list);
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

  // WebSocket live updates
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    ws.connect(token);
    const offProgress = ws.on('twofa:job:progress', () => {
      loadJobs();
      if (activeJob?.id) refreshActive(activeJob.id);
    });
    const offDone = ws.on('twofa:job:done', () => {
      loadJobs();
      if (activeJob?.id) refreshActive(activeJob.id);
    });
    return () => {
      offProgress && offProgress();
      offDone && offDone();
    };
  }, [ws, loadJobs, refreshActive, activeJob?.id]);

  const activeSessions = useMemo(
    () => sessions.filter((s) => s.is_logged_in || (s.status || '').toLowerCase() === 'active'),
    [sessions]
  );

  const toggleBulk = (id) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submitBulk = async () => {
    if (!bulkOld || !bulkNew) return showError('Enter old & new passwords', 'Missing fields');
    if (selectedIds.length === 0) return showError('Pick at least one session', 'No selection');
    setSubmitting(true);
    try {
      const res = await createBulkJob({
        sessionIds: selectedIds,
        oldPassword: bulkOld,
        newPassword: bulkNew,
      });
      showSuccess(`Bulk job #${res.data.data.jobId} queued for ${res.data.data.total} sessions`, 'Job created');
      setActiveJob({ id: res.data.data.jobId });
      setBulkOld('');
      setBulkNew('');
      setSelectedIds([]);
      await loadJobs();
      await refreshActive(res.data.data.jobId);
    } catch (err) {
      showError(parseApiError(err), 'Bulk change failed');
    } finally {
      setSubmitting(false);
    }
  };

  const addIndividual = (id) => {
    if (individualItems.find((i) => i.sessionId === id)) return;
    setIndividualItems((prev) => [...prev, { sessionId: id, oldPassword: '', newPassword: '' }]);
    setPickedIndividual('');
  };

  const updateIndividualField = (id, field, value) => {
    setIndividualItems((prev) =>
      prev.map((it) => (it.sessionId === id ? { ...it, [field]: value } : it))
    );
  };

  const removeIndividual = (id) =>
    setIndividualItems((prev) => prev.filter((it) => it.sessionId !== id));

  const submitIndividual = async () => {
    if (individualItems.length === 0) return showError('Add at least one session', 'No items');
    if (individualItems.some((it) => !it.oldPassword || !it.newPassword))
      return showError('Every row needs old & new password', 'Incomplete');
    setSubmitting(true);
    try {
      const res = await createIndividualJob({ items: individualItems });
      showSuccess(`Individual job #${res.data.data.jobId} queued for ${res.data.data.total} sessions`, 'Job created');
      setActiveJob({ id: res.data.data.jobId });
      setIndividualItems([]);
      await loadJobs();
      await refreshActive(res.data.data.jobId);
    } catch (err) {
      showError(parseApiError(err), 'Individual change failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary-500" />
            Change 2FA Password
          </h2>
          <p className="text-sm text-gray-400">
            Update Telegram cloud password across many sessions in a single job. Failures on one
            session never block the others.
          </p>
        </div>
        <button
          onClick={() => { loadSessions(); loadJobs(); if (activeJob?.id) refreshActive(activeJob.id); }}
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-dark-800 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 transition-colors"
        >
          <RefreshCcw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`group flex flex-1 items-start gap-3 rounded-xl border p-4 text-left transition-all duration-200 ${
                isActive
                  ? 'border-primary-500 bg-primary-600/15 shadow-lg shadow-primary-600/10'
                  : 'border-white/5 bg-dark-800 hover:border-white/20 hover:bg-dark-800/80'
              }`}
            >
              <Icon className={`w-5 h-5 ${isActive ? 'text-primary-500' : 'text-gray-400'}`} />
              <div>
                <div className={`text-sm font-medium ${isActive ? 'text-white' : 'text-gray-300'}`}>{t.label}</div>
                <div className="text-xs text-gray-500">{t.desc}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {tab === 'bulk' && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div className="space-y-4">
            <SessionPicker
              sessions={activeSessions}
              selected={selectedIds}
              onToggle={toggleBulk}
              onSelectAll={() => setSelectedIds(activeSessions.map((s) => s.id))}
              onClear={() => setSelectedIds([])}
              search={search}
              onSearch={setSearch}
            />
            <div className="text-xs text-gray-400">
              <span className="text-primary-400 font-semibold">{selectedIds.length}</span> of {activeSessions.length} sessions selected.
            </div>
          </div>

          <div className="rounded-xl border border-white/5 bg-dark-800 p-5 space-y-4">
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-primary-500" />
              <h3 className="text-sm font-semibold text-white">Bulk credentials</h3>
            </div>
            <PasswordField label="Current 2FA password" value={bulkOld} onChange={setBulkOld} placeholder="••••••••" />
            <PasswordField label="New 2FA password" value={bulkNew} onChange={setBulkNew} placeholder="At least 1 character" />
            <button
              onClick={submitBulk}
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-600/20 hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
              Confirm bulk change for {selectedIds.length} session(s)
            </button>
            <div className="text-[11px] text-gray-500 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-yellow-400" />
              <span>Each session is processed sequentially with a small delay to avoid Telegram flood-wait.</span>
            </div>
          </div>
        </div>
      )}

      {tab === 'individual' && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div className="space-y-4">
            <SessionPicker
              sessions={activeSessions.filter((s) => !individualItems.find((i) => i.sessionId === s.id))}
              selected={pickedIndividual ? [pickedIndividual] : []}
              onToggle={(id) => addIndividual(id)}
              search={search}
              onSearch={setSearch}
              multi={false}
            />
            <div className="text-xs text-gray-400">Pick a session to add it as a row.</div>
          </div>

          <div className="rounded-xl border border-white/5 bg-dark-800 p-5 space-y-4">
            <div className="flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-primary-500" />
              <h3 className="text-sm font-semibold text-white">Per-session credentials</h3>
            </div>
            {individualItems.length === 0 && (
              <div className="text-sm text-gray-500 border border-dashed border-white/10 rounded-lg p-4 text-center">
                No rows yet — pick sessions on the left to add them.
              </div>
            )}
            <div className="space-y-3">
              {individualItems.map((it) => {
                const session = sessions.find((s) => s.id === it.sessionId);
                return (
                  <div key={it.sessionId} className="rounded-lg border border-white/10 bg-dark-900 p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium text-white">
                        {session?.phone || `#${it.sessionId}`}
                      </div>
                      <button onClick={() => removeIndividual(it.sessionId)} className="text-gray-500 hover:text-white">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <PasswordField label="Old" value={it.oldPassword} onChange={(v) => updateIndividualField(it.sessionId, 'oldPassword', v)} placeholder="Old password" />
                      <PasswordField label="New" value={it.newPassword} onChange={(v) => updateIndividualField(it.sessionId, 'newPassword', v)} placeholder="New password" />
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              onClick={submitIndividual}
              disabled={submitting || individualItems.length === 0}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-600/20 hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
              Confirm individual change ({individualItems.length})
            </button>
          </div>
        </div>
      )}

      {/* History + Active job */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-1 rounded-xl border border-white/5 bg-dark-800">
          <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
            <ListChecks className="w-4 h-4 text-primary-500" />
            <h3 className="text-sm font-semibold text-white">History</h3>
            <button
              onClick={async () => { setRefreshing(true); await loadJobs(); setRefreshing(false); }}
              className="ml-auto text-gray-400 hover:text-white"
              title="Refresh"
            >
              <RefreshCcw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="max-h-[380px] overflow-y-auto divide-y divide-white/5">
            {jobs.length === 0 && (
              <div className="p-4 text-center text-xs text-gray-500">No jobs yet.</div>
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
                  <div className="text-sm font-medium text-white">#{j.id} · {j.mode}</div>
                  <div className="text-[11px] text-gray-500">{formatRelativeTime(j.created_at)}</div>
                </div>
                <StatusPill status={j.status} success={j.success_count} failed={j.failed_count} total={j.total_count} />
              </button>
            ))}
          </div>
        </div>

        <div className="xl:col-span-2 rounded-xl border border-white/5 bg-dark-800">
          <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
            <Eye className="w-4 h-4 text-primary-500" />
            <h3 className="text-sm font-semibold text-white">
              {activeJob ? `Job #${activeJob.id}` : 'Job details'}
            </h3>
            {activeJob && (
              <StatusPill
                status={activeJob.status}
                success={activeJob.success_count}
                failed={activeJob.failed_count}
                total={activeJob.total_count}
              />
            )}
          </div>
          {!activeJob ? (
            <div className="p-6 text-center text-sm text-gray-500">Select a job from the history.</div>
          ) : (
            <div className="max-h-[380px] overflow-y-auto divide-y divide-white/5">
              {(activeJob.items || []).map((it) => (
                <div key={it.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white truncate">{it.phone || `Session ${it.session_id}`}</div>
                    {it.error_message && <div className="text-[11px] text-red-400 truncate">{it.error_code}: {it.error_message}</div>}
                    {!it.error_message && it.processed_at && <div className="text-[11px] text-gray-500">processed {formatRelativeTime(it.processed_at)}</div>}
                  </div>
                  {it.status === 'success' && <CheckCircle2 className="w-4 h-4 text-green-400" />}
                  {it.status === 'failed' && <XCircle className="w-4 h-4 text-red-400" />}
                  {it.status === 'pending' && <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
