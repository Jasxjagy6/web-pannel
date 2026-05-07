/**
 * ClearChatsHistoryTab — History view for the bulk "Delete chats" job
 * runs kicked off from the Telegram → Login page.
 *
 * The Delete chats action used to be synchronous: the user clicked
 * "Confirm", the modal stayed open, and the request blocked until every
 * dialog of every selected session was wiped. With 100+ sessions that
 * was both slow and fragile (refresh / nav cancelled the call).
 *
 * The new flow is job-based: the controller creates an in-memory job
 * and returns the id immediately, the modal closes, and this tab
 * renders the per-job per-session progress. Live updates flow over the
 * per-user `tg-client:clearJobUpdate` socket event; we also pull the
 * REST list on mount so refreshing the page restores history.
 *
 * Each job card surfaces:
 *   - status pill (queued / running / done / partial / failed)
 *   - aggregate progress bar (done / total dialogs across all sessions)
 *   - a roll-up of "X cleared · Y left · Z deleted"
 *   - timestamps (relative + absolute on hover)
 *   - per-session breakdown (expandable) with the same numbers + the
 *     dialog currently being processed and any per-session error.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Hourglass,
  Loader2,
  PauseCircle,
  RefreshCcw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useWebSocket } from '../../hooks/useWebSocket';
import {
  listClearChatsJobs,
  getClearChatsJob,
} from '../../api/telegramClient';

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function _fmtAbs(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch (_) {
    return '';
  }
}

function _fmtRel(ts, nowMs) {
  if (!ts) return '';
  const diff = Math.max(0, (nowMs || Date.now()) - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function _fmtDuration(start, end) {
  if (!start) return '';
  const stop = end || Date.now();
  const ms = Math.max(0, stop - start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

const STATUS_META = {
  queued: {
    label: 'Queued',
    tone: 'bg-white/5 text-gray-300 border-white/10',
    Icon: Hourglass,
    spin: false,
  },
  running: {
    label: 'Running',
    tone: 'bg-blue-500/10 text-blue-200 border-blue-500/30',
    Icon: Loader2,
    spin: true,
  },
  done: {
    label: 'Completed',
    tone: 'bg-emerald-500/10 text-emerald-200 border-emerald-500/30',
    Icon: CheckCircle2,
    spin: false,
  },
  partial: {
    label: 'Partial',
    tone: 'bg-amber-500/10 text-amber-200 border-amber-500/30',
    Icon: AlertTriangle,
    spin: false,
  },
  failed: {
    label: 'Failed',
    tone: 'bg-red-500/10 text-red-200 border-red-500/30',
    Icon: XCircle,
    spin: false,
  },
};

function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.queued;
  const Icon = meta.Icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.tone}`}
    >
      <Icon className={`h-3 w-3 ${meta.spin ? 'animate-spin' : ''}`} />
      {meta.label}
    </span>
  );
}

function _sessionPill(s) {
  if (!s) return STATUS_META.queued;
  return STATUS_META[s.status] || STATUS_META.queued;
}

function ProgressBar({ done, total, status }) {
  const pct =
    total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const tone =
    status === 'failed'
      ? 'bg-red-500'
      : status === 'partial'
        ? 'bg-amber-500'
        : status === 'done'
          ? 'bg-emerald-500'
          : 'bg-blue-500';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className={`h-full ${tone} transition-[width] duration-500`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* per-session row inside an expanded job card                        */
/* ------------------------------------------------------------------ */

