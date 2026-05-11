import React, { useEffect, useRef, useState } from 'react';
import { Loader2, LogIn, ShieldCheck, X } from 'lucide-react';

import { Modal } from './Modal';
import { useToast } from './Toast';
import {
  cancelBulkLogin,
  getBulkLoginStatus,
  startBulkLogin,
} from '../../api/sessions';
import { parseApiError } from '../../utils/formatters';

/**
 * SessionBulkLoginModal
 *
 * UX for the Sessions page "Login All" button. Mirrors the
 * clone-export modal's job-progress shape so the operator gets the
 * same per-row visibility the export feature gives. Replaces the
 * legacy inline `for-await loginSession(id)` loop that only emitted
 * a single end-of-run toast.
 *
 *   1. Operator confirms which sessions will be logged in.
 *   2. Operator clicks "Start". The modal polls /bulk-login/status
 *      and shows per-session progress (queued → logging in →
 *      logged_in / already_logged_in / failed).
 *   3. Per-row errors are shown inline; the bottom summary tracks
 *      succeeded / already-logged-in / failed counts.
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function StatusPill({ status }) {
  let label;
  let cls;
  if (status === 'logged_in') {
    label = 'Logged in';
    cls = 'bg-green-500/10 border-green-500/40 text-green-300';
  } else if (status === 'already_logged_in') {
    label = 'Already in';
    cls = 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300';
  } else if (status === 'failed') {
    label = 'Failed';
    cls = 'bg-red-500/10 border-red-500/40 text-red-300';
  } else if (status === 'queued') {
    label = 'Queued';
    cls = 'bg-gray-500/10 border-gray-500/30 text-gray-300';
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

export function SessionBulkLoginModal({ isOpen, onClose, selectedSessions, onCompleted }) {
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
        const res = await getBulkLoginStatus(jobId);
        const data = res.data || res;
        setJob(data);
        if (data && TERMINAL_STATUSES.has(data.status)) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          if (!completedNotifiedRef.current) {
            completedNotifiedRef.current = true;
            const s = data.summary || {};
            if (data.status === 'completed') {
              if (s.failed > 0) {
                showError(
                  `${s.succeeded || 0} logged in, ${s.alreadyLoggedIn || 0} already logged in, ${s.failed} failed.`,
                  'Bulk Login partial'
                );
              } else {
                showSuccess(
                  `${s.succeeded || 0} logged in, ${s.alreadyLoggedIn || 0} already logged in.`,
                  'Bulk Login complete'
                );
              }
            } else if (data.status === 'cancelled') {
              showInfo('Bulk login cancelled.', 'Cancelled');
            }
            if (typeof onCompleted === 'function') {
              try { onCompleted(data); } catch (_) { /* best-effort */ }
            }
          }
        }
      } catch (err) {
        // Don't kill the poll for one transient error.
        // eslint-disable-next-line no-console
        console.warn('bulk-login status poll failed', err);
      }
    };
    tick();
    pollRef.current = setInterval(tick, 1500);
  };

  const start = async () => {
    setStarting(true);
    try {
      const res = await startBulkLogin({
        sessionIds: selectedSessions.map((s) => s.id),
      });
      const data = res.data || res;
      if (!data || !data.jobId) {
        throw new Error('Server did not return a jobId');
      }
      showInfo(`Logging in ${selectedSessions.length} session(s)…`, 'Bulk Login started');
      startPolling(data.jobId);
    } catch (err) {
      showError(parseApiError(err), 'Failed to start bulk login');
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
      await cancelBulkLogin(job.jobId);
      showInfo('Bulk login cancelled.', 'Cancelled');
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
      title="Login selected sessions"
      size="lg"
      footer={
        <div className="flex w-full items-center justify-between">
          <span className="text-xs text-gray-500">
            Calls the same login flow as the per-row Login button, one session at a time.
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
                  className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-500 disabled:opacity-50"
                >
                  {starting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <LogIn className="h-4 w-4" />
                  )}
                  Start logging in {headerCount} session{headerCount === 1 ? '' : 's'}
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
            {job && (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') && (
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
          <div className="rounded-lg border border-primary-500/20 bg-primary-500/5 p-3 text-xs text-primary-200">
            <p className="font-semibold">How this works</p>
            <p className="mt-1 text-primary-100/90">
              The panel attempts to log in each selected session sequentially,
              with a brief delay between rows so we don&apos;t hit Telegram
              rate limits. Sessions that are already logged in are reported
              as <span className="font-semibold">Already in</span> and do
              not count as failures.
            </p>
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold text-white">
              Sessions to log in ({headerCount})
            </p>
            <div className="max-h-48 overflow-auto rounded border border-white/10 bg-dark-900 p-2 text-xs text-gray-300">
              {selectedSessions.map((s) => (
                <div key={s.id} className="flex items-center gap-2 py-0.5">
                  <ShieldCheck className="h-3 w-3 text-primary-400 shrink-0" />
                  <span className="truncate">{s.phone || `session-${s.id}`}</span>
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
            <div className="flex items-center gap-3 text-xs">
              {job.summary && (
                <>
                  <span className="text-green-300">
                    {job.summary.succeeded || 0} ok
                  </span>
                  <span className="text-emerald-300">
                    {job.summary.alreadyLoggedIn || 0} in
                  </span>
                  <span className="text-red-300">
                    {job.summary.failed || 0} fail
                  </span>
                  <span className="text-gray-400">
                    {job.summary.pending || 0} left
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
          <div className="max-h-72 overflow-auto divide-y divide-white/5 rounded border border-white/10 bg-dark-900">
            {job.sessions.map((s) => (
              <div key={s.sessionId} className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-gray-100">
                      {s.phone || `session-${s.sessionId}`}
                    </span>
                    <StatusPill status={s.status} />
                  </div>
                  <span className="text-[10px] text-gray-500">{s.progress}%</span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded bg-dark-700">
                  <div
                    className={`h-full transition-all ${
                      s.status === 'failed'
                        ? 'bg-red-500'
                        : s.status === 'logged_in' || s.status === 'already_logged_in'
                        ? 'bg-green-500'
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
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default SessionBulkLoginModal;
