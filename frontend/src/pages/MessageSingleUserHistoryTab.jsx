import { useEffect, useState, useCallback, useRef } from 'react';
import { useToast } from '../components/common/Toast';
import { getJobs, cancelJob } from '../api/messages';
import { parseApiError, formatRelativeTime } from '../utils/formatters';
import {
  History,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
  RefreshCw,
  StopCircle,
  Send,
  Users,
  AtSign,
  Timer,
} from 'lucide-react';

// History tab for the Single-User Mass DM feature.
//
// Lists the caller's `messaging_jobs` rows with `job_type =
// 'single_user_mass_dm'`, polling every few seconds while at least one
// job is still pending/running so progress counters move in real time.
const POLL_INTERVAL_MS = 4000;
const PAGE_SIZE = 25;

function statusBadge(status) {
  if (status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-400">
        <CheckCircle className="h-3 w-3" />
        Completed
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-400">
        <Loader2 className="h-3 w-3 animate-spin" />
        Running
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/15 px-2 py-0.5 text-xs font-medium text-yellow-400">
        <Clock className="h-3 w-3" />
        Pending
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-400">
        <XCircle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  if (status === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-500/15 px-2 py-0.5 text-xs font-medium text-gray-400">
        <AlertCircle className="h-3 w-3" />
        Cancelled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-500/15 px-2 py-0.5 text-xs font-medium text-gray-400">
      {status || 'unknown'}
    </span>
  );
}

export default function MessageSingleUserHistoryTab({ refreshKey }) {
  const { error: showError, success: showSuccess } = useToast();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const pollTimer = useRef(null);

  const fetchHistory = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setRefreshing(true);
    try {
      const response = await getJobs({
        page: 1,
        limit: PAGE_SIZE,
        jobType: 'single_user_mass_dm',
      });
      setJobs(response.data.data?.jobs || []);
    } catch (err) {
      if (!silent) {
        showError(parseApiError(err), 'Failed to load history');
      } else {
        // eslint-disable-next-line no-console
        console.warn('Failed to refresh single-user mass DM history:', parseApiError(err));
      }
    } finally {
      setLoading(false);
      if (!silent) setRefreshing(false);
    }
  }, [showError]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory, refreshKey]);

  // Poll while any job is still in-flight.
  useEffect(() => {
    const hasActive = jobs.some(
      (j) => j.status === 'pending' || j.status === 'running'
    );
    if (!hasActive) {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    if (pollTimer.current) return;
    pollTimer.current = setInterval(() => {
      fetchHistory({ silent: true });
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [jobs, fetchHistory]);

  const handleCancel = async (jobId) => {
    try {
      await cancelJob(jobId);
      showSuccess(`Job #${jobId} cancellation requested.`, 'Cancelled');
      fetchHistory({ silent: true });
    } catch (err) {
      showError(parseApiError(err), 'Failed to cancel job');
    }
  };

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800 shadow-sm">
      <div className="flex items-center justify-between border-b border-white/5 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <History className="h-4 w-4 text-primary-500" />
          Single-User Mass DM History
        </h3>
        <button
          type="button"
          onClick={() => fetchHistory()}
          disabled={refreshing}
          className="flex items-center gap-1 text-xs text-primary-400 hover:text-primary-300 disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </button>
      </div>

      <div className="divide-y divide-white/5">
        {loading ? (
          <div className="py-16 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary-500" />
            <p className="mt-3 text-sm text-gray-400">Loading history...</p>
          </div>
        ) : jobs.length === 0 ? (
          <div className="py-16 text-center">
            <History className="mx-auto mb-3 h-10 w-10 text-gray-600" />
            <p className="text-sm text-gray-400">No Single-User Mass DM jobs yet.</p>
            <p className="mt-1 text-xs text-gray-500">
              Use the Single User tab to fan out a DM across all your sessions.
            </p>
          </div>
        ) : (
          jobs.map((job) => (
            <JobRow key={job.id} job={job} onCancel={handleCancel} />
          ))
        )}
      </div>
    </div>
  );
}

function JobRow({ job, onCancel }) {
  // The list endpoint now returns a preview of the job's target_list
  // (the actual usernames/IDs the job ran against). For single-user
  // mass DM jobs the list is small (1..3) so we render it inline; for
  // bulk jobs the backend caps the preview at 25 entries and exposes
  // `targetsTruncated` so we know to show a "+N more" pill.
  const opts = job.options || {};
  const total = job.totalCount ?? 0;
  const sent = job.sentCount ?? 0;
  const failed = job.failedCount ?? 0;
  const skipped = job.skippedCount ?? 0;
  const progress = total > 0 ? ((sent + failed + skipped) / total) * 100 : 0;
  const cancellable = job.status === 'pending' || job.status === 'running';

  // Single-user mass DM persists `target_list` as a JSON array of
  // strings; surface them so the operator can see exactly *who* the
  // job DM'd straight from the History row.
  const targets = Array.isArray(job.targets) ? job.targets : [];
  const targetCount = job.targetCount ?? opts.targetCount ?? targets.length;
  const truncatedRemainder =
    job.targetsTruncated && targetCount > targets.length
      ? targetCount - targets.length
      : 0;

  return (
    <div className="space-y-2 p-4 hover:bg-white/[0.02]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-white">Job #{job.id}</span>
          {statusBadge(job.status)}
        </div>
        {cancellable && (
          <button
            type="button"
            onClick={() => onCancel(job.id)}
            className="inline-flex items-center gap-1 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-500/20"
          >
            <StopCircle className="h-3 w-3" />
            Cancel
          </button>
        )}
      </div>

      {targets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-gray-500">
            Targets:
          </span>
          {targets.map((t, idx) => (
            <span
              key={`${job.id}-target-${idx}-${String(t)}`}
              className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-dark-900 px-2 py-0.5 font-mono text-xs text-primary-300"
              title={String(t)}
            >
              <AtSign className="h-3 w-3 opacity-60" />
              {String(t)}
            </span>
          ))}
          {truncatedRemainder > 0 && (
            <span className="rounded-md border border-white/10 bg-dark-900 px-2 py-0.5 text-xs text-gray-400">
              +{truncatedRemainder} more
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
        <span className="inline-flex items-center gap-1">
          <Send className="h-3 w-3" />
          {sent}/{total} sent
        </span>
        {failed > 0 && (
          <span className="inline-flex items-center gap-1 text-red-400">
            <XCircle className="h-3 w-3" />
            {failed} failed
          </span>
        )}
        {skipped > 0 && (
          <span className="inline-flex items-center gap-1 text-gray-500">
            <Clock className="h-3 w-3" />
            {skipped} skipped
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <AtSign className="h-3 w-3" />
          {targetCount ?? '?'} target(s)
        </span>
        <span className="inline-flex items-center gap-1">
          <Users className="h-3 w-3" />
          {Array.isArray(opts.sessionIds) ? opts.sessionIds.length : '?'} session(s)
        </span>
        <span className="inline-flex items-center gap-1">
          <Timer className="h-3 w-3" />
          {opts.delaySeconds ?? '?'}s delay
        </span>
        <span>{formatRelativeTime(job.createdAt)}</span>
        {job.completedAt && <span>· done {formatRelativeTime(job.completedAt)}</span>}
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-dark-900">
        <div
          className="h-1.5 rounded-full bg-primary-600 transition-all duration-500"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>

      {job.messageContent && (
        <p className="line-clamp-2 text-sm text-gray-300">
          {job.messageContent}
        </p>
      )}
    </div>
  );
}
