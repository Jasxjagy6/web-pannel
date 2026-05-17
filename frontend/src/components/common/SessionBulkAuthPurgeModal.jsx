import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  ShieldOff,
  X,
} from 'lucide-react';

import { Modal } from './Modal';
import { useToast } from './Toast';
import {
  cancelBulkAuthPurge,
  getBulkAuthPurgeStatus,
  startBulkAuthPurge,
} from '../../api/sessions';
import { parseApiError } from '../../utils/formatters';

/**
 * SessionBulkAuthPurgeModal
 *
 * UX for the Sessions page "Terminate Other Sessions" button.
 *
 *   1. Operator confirms which panel sessions will have their
 *      "other" Telegram authorizations terminated.
 *   2. Operator clicks "Start". The modal polls
 *      /bulk-auth-purge/status and shows per-session progress:
 *      queued → listing → purging → completed / partial / failed /
 *      no_others.
 *   3. Each row expands to show the full list of devices Telegram
 *      reported for that account, with a per-device status pill —
 *      "Kept (this panel)" for the current authorization,
 *      "Terminated" for each non-current one we killed,
 *      "Failed" with the error reason, or "Skipped" when Telegram
 *      refuses to reset an authorization younger than 24h.
 *   4. The bottom summary tracks succeeded / partial / failed
 *      counts and a device-level total.
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function SessionStatusPill({ status }) {
  let label;
  let cls;
  if (status === 'completed') {
    label = 'Done';
    cls = 'bg-green-500/10 border-green-500/40 text-green-300';
  } else if (status === 'partial') {
    label = 'Partial';
    cls = 'bg-amber-500/10 border-amber-500/40 text-amber-300';
  } else if (status === 'no_others') {
    label = 'No others';
    cls = 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300';
  } else if (status === 'failed') {
    label = 'Failed';
    cls = 'bg-red-500/10 border-red-500/40 text-red-300';
  } else if (status === 'queued') {
    label = 'Queued';
    cls = 'bg-gray-500/10 border-gray-500/30 text-gray-300';
  } else if (status === 'listing') {
    label = 'Listing';
    cls = 'bg-blue-500/10 border-blue-500/30 text-blue-300';
  } else if (status === 'purging') {
    label = 'Purging';
    cls = 'bg-primary-500/10 border-primary-500/40 text-primary-300';
  } else if (status === 'cancelled') {
    label = 'Cancelled';
    cls = 'bg-amber-500/10 border-amber-500/30 text-amber-300';
  } else {
    label = String(status || '').replace(/_/g, ' ');
    cls = 'bg-primary-500/10 border-primary-500/40 text-primary-300';
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

function DeviceStatusPill({ status, isCurrent }) {
  let label;
  let cls;
  if (isCurrent) {
    label = 'Kept (this panel)';
    cls = 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300';
  } else if (status === 'terminated') {
    label = 'Terminated';
    cls = 'bg-green-500/10 border-green-500/40 text-green-300';
  } else if (status === 'terminating') {
    label = 'Terminating';
    cls = 'bg-primary-500/10 border-primary-500/40 text-primary-300';
  } else if (status === 'failed') {
    label = 'Failed';
    cls = 'bg-red-500/10 border-red-500/40 text-red-300';
  } else if (status === 'skipped') {
    label = 'Skipped < 24h';
    cls = 'bg-amber-500/10 border-amber-500/40 text-amber-300';
  } else if (status === 'queued') {
    label = 'Queued';
    cls = 'bg-gray-500/10 border-gray-500/30 text-gray-300';
  } else if (status === 'cancelled') {
    label = 'Cancelled';
    cls = 'bg-amber-500/10 border-amber-500/30 text-amber-300';
  } else {
    label = String(status || '');
    cls = 'bg-primary-500/10 border-primary-500/40 text-primary-300';
  }
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

function SessionRow({ s, defaultExpanded }) {
  const [expanded, setExpanded] = useState(!!defaultExpanded);
  const Icon = expanded ? ChevronDown : ChevronRight;
  const devices = Array.isArray(s.devices) ? s.devices : [];
  const killed = devices.filter((d) => d.status === 'terminated').length;
  const failed = devices.filter((d) => d.status === 'failed').length;
  const skipped = devices.filter((d) => d.status === 'skipped').length;
  return (
    <div className="p-2.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-3 w-3 text-gray-500 shrink-0" />
          <span className="truncate text-sm font-medium text-gray-100">
            {s.phone || `session-${s.sessionId}`}
          </span>
          <SessionStatusPill status={s.status} />
        </div>
        <div className="flex items-center gap-2 text-[10px] text-gray-500">
          {devices.length > 0 && (
            <span>
              {killed} killed · {failed} fail · {skipped} skip · {devices.length} total
            </span>
          )}
          <span>{s.progress}%</span>
        </div>
      </button>
      <div className="mt-1 h-1 w-full overflow-hidden rounded bg-dark-700">
        <div
          className={`h-full transition-all ${
            s.status === 'failed'
              ? 'bg-red-500'
              : s.status === 'completed' || s.status === 'no_others'
              ? 'bg-green-500'
              : s.status === 'partial'
              ? 'bg-amber-500'
              : 'bg-primary-500'
          }`}
          style={{ width: `${s.progress}%` }}
        />
      </div>
      {s.error && (
        <p className="mt-1 truncate text-[11px] text-red-300" title={s.error}>
          {s.error}
        </p>
      )}
      {expanded && (
        <div className="mt-2 space-y-1 rounded border border-white/5 bg-dark-950 p-2">
          {devices.length === 0 ? (
            <p className="text-[11px] italic text-gray-500">
              No devices listed yet — waiting for Telegram&apos;s response.
            </p>
          ) : (
            devices.map((d) => (
              <div
                key={d.hash}
                className="flex items-center justify-between gap-2"
              >
                <span
                  className="truncate text-[11px] text-gray-300"
                  title={d.label}
                >
                  {d.label}
                </span>
                <div className="flex items-center gap-2">
                  {d.error && (
                    <span
                      className="max-w-[200px] truncate text-[10px] text-red-300/80"
                      title={d.error}
                    >
                      {d.error}
                    </span>
                  )}
                  <DeviceStatusPill status={d.status} isCurrent={d.isCurrent} />
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function SessionBulkAuthPurgeModal({
  isOpen,
  onClose,
  selectedSessions,
  onCompleted,
}) {
  const [job, setJob] = useState(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef(null);
  const completedNotifiedRef = useRef(false);
  const { success: showSuccess, error: showError, info: showInfo } = useToast();

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      setJob(null);
      setStarting(false);
      completedNotifiedRef.current = false;
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [isOpen]);

  const startPolling = (jobId) => {
    if (pollRef.current) clearInterval(pollRef.current);
    const tick = async () => {
      try {
        const res = await getBulkAuthPurgeStatus(jobId);
        const data = res.data || res;
        setJob(data);
        if (data && TERMINAL_STATUSES.has(data.status)) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          if (!completedNotifiedRef.current) {
            completedNotifiedRef.current = true;
            const s = data.summary || {};
            if (data.status === 'completed') {
              if (s.failed > 0 || s.partial > 0) {
                showError(
                  `${s.completed || 0} done, ${s.partial || 0} partial, ${s.failed || 0} failed (${s.devicesTerminated || 0} devices terminated).`,
                  'Auth purge partial'
                );
              } else {
                showSuccess(
                  `${s.devicesTerminated || 0} device(s) terminated across ${s.completed || 0} session(s).`,
                  'Auth purge complete'
                );
              }
            } else if (data.status === 'cancelled') {
              showInfo('Bulk auth purge cancelled.', 'Cancelled');
            }
            if (typeof onCompleted === 'function') {
              try {
                onCompleted(data);
              } catch (_) {
                /* best-effort */
              }
            }
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('bulk-auth-purge status poll failed', err);
      }
    };
    tick();
    pollRef.current = setInterval(tick, 1500);
  };

  const start = async () => {
    setStarting(true);
    try {
      const res = await startBulkAuthPurge({
        sessionIds: selectedSessions.map((s) => s.id),
      });
      const data = res.data || res;
      if (!data || !data.jobId) {
        throw new Error('Server did not return a jobId');
      }
      showInfo(
        `Purging other sessions for ${selectedSessions.length} account(s)…`,
        'Auth purge started'
      );
      startPolling(data.jobId);
    } catch (err) {
      showError(parseApiError(err), 'Failed to start auth purge');
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!job?.jobId) {
      onClose();
      return;
    }
    try {
      await cancelBulkAuthPurge(job.jobId);
      showInfo('Auth purge cancelled.', 'Cancelled');
    } catch (err) {
      showError(parseApiError(err), 'Cancel failed');
    } finally {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      onClose();
    }
  };

  const headerCount = selectedSessions.length;
  const isRunning = job && !TERMINAL_STATUSES.has(job.status);

  return (
    <Modal
      isOpen={isOpen}
      onClose={isRunning ? () => {} : onClose}
      title="Terminate Other Sessions"
      size="lg"
      footer={
        <div className="flex w-full items-center justify-between">
          <span className="text-xs text-gray-500">
            For each selected account, lists every device signed in and
            terminates every one except this panel&apos;s own login.
          </span>
          <div className="flex gap-2">
            {!job && (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-white/10 bg-dark-800 px-4 py-2 text-sm text-gray-300 hover:bg-dark-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={starting || headerCount === 0}
                  onClick={start}
                  className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                >
                  {starting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldOff className="h-4 w-4" />
                  )}
                  Terminate others on {headerCount} account
                  {headerCount === 1 ? '' : 's'}
                </button>
              </>
            )}
            {job && isRunning && (
              <button
                type="button"
                onClick={cancel}
                className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300 hover:bg-red-500/20"
              >
                <X className="h-4 w-4" /> Cancel job
              </button>
            )}
            {job && TERMINAL_STATUSES.has(job.status) && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-500"
              >
                Done
              </button>
            )}
          </div>
        </div>
      }
    >
      {!job && (
        <div className="space-y-4">
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-200">
            <p className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-3.5 w-3.5" />
              What this does
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-red-100/90">
              <li>
                For each selected account, asks Telegram for the full list of
                devices currently signed in (account.getAuthorizations).
              </li>
              <li>
                Calls account.resetAuthorization(hash) on every device{' '}
                <span className="font-semibold">except</span> this panel&apos;s
                own login. Any other place that was logged into that account
                — phones, desktops, web sessions — gets kicked.
              </li>
              <li>
                Authorizations younger than 24 hours are reported as{' '}
                <span className="font-semibold">Skipped</span> — Telegram
                refuses to reset them. Re-run after 24h to clear them.
              </li>
              <li>
                Runs sequentially with brief delays so we don&apos;t trip
                Telegram&apos;s per-egress-IP rate limits.
              </li>
            </ul>
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold text-white">
              Accounts to purge ({headerCount})
            </p>
            <div className="max-h-48 overflow-auto rounded border border-white/10 bg-dark-900 p-2 text-xs text-gray-300">
              {selectedSessions.map((s) => (
                <div key={s.id} className="flex items-center gap-2 py-0.5">
                  <ShieldOff className="h-3 w-3 text-red-400 shrink-0" />
                  <span className="truncate">
                    {s.phone || `session-${s.id}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {job && (
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded border border-white/10 bg-dark-900 px-3 py-2">
            <div className="text-xs text-gray-400">
              Job <code className="text-gray-200">{job.jobId}</code>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {job.summary && (
                <>
                  <span className="text-green-300">
                    {job.summary.completed || 0} done
                  </span>
                  <span className="text-amber-300">
                    {job.summary.partial || 0} partial
                  </span>
                  <span className="text-emerald-300">
                    {job.summary.noOthers || 0} no-others
                  </span>
                  <span className="text-red-300">
                    {job.summary.failed || 0} fail
                  </span>
                  <span className="text-gray-400">
                    {job.summary.pending || 0} left
                  </span>
                  <span className="border-l border-white/10 pl-3 text-gray-300">
                    {job.summary.devicesTerminated || 0} device
                    {(job.summary.devicesTerminated || 0) === 1 ? '' : 's'} killed
                  </span>
                </>
              )}
              <span>
                Status:{' '}
                <span className="font-semibold text-white">{job.status}</span>
              </span>
            </div>
          </div>
          {job.error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
              {job.error}
            </div>
          )}
          <div className="max-h-96 overflow-auto divide-y divide-white/5 rounded border border-white/10 bg-dark-900">
            {job.sessions.map((s, idx) => (
              <SessionRow
                key={s.sessionId}
                s={s}
                defaultExpanded={idx === 0 || s.status === 'failed' || s.status === 'partial'}
              />
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default SessionBulkAuthPurgeModal;
