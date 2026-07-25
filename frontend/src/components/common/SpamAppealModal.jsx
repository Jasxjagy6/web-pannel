/**
 * SpamAppealModal — runs the @SpamBot appeal job over the selected
 * sessions and shows live per-session progress.
 *
 * For each session the backend sends /start to @SpamBot, and if the
 * account is restricted, presses the reply-keyboard appeal button and
 * submits an appeal. Clean accounts are skipped ("free as a bird").
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  ShieldCheck, Loader2, CheckCircle2, XCircle, Clock, StopCircle,
  MessageSquare, ChevronDown, ChevronRight,
} from 'lucide-react';
import { Modal } from './Modal';
import {
  startSpamAppeal, recheckSpamStatus, getSpamAppealStatus, cancelSpamAppeal,
} from '../../api/sessions';
import { useToast } from './Toast';

const STATUS_META = {
  queued:         { label: 'Queued',      cls: 'bg-white/5 text-gray-300 border-white/10', Icon: Clock, spin: false },
  checking:       { label: 'Checking',    cls: 'bg-blue-500/10 text-blue-200 border-blue-500/30', Icon: Loader2, spin: true },
  appealing:      { label: 'Appealing',   cls: 'bg-amber-500/10 text-amber-200 border-amber-500/30', Icon: Loader2, spin: true },
  appealed:       { label: 'Appealed',    cls: 'bg-emerald-500/10 text-emerald-200 border-emerald-500/30', Icon: CheckCircle2, spin: false },
  no_restriction: { label: 'No limits',   cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', Icon: ShieldCheck, spin: false },
  limited:        { label: 'Limited',     cls: 'bg-amber-500/10 text-amber-200 border-amber-500/30', Icon: XCircle, spin: false },
  frozen:         { label: 'Frozen',      cls: 'bg-red-500/10 text-red-200 border-red-500/30', Icon: XCircle, spin: false },
  unknown:        { label: 'Inconclusive', cls: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/30', Icon: Clock, spin: false },
  inconclusive:   { label: 'Inconclusive', cls: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/30', Icon: Clock, spin: false },
  failed:         { label: 'Failed',      cls: 'bg-red-500/10 text-red-200 border-red-500/30', Icon: XCircle, spin: false },
  cancelled:      { label: 'Cancelled',   cls: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/30', Icon: StopCircle, spin: false },
};

function StatusPill({ status }) {
  const m = STATUS_META[status] || STATUS_META.queued;
  const Icon = m.Icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${m.cls}`}>
      <Icon className={`h-3 w-3 ${m.spin ? 'animate-spin' : ''}`} />
      {m.label}
    </span>
  );
}

function SessionRow({ sess }) {
  const [open, setOpen] = useState(false);
  const hasTranscript = Array.isArray(sess.transcript) && sess.transcript.length > 0;
  return (
    <li className="rounded-lg border border-white/10 bg-dark-900/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-gray-100">{sess.label || `Session #${sess.sessionId}`}</span>
            <StatusPill status={sess.status} />
          </div>
          <div className="truncate text-[11px] text-gray-500">
            {sess.phone ? `${sess.phone} · ` : ''}#{sess.sessionId}
            {sess.error ? <span className="text-red-300/80"> · {sess.error}</span> : ''}
            {sess.limitUntil ? (
              <span className="text-amber-300/80">
                {' '}· until {new Date(sess.limitUntil).toLocaleString(undefined, { timeZone: 'UTC' })} UTC
              </span>
            ) : ''}
          </div>
        </div>
        {hasTranscript && (open ? <ChevronDown className="h-4 w-4 text-gray-500" /> : <ChevronRight className="h-4 w-4 text-gray-500" />)}
      </button>
      {open && hasTranscript && (
        <div className="border-t border-white/10 bg-black/20 px-3 py-2 space-y-1">
          {sess.transcript.map((t, i) => (
            <div key={i} className="flex items-start gap-2 text-[11px]">
              <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${t.who === 'me' ? 'bg-primary-500/15 text-primary-200' : 'bg-white/5 text-gray-300'}`}>
                {t.who === 'me' ? 'me' : '@SpamBot'}
              </span>
              <span className="text-gray-300 break-words">{t.text}</span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

export default function SpamAppealModal({
  isOpen,
  onClose,
  selectedSessions = [],
  sessionListIds = [],
  mode = 'appeal',
  onCompleted,
}) {
  const toast = useToast();
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef(null);
  const completedRef = useRef(false);
  const checkingOnly = mode === 'check';

  const usingLists = Array.isArray(sessionListIds) && sessionListIds.length > 0;
  const sessionIds = selectedSessions.map((s) => s.id);

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const poll = useCallback(async (id) => {
    try {
      const { data } = await getSpamAppealStatus(id);
      setJob(data);
      if (data.status === 'completed') {
        stopPoll();
        if (!completedRef.current) {
          completedRef.current = true;
          onCompleted?.(data);
        }
      }
    } catch {
      // keep polling; transient
    }
  }, [stopPoll, onCompleted]);

  const handleStart = async () => {
    setStarting(true);
    try {
      const payload = usingLists ? { sessionListIds } : { sessionIds };
      const { data } = checkingOnly
        ? await recheckSpamStatus(payload)
        : await startSpamAppeal(payload);
      setJobId(data.jobId);
      toast?.success?.(
        `${checkingOnly ? 'Status recheck' : 'Appeal'} started for ${data.total} session${data.total === 1 ? '' : 's'}.`
      );
      poll(data.jobId);
      pollRef.current = setInterval(() => poll(data.jobId), 2000);
    } catch (err) {
      toast?.error?.(err?.response?.data?.error?.message || err?.response?.data?.error || err?.message || 'Failed to start appeal');
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!jobId) return;
    try { await cancelSpamAppeal(jobId); } catch { /* ignore */ }
  };

  // Reset + auto-start each time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setJobId(null);
      setJob(null);
      completedRef.current = false;
    } else {
      stopPoll();
    }
    return stopPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const total = usingLists
    ? (job?.summary?.total ?? '…')
    : sessionIds.length;
  const running = job && job.status !== 'completed';
  const s = job?.summary;

  const footer = (
    <div className="flex items-center justify-between gap-2">
      <div className="text-xs text-gray-400">
        {s ? (
          <>
            <span className="text-emerald-300">{s.appealed} appealed</span> ·{' '}
            <span className="text-emerald-400">{s.clean} clean</span> ·{' '}
            <span className="text-amber-300">{s.limited || 0} limited</span> ·{' '}
            <span className="text-red-300">{s.frozen || 0} frozen</span> ·{' '}
            <span className="text-zinc-300">{s.inconclusive || 0} inconclusive</span> ·{' '}
            <span className="text-red-300">{s.failed} failed</span> ·{' '}
            <span className="text-gray-400">{s.pending} pending</span>
          </>
        ) : 'Ready'}
      </div>
      <div className="flex items-center gap-2">
        {running && (
          <button
            type="button"
            onClick={handleCancel}
            className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm text-red-200 hover:bg-red-500/20"
          >
            <StopCircle className="h-4 w-4" /> Cancel
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-white/10 bg-dark-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5"
        >
          {running ? 'Close (keeps running)' : 'Close'}
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={checkingOnly ? 'Recheck Telegram status' : 'Appeal restrictions via @SpamBot'}
      size="lg"
      footer={footer}
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-xs text-gray-300">
          <div className="flex items-start gap-2">
            <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary-400" />
            <p>
              For each session we message <span className="font-medium text-gray-100">@SpamBot</span> with{' '}
              <code className="rounded bg-white/10 px-1">/start</code>.{' '}
              {checkingOnly
                ? 'This check updates clean, limited, and frozen status; it does not file an appeal. Clean accounts automatically return to all task pools.'
                : 'If the account is restricted, we press the appeal button and submit an appeal automatically.'}{' '}
              Sessions are processed one by one with a delay to stay safe.
            </p>
          </div>
        </div>

        {!jobId ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <p className="text-sm text-gray-300">
              {usingLists
                ? `${checkingOnly ? 'Recheck' : 'Appeal'} every session in the selected list${sessionListIds.length === 1 ? '' : 's'}.`
                : `${total} session${total === 1 ? '' : 's'} selected.`}
            </p>
            <button
              type="button"
              onClick={handleStart}
              disabled={starting || (!usingLists && sessionIds.length === 0)}
              className="inline-flex items-center gap-2 rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-500 disabled:opacity-50"
            >
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {checkingOnly ? 'Start recheck' : 'Start appeal'}
            </button>
          </div>
        ) : !job ? (
          <div className="flex items-center gap-2 py-8 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Starting…
          </div>
        ) : (
          <ul className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
            {job.sessions.map((sess) => (
              <SessionRow key={sess.sessionId} sess={sess} />
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
