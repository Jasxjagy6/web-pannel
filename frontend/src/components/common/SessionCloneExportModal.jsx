import React, { useEffect, useRef, useState } from 'react';
import { Download, KeyRound, Loader2, ShieldCheck, X } from 'lucide-react';

import { Modal } from './Modal';
import { useToast } from './Toast';
import {
  cancelCloneExport,
  downloadCloneExportZip,
  getCloneExportStatus,
  startCloneExport,
  submitCloneExportPassword,
} from '../../api/sessions';
import { parseApiError } from '../../utils/formatters';

/**
 * SessionCloneExportModal
 *
 * UX for the QR-login-token clone export:
 *   1. Operator confirms which sessions will be cloned.
 *   2. Operator enters the *destination* api_id / api_hash — these are
 *      the credentials whoever receives the bundle will load the
 *      sessions with. Different from the panel's api_id/hash is
 *      explicitly the point: the new auth_keys Telegram issues are
 *      bound to these credentials, so loading them on another machine
 *      won't trigger AUTH_KEY_DUPLICATED.
 *   3. Operator clicks "Start Cloning". The modal polls status and
 *      shows per-session progress.
 *   4. If a session has 2FA, the row shows a password input. Submit
 *      resumes that session's clone.
 *   5. When the job finishes, an automatic download is triggered.
 *
 * The panel's original sessions are untouched throughout — both
 * authorizations coexist in Telegram's Active Sessions list.
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function StatusPill({ status, awaitingPassword }) {
  let label;
  let cls;
  if (awaitingPassword) {
    label = '2FA needed';
    cls = 'bg-amber-500/10 border-amber-500/40 text-amber-300';
  } else if (status === 'cloned') {
    label = 'Cloned';
    cls = 'bg-green-500/10 border-green-500/40 text-green-300';
  } else if (status === 'failed') {
    label = 'Failed';
    cls = 'bg-red-500/10 border-red-500/40 text-red-300';
  } else if (status === 'queued') {
    label = 'Queued';
    cls = 'bg-gray-500/10 border-gray-500/30 text-gray-300';
  } else {
    label = status.replace(/_/g, ' ');
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

function PasswordRow({ jobId, sessionState, onSubmitted }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const { error: showError } = useToast();

  const submit = async () => {
    if (!pw) return;
    setBusy(true);
    try {
      await submitCloneExportPassword(jobId, sessionState.sessionId, pw);
      onSubmitted();
    } catch (err) {
      showError(parseApiError(err), 'Submit 2FA password failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex items-center gap-2">
      <KeyRound className="h-3.5 w-3.5 text-amber-400" />
      <input
        type="password"
        placeholder="Cloud password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        autoFocus
        className="flex-1 rounded border border-amber-500/30 bg-dark-900 px-2 py-1 text-xs text-white placeholder-gray-500 focus:border-amber-500 focus:outline-none"
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
      <button
        type="button"
        disabled={busy || !pw}
        onClick={submit}
        className="rounded bg-amber-500/20 border border-amber-500/30 px-2 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/30 disabled:opacity-50"
      >
        {busy ? '...' : 'Submit'}
      </button>
    </div>
  );
}

export function SessionCloneExportModal({ isOpen, onClose, selectedSessions }) {
  const [destApiId, setDestApiId] = useState('');
  const [destApiHash, setDestApiHash] = useState('');
  const [job, setJob] = useState(null);
  const [starting, setStarting] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const pollRef = useRef(null);
  const { success: showSuccess, error: showError, info: showInfo } = useToast();

  // Stop polling when modal closes / unmounts.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Reset transient state every time the modal is re-opened so a
  // previous job's bookkeeping doesn't leak into the next one.
  useEffect(() => {
    if (isOpen) {
      setJob(null);
      setStarting(false);
      setDownloaded(false);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [isOpen]);

  const startPolling = (jobId) => {
    if (pollRef.current) clearInterval(pollRef.current);
    const tick = async () => {
      try {
        const res = await getCloneExportStatus(jobId);
        const data = res.data || res;
        setJob(data);
        if (data && TERMINAL_STATUSES.has(data.status)) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          if (data.status === 'completed' && data.downloadReady && !downloaded) {
            setDownloaded(true);
            try {
              await downloadCloneExportZip(jobId);
              showSuccess('Clone-export ZIP downloaded.', 'Export complete');
            } catch (err) {
              showError(parseApiError(err), 'Download failed');
            }
          }
        }
      } catch (err) {
        // Don't kill the poll for one transient error.
        // eslint-disable-next-line no-console
        console.warn('clone-export status poll failed', err);
      }
    };
    tick();
    pollRef.current = setInterval(tick, 1500);
  };

  const start = async () => {
    if (!destApiId || !destApiHash) {
      showError('Destination API ID and API Hash are required.', 'Missing fields');
      return;
    }
    setStarting(true);
    try {
      const res = await startCloneExport({
        sessionIds: selectedSessions.map((s) => s.id),
        destApiId: Number(destApiId),
        destApiHash: destApiHash.trim(),
      });
      const data = res.data || res;
      if (!data || !data.jobId) {
        throw new Error('Server did not return a jobId');
      }
      showInfo(`Cloning ${selectedSessions.length} session(s)…`, 'Clone started');
      startPolling(data.jobId);
    } catch (err) {
      showError(parseApiError(err), 'Failed to start clone-export');
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
      await cancelCloneExport(job.jobId);
      showInfo('Clone-export cancelled.', 'Cancelled');
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

  const downloadAgain = async () => {
    if (!job?.jobId) return;
    try {
      await downloadCloneExportZip(job.jobId);
    } catch (err) {
      showError(parseApiError(err), 'Download failed');
    }
  };

  const headerCount = selectedSessions.length;
  const isRunning = job && !TERMINAL_STATUSES.has(job.status);

  return (
    <Modal
      isOpen={isOpen}
      onClose={isRunning ? () => {} : onClose}
      title="Export cloned sessions"
      size="lg"
      footer={
        <div className="flex w-full items-center justify-between">
          <span className="text-xs text-gray-500">
            Uses Telegram QR-login RPCs. Original sessions stay logged in.
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
                    <Download className="h-4 w-4" />
                  )}
                  Start cloning {headerCount} session{headerCount === 1 ? '' : 's'}
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
            {job && job.status === 'completed' && (
              <>
                <button
                  type="button"
                  onClick={downloadAgain}
                  className="flex items-center gap-2 rounded-lg border border-primary-500/30 bg-primary-500/10 px-4 py-2 text-sm text-primary-300 hover:bg-primary-500/20"
                >
                  <Download className="h-4 w-4" /> Download ZIP again
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-500"
                >
                  Done
                </button>
              </>
            )}
            {job && (job.status === 'failed' || job.status === 'cancelled') && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-dark-700 px-4 py-2 text-sm text-gray-200 hover:bg-dark-600"
              >
                Close
              </button>
            )}
          </div>
        </div>
      }
    >
      {!job && (
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">
            <p className="font-semibold">How this works</p>
            <p className="mt-1 text-amber-100/90">
              The panel signs each selected session into a brand-new Telegram
              authorization tied to the destination <code>api_id</code> /{' '}
              <code>api_hash</code> you provide. Telegram issues a fresh{' '}
              <code>auth_key</code> for that new device — loading the resulting
              .session / .json on another machine does <em>not</em> revoke the
              original panel session. Both stay active.
            </p>
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold text-white">
              Sessions to clone ({headerCount})
            </p>
            <div className="max-h-32 overflow-auto rounded border border-white/10 bg-dark-900 p-2 text-xs text-gray-300">
              {selectedSessions.map((s) => (
                <div key={s.id} className="flex items-center gap-2 py-0.5">
                  <ShieldCheck className="h-3 w-3 text-green-400 shrink-0" />
                  <span className="truncate">{s.phone || `session-${s.id}`}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-400">
                Destination API ID
              </label>
              <input
                type="number"
                placeholder="e.g. 1234567"
                value={destApiId}
                onChange={(e) => setDestApiId(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-400">
                Destination API Hash
              </label>
              <input
                type="text"
                placeholder="32-character hex string"
                value={destApiHash}
                onChange={(e) => setDestApiHash(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none"
              />
            </div>
          </div>
          <p className="text-[11px] text-gray-500">
            These credentials will be embedded in each <code>.json</code> file
            so the recipient can load the cloned sessions with{' '}
            <code>TelegramClient(stringSession, apiId, apiHash)</code> without
            additional config.
          </p>
        </div>
      )}

      {job && (
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded border border-white/10 bg-dark-900 px-3 py-2">
            <div className="text-xs text-gray-400">
              Job <code className="text-gray-200">{job.jobId}</code>
            </div>
            <div className="text-xs">
              Status:{' '}
              <span className="font-semibold text-white">{job.status}</span>
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
                    <StatusPill status={s.status} awaitingPassword={s.awaitingPassword} />
                  </div>
                  <span className="text-[10px] text-gray-500">{s.progress}%</span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded bg-dark-700">
                  <div
                    className={`h-full transition-all ${
                      s.status === 'failed'
                        ? 'bg-red-500'
                        : s.status === 'cloned'
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
                {s.awaitingPassword && (
                  <PasswordRow
                    jobId={job.jobId}
                    sessionState={s}
                    onSubmitted={() => { /* poller will update */ }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default SessionCloneExportModal;
