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
  previewBulkAuthPurge,
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

// Preview rendering helpers — the device list returned by the
// /preview endpoint uses `plannedStatus`, not the runtime `status`.
function PreviewDevicePill({ dev }) {
  if (dev.isCurrent) {
    return (
      <span className="inline-flex items-center rounded border border-emerald-400/60 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-200">
        Will KEEP (this panel)
      </span>
    );
  }
  if (dev.plannedStatus === 'would_terminate') {
    return (
      <span className="inline-flex items-center rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-300">
        Will terminate
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
      {String(dev.plannedStatus || 'unknown').replace(/_/g, ' ')}
    </span>
  );
}

function PreviewSessionRow({ row }) {
  const [expanded, setExpanded] = useState(!row.eligible);
  const Icon = expanded ? ChevronDown : ChevronRight;
  const devices = Array.isArray(row.devices) ? row.devices : [];
  const keepers = devices.filter((d) => d.isCurrent).length;
  const killers = devices.filter((d) => !d.isCurrent).length;
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
            {row.phone || `session-${row.sessionId}`}
          </span>
          {row.eligible ? (
            <span className="inline-flex items-center rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
              Safe to proceed
            </span>
          ) : (
            <span className="inline-flex items-center rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-300">
              Will be skipped
            </span>
          )}
        </div>
        <span className="text-[10px] text-gray-500">
          {keepers} keep · {killers} kill · {devices.length} total
        </span>
      </button>
      {!row.eligible && row.abortReason && (
        <p className="mt-1 text-[11px] text-red-300" title={row.abortReason}>
          {row.abortReason}
        </p>
      )}
      {expanded && (
        <div className="mt-2 space-y-1 rounded border border-white/5 bg-dark-950 p-2">
          {devices.length === 0 ? (
            <p className="text-[11px] italic text-gray-500">
              Telegram returned no devices for this account.
            </p>
          ) : (
            devices.map((d) => (
              <div
                key={d.hash}
                className={`flex items-center justify-between gap-2 rounded px-2 py-1 ${
                  d.isCurrent ? 'bg-emerald-500/5' : ''
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-[11px] text-gray-200" title={d.label}>
                    {d.label}
                  </p>
                  <p className="truncate text-[10px] text-gray-500">
                    hash <code>{d.hash}</code>
                  </p>
                </div>
                <PreviewDevicePill dev={d} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

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
  // Preview — list of { sessionId, eligible, abortReason, devices[],
  // panelHash, panelHashStored } returned by /bulk-auth-purge/preview.
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const pollRef = useRef(null);
  const completedNotifiedRef = useRef(false);
  const { success: showSuccess, error: showError, info: showInfo } = useToast();

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Auto-fetch the preview as soon as the modal opens. Operator
  // sees the exact device list before the destructive button is
  // even enabled.
  useEffect(() => {
    if (!isOpen) {
      setJob(null);
      setStarting(false);
      setPreview(null);
      setPreviewError(null);
      setLoadingPreview(false);
      setConfirmed(false);
      completedNotifiedRef.current = false;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    let cancelled = false;
    setLoadingPreview(true);
    setPreviewError(null);
    previewBulkAuthPurge({
      sessionIds: selectedSessions.map((s) => s.id),
    })
      .then((res) => {
        if (cancelled) return;
        const data = res.data || res;
        setPreview(Array.isArray(data.preview) ? data.preview : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setPreviewError(parseApiError(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // Only ship the sessions we have an eligible preview for. If
      // every selected row is ineligible, refuse to start (would be
      // a pointless API call — the server would no-op everything).
      const eligibleIds = (preview || [])
        .filter((r) => r.eligible)
        .map((r) => r.sessionId);
      if (eligibleIds.length === 0) {
        showError(
          'No selected sessions are safe to purge — every row failed the preview safety check.',
          'Refused to start'
        );
        return;
      }
      const res = await startBulkAuthPurge({
        sessionIds: eligibleIds,
        acknowledged: true,
      });
      const data = res.data || res;
      if (!data || !data.jobId) {
        throw new Error('Server did not return a jobId');
      }
      showInfo(
        `Purging other sessions for ${eligibleIds.length} account(s)…`,
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

  // Eligibility derived from the preview: how many will actually run?
  const eligibleCount = (preview || []).filter((r) => r.eligible).length;
  const ineligibleCount = (preview || []).filter((r) => !r.eligible).length;
  const canStart =
    !!preview && !loadingPreview && eligibleCount > 0 && confirmed && !starting;

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
                  disabled={!canStart}
                  onClick={start}
                  className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                  title={
                    !confirmed
                      ? 'Tick the confirm checkbox below first'
                      : eligibleCount === 0
                      ? 'No selected sessions are safe to purge'
                      : ''
                  }
                >
                  {starting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldOff className="h-4 w-4" />
                  )}
                  Terminate others on {eligibleCount} account
                  {eligibleCount === 1 ? '' : 's'}
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
              What this does — read carefully
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-red-100/90">
              <li>
                For each selected account, the panel asks Telegram for the full
                list of devices currently signed in
                (<code>account.getAuthorizations</code>). The row marked{' '}
                <span className="text-emerald-300 font-semibold">Will KEEP</span>{' '}
                below is the panel’s own login and is never touched.
              </li>
              <li>
                For each <span className="text-red-300 font-semibold">Will terminate</span>{' '}
                row, the panel will call <code>account.resetAuthorization(hash)</code>.
                This is permanent — the affected device must sign in again.
              </li>
              <li>
                If Telegram does not flag exactly one row as <em>current</em>,
                or if the live current-row hash does not match the hash we have
                previously observed for this panel session, the row is{' '}
                <span className="font-semibold">aborted</span> and nothing is
                terminated for that account.
              </li>
              <li>
                Authorizations younger than 24 hours are reported as{' '}
                <span className="font-semibold">Skipped</span> — Telegram
                refuses to reset them. Re-run after 24h to clear them.
              </li>
            </ul>
          </div>

          {loadingPreview && (
            <div className="flex items-center gap-2 rounded border border-white/10 bg-dark-900 p-3 text-xs text-gray-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading Telegram authorizations for {headerCount} account
              {headerCount === 1 ? '' : 's'}…
            </div>
          )}

          {previewError && !loadingPreview && (
            <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
              Preview failed: {previewError}
            </div>
          )}

          {preview && !loadingPreview && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-white">
                  Device preview
                </p>
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="text-emerald-300">
                    {eligibleCount} eligible
                  </span>
                  <span className="text-red-300">
                    {ineligibleCount} skipped
                  </span>
                </div>
              </div>
              <div className="max-h-72 overflow-auto divide-y divide-white/5 rounded border border-white/10 bg-dark-900">
                {preview.length === 0 ? (
                  <p className="p-3 text-xs italic text-gray-500">
                    No preview rows.
                  </p>
                ) : (
                  preview.map((row) => (
                    <PreviewSessionRow key={row.sessionId} row={row} />
                  ))
                )}
              </div>
              <label className="mt-3 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-100">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>
                  I have reviewed the device list above and confirmed that
                  the row marked{' '}
                  <span className="text-emerald-300 font-semibold">Will KEEP</span>{' '}
                  is this panel’s own session. I understand every other
                  authorization will be terminated and that this cannot be
                  undone.
                </span>
              </label>
            </div>
          )}
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