function SessionRow({ session, revoke }) {
  const meta = _sessionPill(session);
  const Icon = meta.Icon;
  const hasTotal = (session.total || 0) > 0;
  const breakdownParts = [];
  if (session.cleared) breakdownParts.push(`${session.cleared} cleared`);
  if (session.left) breakdownParts.push(`${session.left} left`);
  if (session.deleted) breakdownParts.push(`${session.deleted} deleted`);
  if (session.bots) breakdownParts.push(`${session.bots} bot${session.bots === 1 ? '' : 's'}`);
  const summary = hasTotal
    ? `${session.done || 0} / ${session.total || 0} processed`
    : session.status === 'queued'
      ? 'Waiting…'
      : session.status === 'running'
        ? 'Scanning dialogs…'
        : 'No chats';

  return (
    <li className="rounded-lg border border-white/10 bg-dark-900/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-gray-100">
              {session.displayName || `Session #${session.sessionId}`}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${meta.tone}`}
            >
              <Icon className={`h-3 w-3 ${meta.spin ? 'animate-spin' : ''}`} />
              {meta.label}
            </span>
          </div>
          <div className="truncate text-[11px] text-gray-500">
            {session.phone ? `${session.phone} · ` : ''}#{session.sessionId}
          </div>
        </div>
        <div className="shrink-0 text-right text-[11px] text-gray-400">
          {summary}
        </div>
      </div>

      {hasTotal && (
        <div className="mt-2">
          <ProgressBar
            done={session.done || 0}
            total={session.total || 0}
            status={session.status}
          />
        </div>
      )}

      {(session.status === 'running' && session.currentTitle) && (
        <p className="mt-1.5 truncate text-[11px] text-blue-200/90" title={session.currentTitle}>
          Processing: {session.currentTitle}
        </p>
      )}

      {breakdownParts.length > 0 && (
        <p className="mt-1.5 text-[11px] text-gray-400">
          {breakdownParts.join(' · ')}
          {session.failed
            ? ` · ${session.failed} failed`
            : ''}
        </p>
      )}

      {session.error && (
        <p
          className="mt-1.5 truncate text-[11px] text-red-300/80"
          title={session.error}
        >
          {session.error}
          {session.code ? ` · ${session.code}` : ''}
        </p>
      )}

      {!hasTotal && !session.error && session.status === 'done' && (
        <p className="mt-1.5 text-[11px] text-gray-500">
          No dialogs to {revoke ? 'wipe' : 'clear'} for this session.
        </p>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* job card                                                           */
/* ------------------------------------------------------------------ */

function JobCard({ job, defaultExpanded, nowMs }) {
  const [expanded, setExpanded] = useState(!!defaultExpanded);

  const totals = job.totals || {};
  const totalDialogs = totals.totalDialogs || 0;
  const done = totals.done || 0;
  const succeeded = totals.succeeded || 0;
  const failed = totals.failed || 0;
  const cleared = totals.cleared || 0;
  const left = totals.left || 0;
  const deleted = totals.deleted || 0;
  const bots = totals.bots || 0;
  const completedSessions = totals.completedSessions || 0;
  const totalSessions = totals.totalSessions || (job.sessions || []).length;

  const breakdownParts = [];
  if (cleared) breakdownParts.push(`${cleared} cleared`);
  if (left) breakdownParts.push(`${left} left`);
  if (deleted) breakdownParts.push(`${deleted} deleted`);
  if (bots) breakdownParts.push(`${bots} bot${bots === 1 ? '' : 's'} removed`);
  if (failed) breakdownParts.push(`${failed} failed`);

  const inProgressSession = useMemo(
    () => (job.sessions || []).find((s) => s.status === 'running'),
    [job.sessions],
  );

  const startedAt = job.startedAt || job.createdAt;
  const finishedAt = job.finishedAt;
  const duration =
    startedAt && (finishedAt || job.status === 'running')
      ? _fmtDuration(startedAt, finishedAt)
      : '';

  return (
    <li className="overflow-hidden rounded-xl border border-white/10 bg-dark-900/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-3 text-left transition-colors hover:bg-white/[0.025]"
        aria-expanded={expanded}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={job.status} />
              <span className="truncate text-sm font-semibold text-gray-100">
                {totalSessions} session{totalSessions === 1 ? '' : 's'} ·{' '}
                {job.revoke ? 'Both sides' : 'For me'}
              </span>
              <span className="font-mono text-[10px] text-gray-500">
                {job.id}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
              <span className="inline-flex items-center gap-1" title={_fmtAbs(job.createdAt)}>
                <Clock className="h-3 w-3 opacity-80" />
                Started {_fmtRel(job.createdAt, nowMs)}
              </span>
              {duration && (
                <span className="inline-flex items-center gap-1">
                  <Hourglass className="h-3 w-3 opacity-80" />
                  {job.status === 'running' ? `Running ${duration}` : `Took ${duration}`}
                </span>
              )}
              <span>
                {completedSessions} / {totalSessions} sessions complete
              </span>
            </div>
            {breakdownParts.length > 0 && (
              <p className="mt-1 truncate text-[11px] text-gray-300">
                {breakdownParts.join(' · ')}
              </p>
            )}
            {inProgressSession && (
              <p className="mt-0.5 truncate text-[11px] text-blue-200/90">
                {inProgressSession.displayName || `Session #${inProgressSession.sessionId}`}
                {inProgressSession.currentTitle
                  ? ` · ${inProgressSession.currentTitle}`
                  : ' · scanning…'}
              </p>
            )}
          </div>
          <div className="shrink-0 self-start pt-0.5 text-gray-500">
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <div className="flex-1">
            <ProgressBar done={done} total={totalDialogs} status={job.status} />
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-gray-400">
            {totalDialogs > 0
              ? `${done} / ${totalDialogs}`
              : job.status === 'queued'
                ? 'Queued'
                : job.status === 'running'
                  ? 'Scanning…'
                  : 'No chats'}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/10 bg-black/20 px-4 py-3">
          {(job.sessions || []).length === 0 ? (
            <p className="text-xs text-gray-400">No sessions in this job.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {job.sessions.map((s) => (
                <SessionRow
                  key={s.sessionId}
                  session={s}
                  revoke={job.revoke}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* tab                                                                */
/* ------------------------------------------------------------------ */

export default function ClearChatsHistoryTab({ initialJob, autoExpandJobId }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  // Tick once a second so the relative timestamps don't get stuck.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const seedRef = useRef(null);
  if (initialJob && seedRef.current !== initialJob.id) {
    seedRef.current = initialJob.id;
  }

  const _mergeJob = useCallback((next) => {
    if (!next || !next.id) return;
    setJobs((prev) => {
      const idx = prev.findIndex((j) => j.id === next.id);
      if (idx === -1) return [next, ...prev];
      const copy = prev.slice();
      copy[idx] = next;
      return copy;
    });
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const { data } = await listClearChatsJobs(50);
      const list = data?.data?.jobs || [];
      setJobs(list);
      setError(null);
    } catch (err) {
      setError(
        err?.response?.data?.error ||
          err?.message ||
          'Failed to load history.',
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Seed from the page's just-created job so the card shows up before
  // the first socket event arrives.
  useEffect(() => {
    if (initialJob) _mergeJob(initialJob);
  }, [initialJob, _mergeJob]);

  // Hydrate full snapshot for the auto-expanded job (e.g. just created
  // from the modal) so the user immediately sees per-session detail.
  useEffect(() => {
    if (!autoExpandJobId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await getClearChatsJob(autoExpandJobId);
        const job = data?.data?.job;
        if (!cancelled && job) _mergeJob(job);
      } catch (_) {
        /* ignore — list refresh will fill it in */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoExpandJobId, _mergeJob]);

  // Per-user job-feed socket subscription. The backend auto-joins the
  // panel socket to `tg-client:u<userId>:jobs` on connect.
  const ws = useWebSocket();
  const { connect, on } = ws;
  useEffect(() => {
    const token = (() => {
      try {
        return localStorage.getItem('token');
      } catch (_) {
        return null;
      }
    })();
    if (token) connect(token);
  }, [connect]);

  useEffect(() => {
    const handler = (snap) => {
      if (!snap || !snap.id) return;
      _mergeJob(snap);
    };
    const off = on?.('tg-client:clearJobUpdate', handler);
    return off;
  }, [on, _mergeJob]);

  const sortedJobs = useMemo(() => {
    return jobs
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [jobs]);

  const summary = useMemo(() => {
    let running = 0;
    for (const j of jobs) {
      if (j.status === 'running' || j.status === 'queued') running += 1;
    }
    return { running };
  }, [jobs]);

  return (
    <section className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">
            Delete-chats history
          </h2>
          <p className="text-xs text-gray-400">
            {summary.running > 0
              ? `${summary.running} job${summary.running === 1 ? '' : 's'} in progress · live updates flow over Socket.IO.`
              : 'Most recent jobs first. Live updates flow over Socket.IO.'}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-dark-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-sm text-gray-400">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading history…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
          {error}
        </div>
      ) : sortedJobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-white/10 bg-dark-900/60 p-10 text-center text-sm text-gray-400">
          <PauseCircle className="h-8 w-8 text-gray-500" />
          <div>
            <p className="font-medium text-gray-200">
              No delete-chats jobs yet.
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Pick one or more sessions on the{' '}
              <span className="font-medium text-gray-300">Sessions</span> tab
              and press{' '}
              <span className="inline-flex items-center gap-1 align-middle text-gray-300">
                <Trash2 className="h-3 w-3" />
                Delete chats
              </span>{' '}
              to start one.
            </p>
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {sortedJobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              defaultExpanded={job.id === autoExpandJobId}
              nowMs={nowMs}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
