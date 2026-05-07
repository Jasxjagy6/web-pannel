/**
 * DeleteChatsModal — confirmation modal for the bulk "Delete chats"
 * action on the Telegram Login page.
 *
 * Flow:
 *   1. User multi-selects sessions on the Login page and clicks
 *      "Delete chats". The page mounts this modal with the list of
 *      selected sessions.
 *   2. The user picks "Delete for me" or "Delete for both sides".
 *   3. On confirm we POST every selected session id to
 *      /api/telegram/client/sessions/clear-history with the chosen
 *      revoke flag and render the per-session result table once the
 *      backend replies.
 *
 * The modal stays open after submission so the user can review the
 * per-session breakdown (X chats cleared, Y failed, top error per
 * session). The parent page re-fetches the session list when the
 * modal is closed so the UI shows fresh state.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Modal } from '../common/Modal';
import { clearAllSessionsChats } from '../../api/telegramClient';
import { useToast } from '../common/Toast';

function _displayName(s) {
  if (!s) return 'Session';
  return s.displayName || s.username || s.phone || `#${s.id}`;
}

function _SessionRow({ session, result }) {
  // result shape:
  //   { ok: true, sessionId, data: { total, succeeded, failed, ... } }
  //   { ok: false, sessionId, error, code }
  let pill = null;
  if (!result) {
    pill = (
      <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-gray-300">
        <Loader2 className="h-3 w-3 animate-spin" />
        Pending
      </span>
    );
  } else if (!result.ok) {
    pill = (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-200">
        <XCircle className="h-3 w-3" />
        Session error
      </span>
    );
  } else {
    const { total, succeeded, failed } = result.data;
    if (total === 0) {
      pill = (
        <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-gray-300">
          No chats
        </span>
      );
    } else if (failed === 0) {
      pill = (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-200">
          <CheckCircle2 className="h-3 w-3" />
          {succeeded}/{total} cleared
        </span>
      );
    } else if (succeeded === 0) {
      pill = (
        <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-200">
          <XCircle className="h-3 w-3" />
          0/{total} cleared
        </span>
      );
    } else {
      pill = (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-200">
          <AlertTriangle className="h-3 w-3" />
          {succeeded}/{total} cleared, {failed} failed
        </span>
      );
    }
  }

  let detail = null;
  if (result && !result.ok) {
    detail = (
      <p className="mt-1 truncate text-[11px] text-red-300/80" title={result.error}>
        {result.error}
        {result.code ? ` · ${result.code}` : ''}
      </p>
    );
  } else if (result && result.ok && result.data.failed > 0) {
    const firstFailure = (result.data.results || []).find((r) => !r.ok);
    if (firstFailure) {
      detail = (
        <p
          className="mt-1 truncate text-[11px] text-amber-300/80"
          title={`${firstFailure.title || ''}: ${firstFailure.error || ''}`}
        >
          First failure: {firstFailure.title || `#${firstFailure.peerId}`} ·{' '}
          {firstFailure.code || firstFailure.error}
        </p>
      );
    }
  }

  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-white/10 bg-dark-900/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-gray-100">
          {_displayName(session)}
        </div>
        <div className="truncate text-[11px] text-gray-500">
          {session.username ? `@${session.username}` : ''}
          {session.username && session.phone ? ' · ' : ''}
          {session.phone || ''}
          {' · '}#{session.id}
        </div>
        {detail}
      </div>
      <div className="shrink-0">{pill}</div>
    </li>
  );
}

export default function DeleteChatsModal({ isOpen, onClose, sessions = [] }) {
  const toast = useToast();

  const [revoke, setRevoke] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [response, setResponse] = useState(null);

  // Map sessionId -> per-session result entry from the backend.
  const resultBySession = useMemo(() => {
    if (!response) return new Map();
    const map = new Map();
    for (const s of response.sessions || []) {
      map.set(String(s.sessionId), s);
    }
    return map;
  }, [response]);

  // Reset the modal whenever it is reopened.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      setRevoke(false);
      setSubmitting(false);
      setResponse(null);
    }
    prevOpenRef.current = isOpen;
  }, [isOpen]);

  const sessionIds = useMemo(
    () => sessions.map((s) => String(s.id)),
    [sessions],
  );

  const handleConfirm = async () => {
    if (sessionIds.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const { data } = await clearAllSessionsChats(sessionIds, revoke);
      const payload = data?.data || data;
      setResponse(payload);
      const cleared = payload?.totalSucceeded ?? 0;
      const failed = payload?.totalFailed ?? 0;
      if (failed === 0) {
        toast?.success?.(
          `Cleared ${cleared} chat${cleared === 1 ? '' : 's'} across ${sessionIds.length} session${sessionIds.length === 1 ? '' : 's'}.`,
        );
      } else {
        toast?.warning?.(
          `Cleared ${cleared} chats; ${failed} failed. See per-session details.`,
        );
      }
    } catch (err) {
      const msg =
        err?.response?.data?.error ||
        err?.message ||
        'Failed to clear chat history.';
      toast?.error?.(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const submittedOk = response && response.totalFailed === 0;
  const totalDialogs = response?.totalDialogs ?? 0;
  const totalSucceeded = response?.totalSucceeded ?? 0;
  const totalFailed = response?.totalFailed ?? 0;

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={onClose}
        disabled={submitting}
        className="rounded-md border border-white/10 bg-dark-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {response ? 'Close' : 'Cancel'}
      </button>
      {!response && (
        <button
          type="button"
          onClick={handleConfirm}
          disabled={submitting || sessionIds.length === 0}
          className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-red-600/40"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
          {submitting
            ? `Clearing ${sessionIds.length} session${sessionIds.length === 1 ? '' : 's'}…`
            : `Delete ${revoke ? 'for both sides' : 'for me'}`}
        </button>
      )}
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={submitting ? () => {} : onClose}
      title={response ? 'Delete chats — results' : 'Delete chats'}
      size="lg"
      footer={footer}
    >
      <div className="space-y-4">
        {!response && (
          <>
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-100">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                <div>
                  <p className="font-medium text-red-200">
                    This will clear the entire chat history of every dialog in
                    the selected session{sessionIds.length === 1 ? '' : 's'}.
                  </p>
                  <p className="mt-1 text-red-300/80">
                    The action runs across {sessionIds.length} session
                    {sessionIds.length === 1 ? '' : 's'} in parallel. Each
                    session processes its dialogs sequentially. This cannot be
                    undone.
                  </p>
                </div>
              </div>
            </div>

            <fieldset className="space-y-2" aria-label="Deletion scope">
              <legend className="text-sm font-medium text-gray-200">
                What should be deleted?
              </legend>
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 transition-colors ${
                  !revoke
                    ? 'border-blue-500/40 bg-blue-500/5'
                    : 'border-white/10 bg-dark-900/60 hover:bg-white/5'
                }`}
              >
                <input
                  type="radio"
                  name="delete-scope"
                  checked={!revoke}
                  onChange={() => setRevoke(false)}
                  disabled={submitting}
                  className="mt-1 h-4 w-4 cursor-pointer accent-blue-500"
                />
                <span className="text-sm">
                  <span className="block font-medium text-gray-100">
                    Delete for me
                  </span>
                  <span className="block text-xs text-gray-400">
                    Removes every chat&apos;s history from this account&apos;s
                    view only. The other side still sees the messages.
                  </span>
                </span>
              </label>
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 transition-colors ${
                  revoke
                    ? 'border-red-500/40 bg-red-500/5'
                    : 'border-white/10 bg-dark-900/60 hover:bg-white/5'
                }`}
              >
                <input
                  type="radio"
                  name="delete-scope"
                  checked={revoke}
                  onChange={() => setRevoke(true)}
                  disabled={submitting}
                  className="mt-1 h-4 w-4 cursor-pointer accent-red-500"
                />
                <span className="text-sm">
                  <span className="block font-medium text-gray-100">
                    Delete for both sides
                  </span>
                  <span className="block text-xs text-gray-400">
                    Asks Telegram to also wipe the history on the other side
                    wherever it&apos;s allowed (private chats &amp; basic
                    groups always; channels only if the account is an admin).
                  </span>
                </span>
              </label>
            </fieldset>
          </>
        )}

        {response && (
          <div
            className={`rounded-lg border p-3 text-sm ${
              submittedOk
                ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-100'
                : totalSucceeded === 0
                  ? 'border-red-500/30 bg-red-500/5 text-red-100'
                  : 'border-amber-500/30 bg-amber-500/5 text-amber-100'
            }`}
          >
            <div className="flex items-start gap-2">
              {submittedOk ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
              ) : totalSucceeded === 0 ? (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              )}
              <div>
                <p className="font-medium">
                  {totalSucceeded} of {totalDialogs} chats cleared across{' '}
                  {sessionIds.length} session
                  {sessionIds.length === 1 ? '' : 's'}.
                  {totalFailed > 0 ? ` ${totalFailed} failed.` : ''}
                </p>
                <p className="mt-0.5 text-xs opacity-80">
                  Mode:{' '}
                  {response.revoke
                    ? 'delete for both sides'
                    : 'delete for me'}
                </p>
              </div>
            </div>
          </div>
        )}

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
            Selected session{sessionIds.length === 1 ? '' : 's'} (
            {sessionIds.length})
          </h3>
          <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {sessions.map((s) => (
              <_SessionRow
                key={s.id}
                session={s}
                result={resultBySession.get(String(s.id))}
              />
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
