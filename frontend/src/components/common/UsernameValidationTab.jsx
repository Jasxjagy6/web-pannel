import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  StopCircle,
  FileJson,
  FileText,
  Layers,
  Loader2,
  RefreshCw,
  SearchCheck,
  ShieldCheck,
  Users,
  XCircle,
} from 'lucide-react';
import { listsAPI } from '../../api/lists';
import { sessionListsAPI } from '../../api/sessionLists';
import SessionListSwitcher from './SessionListSwitcher';
import { useToast } from './Toast';
import { formatNumber, formatRelativeTime, parseApiError } from '../../utils/formatters';

const ACTIVE_STATUSES = new Set(['pending', 'running', 'waiting']);
const STATUS_STYLE = {
  pending: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
  running: 'border-blue-500/20 bg-blue-500/10 text-blue-300',
  waiting: 'border-violet-500/20 bg-violet-500/10 text-violet-300',
  completed: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  exhausted: 'border-orange-500/20 bg-orange-500/10 text-orange-300',
  cancelled: 'border-gray-500/20 bg-gray-500/10 text-gray-300',
  failed: 'border-red-500/20 bg-red-500/10 text-red-300',
};

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${STATUS_STYLE[status] || STATUS_STYLE.cancelled}`}>
      {status}
    </span>
  );
}

function Metric({ label, value, tone = 'text-white' }) {
  return (
    <div className="rounded-lg border border-white/5 bg-dark-900/70 px-3 py-3">
      <div className={`text-xl font-semibold tabular-nums ${tone}`}>{formatNumber(value)}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wider text-gray-500">{label}</div>
    </div>
  );
}

function DownloadButtons({ job, onDownload, downloading }) {
  if (!job?.resultListId) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {[
        ['csv', FileText],
        ['json', FileJson],
        ['txt', FileText],
      ].map(([format, Icon]) => (
        <button
          key={format}
          type="button"
          onClick={() => onDownload(job, format)}
          disabled={downloading === `${job.id}:${format}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-gray-200 transition-colors hover:border-emerald-500/30 hover:bg-emerald-500/10 hover:text-emerald-300 disabled:opacity-50"
        >
          {downloading === `${job.id}:${format}` ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Icon className="h-3.5 w-3.5" />
          )}
          {format.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export default function UsernameValidationTab({ onListsChanged }) {
  const { error: showError, success: showSuccess } = useToast();
  const [userLists, setUserLists] = useState([]);
  const [sessionLists, setSessionLists] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [sourceListId, setSourceListId] = useState('');
  const [selectedSessionListIds, setSelectedSessionListIds] = useState([]);
  const [resultListName, setResultListName] = useState('');
  const [retryAfterFloodWait, setRetryAfterFloodWait] = useState(false);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [downloading, setDownloading] = useState('');
  // 'session' = live MTProto resolve (accurate, uses sessions, rate-limited).
  // 'link'    = sessionless t.me web-preview check (very fast, no sessions).
  const [method, setMethod] = useState('link');
  const notifiedTerminal = useRef(new Set());

  const loadSetup = useCallback(async () => {
    const [firstListsResponse, sessionListsResponse] = await Promise.all([
      listsAPI.list({ page: 1, limit: 100 }),
      sessionListsAPI.list({ platform: 'telegram' }),
    ]);
    const firstLists = firstListsResponse.data?.data?.lists || [];
    const totalPages = Number(firstListsResponse.data?.data?.pagination?.totalPages || 1);
    let allLists = firstLists;
    if (totalPages > 1) {
      const remaining = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, index) =>
          listsAPI.list({ page: index + 2, limit: 100 })
        )
      );
      allLists = [
        ...firstLists,
        ...remaining.flatMap((response) => response.data?.data?.lists || []),
      ];
    }
    setUserLists(
      allLists.filter((list) => list.type !== 'profile')
    );
    setSessionLists(sessionListsResponse.data?.data?.lists || []);
  }, []);

  const loadJobs = useCallback(async () => {
    const response = await listsAPI.listUsernameValidationJobs({ limit: 30 });
    const nextJobs = response.data?.data?.jobs || [];
    setJobs(nextJobs);
    return nextJobs;
  }, []);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const [, nextJobs] = await Promise.all([loadSetup(), loadJobs()]);
      const current = nextJobs.find((job) => ACTIVE_STATUSES.has(job.status));
      if (current) {
        const detail = await listsAPI.getUsernameValidationJob(current.id);
        setActiveJob(detail.data?.data || current);
      }
    } catch (error) {
      showError(parseApiError(error), 'Unable to load username validation');
    } finally {
      setLoading(false);
    }
  }, [loadJobs, loadSetup, showError]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (!activeJob || !ACTIVE_STATUSES.has(activeJob.status)) return undefined;
    const timer = setInterval(async () => {
      try {
        const response = await listsAPI.getUsernameValidationJob(activeJob.id);
        const next = response.data?.data;
        if (!next) return;
        setActiveJob(next);
        setJobs((current) => current.map((job) => Number(job.id) === Number(next.id) ? next : job));
        if (!ACTIVE_STATUSES.has(next.status)) {
          const refreshed = await loadJobs();
          setJobs(refreshed);
          await loadSetup();
          onListsChanged?.();
          if (!notifiedTerminal.current.has(next.id)) {
            notifiedTerminal.current.add(next.id);
            if (next.status === 'completed') {
              showSuccess(
                `${next.validationMethod === 'link' ? 'Link check' : 'Validation'} finished with ${formatNumber(next.validCount)} valid usernames.`,
                'Validation complete'
              );
            } else if (next.status === 'exhausted') {
              showError(
                `All sessions were exhausted. ${formatNumber(next.validCount)} valid usernames were preserved for download.`,
                'Sessions exhausted'
              );
            }
          }
        }
      } catch (error) {
        // Keep the current snapshot visible. A later poll can recover.
        console.warn('Username validation poll failed', error);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [activeJob?.id, activeJob?.status, loadJobs, loadSetup, onListsChanged, showError, showSuccess]);

  const selectedSource = userLists.find((list) => Number(list.id) === Number(sourceListId));
  const selectedSessionLists = sessionLists.filter((list) =>
    selectedSessionListIds.includes(Number(list.id))
  );
  const selectedSessionCount = selectedSessionLists.reduce(
    (sum, list) => sum + Number(list.session_count || 0),
    0
  );

  const selectSource = (value) => {
    setSourceListId(value);
    const selected = userLists.find((list) => Number(list.id) === Number(value));
    if (selected) setResultListName(`${selected.name} - Valid Usernames`);
  };

  const startValidation = async () => {
    if (!sourceListId || selectedSessionListIds.length === 0 || !resultListName.trim()) {
      showError('Select a user list, at least one session list, and a result list name.', 'Missing selection');
      return;
    }
    setStarting(true);
    try {
      const response = await listsAPI.startUsernameValidation({
        sourceListId: Number(sourceListId),
        sessionListIds: selectedSessionListIds.map(Number),
        resultListName: resultListName.trim(),
        retryAfterFloodWait,
      });
      const job = response.data?.data;
      setActiveJob(job);
      await loadJobs();
      onListsChanged?.();
      showSuccess(
        `Job #${job.id} queued with ${formatNumber(job.totalCount)} unique usernames.`,
        'Validation started'
      );
    } catch (error) {
      showError(parseApiError(error), 'Unable to start validation');
    } finally {
      setStarting(false);
    }
  };

  const cancelValidation = async () => {
    if (!activeJob) return;
    setCancelling(true);
    try {
      const response = await listsAPI.cancelUsernameValidationJob(activeJob.id);
      setActiveJob(response.data?.data || activeJob);
      showSuccess(
        activeJob.validationMethod === 'link'
          ? 'Cancellation requested. Completed link checks and confirmed results will be preserved.'
          : 'Cancellation requested. The current Telegram lookup will finish safely.',
        'Stopping job'
      );
    } catch (error) {
      showError(parseApiError(error), 'Unable to cancel job');
    } finally {
      setCancelling(false);
    }
  };

  const runLinkFilter = async () => {
    if (!sourceListId || !resultListName.trim()) {
      showError('Select a user list and enter a result list name.', 'Missing selection');
      return;
    }
    setStarting(true);
    try {
      const response = await listsAPI.linkFilterUsernames({
        sourceListId: Number(sourceListId),
        resultListName: resultListName.trim(),
      });
      const job = response.data?.data;
      setActiveJob(job);
      await loadJobs();
      onListsChanged?.();
      showSuccess(
        `Job #${job.id} queued with ${formatNumber(job.totalCount)} unique usernames. You can leave this page; progress is saved.`,
        'Link check started'
      );
    } catch (error) {
      showError(parseApiError(error), 'Link filter failed');
    } finally {
      setStarting(false);
    }
  };

  const downloadResult = async (job, format) => {
    const key = `${job.id}:${format}`;
    setDownloading(key);
    try {
      const response = await listsAPI.exportList(job.resultListId, format);
      const type = format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/plain';
      const blob = new Blob([response.data], { type });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${String(job.resultListName || 'valid_usernames').replace(/\s+/g, '_')}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      showError(parseApiError(error), 'Result download failed');
    } finally {
      setDownloading('');
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-xl border border-white/5 bg-dark-800">
        <Loader2 className="h-7 w-7 animate-spin text-primary-400" />
      </div>
    );
  }

  const hasActiveJob = activeJob && ACTIVE_STATUSES.has(activeJob.status);
  const isLinkJob = activeJob?.validationMethod === 'link';

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border border-cyan-500/15 bg-dark-800 shadow-sm">
        <div className="border-b border-white/5 bg-gradient-to-r from-cyan-500/10 via-blue-500/5 to-transparent px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/10 p-2.5">
              <ShieldCheck className="h-5 w-5 text-cyan-300" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Telegram Username Validation</h2>
              <p className="mt-1 max-w-3xl text-sm leading-relaxed text-gray-400">
                {method === 'link'
                  ? 'Check each username against its public t.me web preview without Telegram sessions. Large checks run as saved background jobs with live progress, safe cancellation, and downloadable results.'
                  : 'Resolve every unique username through real Telegram sessions. This performs no DM, contact import, follow, or group action. Telegram-confirmed users are written to a separate downloadable list.'}
              </p>
            </div>
          </div>

          {/* Method selector */}
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setMethod('link')}
              disabled={hasActiveJob}
              className={`rounded-lg border p-3 text-left transition disabled:opacity-50 ${
                method === 'link'
                  ? 'border-cyan-500/60 bg-cyan-500/10'
                  : 'border-white/10 bg-dark-900 hover:border-white/20'
              }`}
            >
              <p className="text-sm font-medium text-white">Link check (no sessions)</p>
              <p className="mt-0.5 text-xs text-gray-400">
                Checks t.me/&lt;username&gt; in a persisted background job with multi-pass throttle recovery.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setMethod('session')}
              disabled={hasActiveJob}
              className={`rounded-lg border p-3 text-left transition disabled:opacity-50 ${
                method === 'session'
                  ? 'border-cyan-500/60 bg-cyan-500/10'
                  : 'border-white/10 bg-dark-900 hover:border-white/20'
              }`}
            >
              <p className="text-sm font-medium text-white">Live session resolve</p>
              <p className="mt-0.5 text-xs text-gray-400">
                Resolves through real Telegram sessions with automatic failover. Authoritative, slower.
              </p>
            </button>
          </div>
        </div>

        <div className="grid gap-4 p-5 lg:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              1. Source user list
            </label>
            <select
              value={sourceListId}
              onChange={(event) => selectSource(event.target.value)}
              disabled={hasActiveJob}
              className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2.5 text-sm text-white focus:border-cyan-500 focus:outline-none disabled:opacity-50"
            >
              <option value="">Choose a username list...</option>
              {userLists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name} ({formatNumber(list.itemsCount ?? list.items_count ?? list.itemCount)} rows)
                </option>
              ))}
            </select>
          </div>

          {method === 'session' && (
          <div className="lg:row-span-2">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              2. Session lists ({selectedSessionListIds.length} selected)
            </label>
            <SessionListSwitcher
              mode="list"
              onModeChange={() => {}}
              multiple
              listOnly
              selectedSessionListIds={selectedSessionListIds}
              onSelectedSessionListIdsChange={setSelectedSessionListIds}
              disabled={hasActiveJob}
            />
          </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              {method === 'session' ? '3. Valid result list' : '2. Valid result list'}
            </label>
            <input
              value={resultListName}
              onChange={(event) => setResultListName(event.target.value)}
              disabled={hasActiveJob}
              maxLength={255}
              placeholder="Validated Telegram users"
              className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none disabled:opacity-50"
            />
          </div>
          {method === 'session' && (
          <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
            retryAfterFloodWait
              ? 'border-violet-500/30 bg-violet-500/10'
              : 'border-white/10 bg-dark-900 hover:border-white/20'
          } ${hasActiveJob ? 'cursor-not-allowed opacity-60' : ''}`}>
            <input
              type="checkbox"
              checked={retryAfterFloodWait}
              onChange={(event) => setRetryAfterFloodWait(event.target.checked)}
              disabled={hasActiveJob}
              className="mt-0.5 rounded border-white/20 bg-dark-950 text-violet-500 focus:ring-violet-500"
            />
            <span>
              <span className="block text-sm font-medium text-white">Retry all sessions once after timeout</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-gray-500">
                If every session is exhausted and Telegram supplied a FLOOD_WAIT duration, wait for the earliest timeout,
                reset the selected sessions once, and continue from the first unprocessed username.
              </span>
            </span>
          </label>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-white/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-gray-500">
            {method === 'link'
              ? (selectedSource
                  ? `${formatNumber(selectedSource.itemsCount ?? selectedSource.items_count ?? selectedSource.itemCount)} source rows · checked against t.me web previews · no sessions used`
                  : 'No sessions used. Duplicates and rows without a username are skipped automatically.')
              : (selectedSource && selectedSessionListIds.length > 0
                  ? `${formatNumber(selectedSource.itemsCount ?? selectedSource.items_count ?? selectedSource.itemCount)} source rows · ${selectedSessionListIds.length} lists · up to ${formatNumber(selectedSessionCount)} sessions before de-duplication`
                  : 'Active Clean, Unknown, and SpamBot Limited sessions are allowed. Frozen sessions are excluded.')}
          </div>
          {method === 'link' ? (
            <button
              type="button"
              onClick={runLinkFilter}
              disabled={starting || hasActiveJob || !sourceListId || !resultListName.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <SearchCheck className="h-4 w-4" />}
              {starting ? 'Creating job...' : hasActiveJob ? 'Validation in progress' : 'Start link check'}
            </button>
          ) : (
            <button
              type="button"
              onClick={startValidation}
              disabled={starting || hasActiveJob || !sourceListId || selectedSessionListIds.length === 0 || !resultListName.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <SearchCheck className="h-4 w-4" />}
              {starting ? 'Creating job...' : hasActiveJob ? 'Validation in progress' : 'Start live validation'}
            </button>
          )}
        </div>
      </section>

      {activeJob && (
        <section className="rounded-xl border border-white/5 bg-dark-800 p-5 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-white">
                  {isLinkJob ? 'Link check' : 'Session validation'} job #{activeJob.id}
                </h2>
                <StatusBadge status={activeJob.status} />
                {activeJob.cancelRequested && ACTIVE_STATUSES.has(activeJob.status) && (
                  <span className="text-xs text-amber-300">Cancellation requested</span>
                )}
              </div>
              <p className="mt-1 text-sm text-gray-400">
                {activeJob.sourceListName} <span className="text-gray-600">to</span> {activeJob.resultListName}
              </p>
              <p className="mt-1 text-xs text-gray-500">
                {isLinkJob
                  ? `No Telegram sessions used; pass ${activeJob.currentPass || 0} of ${activeJob.maxPasses || 1}.`
                  : `${formatNumber(activeJob.selectedSessions?.length || 0)} unique sessions from ${formatNumber(activeJob.sessionListIds?.length || 1)} list(s); SpamBot Limited sessions remain eligible.`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <DownloadButtons job={activeJob} onDownload={downloadResult} downloading={downloading} />
              {hasActiveJob && (
                <button
                  type="button"
                  onClick={cancelValidation}
                  disabled={cancelling || activeJob.cancelRequested}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-50"
                >
                  {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <StopCircle className="h-3.5 w-3.5" />}
                  Stop safely
                </button>
              )}
            </div>
          </div>

          <div className="mt-5 h-2 overflow-hidden rounded-full bg-dark-950">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-500"
              style={{ width: `${Math.max(0, Math.min(100, isLinkJob && hasActiveJob ? activeJob.passProgressPct || 0 : activeJob.progressPct || 0))}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
            <span>
              {isLinkJob && hasActiveJob
                ? `Pass ${activeJob.currentPass || 0}: ${formatNumber(activeJob.passProcessedCount)} / ${formatNumber(activeJob.passTotalCount)} requests checked`
                : `${formatNumber(activeJob.handledCount)} / ${formatNumber(activeJob.totalCount)} unique usernames handled`}
            </span>
            <span>{isLinkJob && hasActiveJob ? activeJob.passProgressPct || 0 : activeJob.progressPct || 0}%</span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Valid" value={activeJob.validCount} tone="text-emerald-300" />
            <Metric label="Invalid" value={activeJob.invalidCount} tone="text-red-300" />
            <Metric label={isLinkJob ? 'Requests' : 'Remaining'} value={isLinkJob ? activeJob.totalRequests : Math.max(0, activeJob.totalCount - activeJob.handledCount)} tone="text-blue-300" />
            <Metric label="Ignored rows" value={activeJob.ignoredCount} tone="text-gray-300" />
            <Metric label="Duplicates" value={activeJob.duplicateCount} tone="text-amber-300" />
            <Metric label={isLinkJob ? 'Current pass' : 'Sessions retired'} value={isLinkJob ? activeJob.currentPass : activeJob.retiredSessions?.length || 0} tone="text-orange-300" />
          </div>

          {hasActiveJob && activeJob.currentUsername && (
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-blue-500/15 bg-blue-500/5 px-3 py-2 text-xs text-blue-200">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {isLinkJob ? 'Checking' : 'Resolving'} <span className="font-mono font-semibold">@{activeJob.currentUsername}</span>
              {!isLinkJob && <>with session <span className="font-mono">#{activeJob.currentSessionId}</span></>}
            </div>
          )}

          {activeJob.status === 'waiting' && activeJob.retryAt && (
            <div className="mt-4 flex gap-2 rounded-lg border border-violet-500/20 bg-violet-500/5 p-3 text-sm text-violet-200">
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              Waiting until {new Date(activeJob.retryAt).toLocaleString()} for the one-time session retry. The job will resume from the next unprocessed username automatically.
            </div>
          )}

          {activeJob.errorMessage && (
            <div className="mt-4 flex gap-2 rounded-lg border border-orange-500/20 bg-orange-500/5 p-3 text-sm text-orange-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {activeJob.errorMessage}
            </div>
          )}

          {activeJob.retiredSessions?.length > 0 && (
            <div className="mt-5">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Retired sessions</h3>
              <div className="grid gap-2 md:grid-cols-2">
                {activeJob.retiredSessions.map((session) => (
                  <div key={session.id} className="rounded-lg border border-orange-500/15 bg-orange-500/5 px-3 py-2">
                    <div className="flex items-center gap-2 text-xs font-medium text-orange-200">
                      <Ban className="h-3.5 w-3.5" /> Session #{session.id} · {session.code || 'SESSION_FAILURE'}
                    </div>
                    <div className="mt-1 truncate text-[11px] text-gray-500" title={session.message}>
                      {session.message || 'Telegram session could not continue'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeJob.recentItems?.length > 0 && (
            <div className="mt-5 overflow-hidden rounded-lg border border-white/5">
              <div className="border-b border-white/5 bg-dark-900 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                Latest checks
              </div>
              <div className="max-h-64 divide-y divide-white/5 overflow-y-auto">
                {activeJob.recentItems.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    {item.status === 'valid' ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                    ) : item.status === 'invalid' ? (
                      <XCircle className="h-4 w-4 shrink-0 text-red-400" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-gray-200">@{item.username}</span>
                    <span className="hidden text-xs text-gray-500 sm:block">{isLinkJob ? 'public t.me' : `session #${item.sessionId || 'none'}`}</span>
                    <span className={`text-xs font-medium capitalize ${item.status === 'valid' ? 'text-emerald-300' : item.status === 'invalid' ? 'text-red-300' : 'text-amber-300'}`}>
                      {item.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="rounded-xl border border-white/5 bg-dark-800 shadow-sm">
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-white">Validation history</h2>
            <p className="mt-0.5 text-xs text-gray-500">Result downloads remain available for completed, stopped, and exhausted jobs.</p>
          </div>
          <button
            type="button"
            onClick={loadInitial}
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        {jobs.length === 0 ? (
          <div className="py-12 text-center">
            <SearchCheck className="mx-auto h-8 w-8 text-gray-600" />
            <p className="mt-2 text-sm text-gray-400">No username validation jobs yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {jobs.map((job) => (
              <div key={job.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <div className="rounded-lg bg-white/5 p-2">
                    <Users className="h-4 w-4 text-gray-400" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const response = await listsAPI.getUsernameValidationJob(job.id);
                            setActiveJob(response.data?.data || job);
                          } catch (error) {
                            showError(parseApiError(error), 'Unable to load job');
                          }
                        }}
                        className="font-medium text-white hover:text-cyan-300"
                      >
                        Job #{job.id}
                      </button>
                      <StatusBadge status={job.status} />
                    </div>
                    <div className="mt-1 truncate text-xs text-gray-500">
                       {job.sourceListName} · {job.validationMethod === 'link' ? 'Link check (no sessions)' : (job.sessionListNames || [job.sessionListName]).join(', ')} · {formatRelativeTime(job.createdAt)}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
                  <span className="text-emerald-300">{formatNumber(job.validCount)} valid</span>
                  <span className="text-red-300">{formatNumber(job.invalidCount)} invalid</span>
                  <span className="text-gray-400">
                    {job.validationMethod === 'link' && ACTIVE_STATUSES.has(job.status)
                      ? `pass ${job.currentPass || 0}/${job.maxPasses || 1} · ${job.passProgressPct || 0}%`
                      : `${job.progressPct}% handled`}
                  </span>
                  <DownloadButtons job={job} onDownload={downloadResult} downloading={downloading} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="rounded-lg border border-white/5 bg-dark-900/50 px-4 py-3 text-xs leading-relaxed text-gray-500">
        <div className="flex items-start gap-2">
          <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {method === 'link'
            ? 'Telegram can silently throttle public t.me pages. Link jobs pace requests, pause on suspected throttling, and re-check unresolved usernames across multiple passes while preserving confirmed results.'
            : 'Telegram may rate-limit repeated lookups. When that happens the panel retires only that session for this job, retries the same username with the next selected session, and preserves every previously confirmed result.'}
        </div>
      </div>
    </div>
  );
}
