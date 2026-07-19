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
 *      /api/telegram/client/sessions/clear-history. The backend
 *      creates an async job and returns immediately. The modal closes
 *      itself; the History tab on the Login page renders the live
 *      progress.
 *
 * The modal is fire-and-forget — there is no per-session result table
 * here anymore. That UI lives on the History tab so the user can
 * leave the page and come back later without losing progress.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, History, Loader2, Trash2, Users, Layers } from 'lucide-react';
import { Modal } from '../common/Modal';
import { clearAllSessionsChats } from '../../api/telegramClient';
import { useToast } from '../common/Toast';
import SessionListSwitcher from '../common/SessionListSwitcher';

function _displayName(s) {
  if (!s) return 'Session';
  return s.displayName || s.username || s.phone || `#${s.id}`;
}

function _SessionRow({ session }) {
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
      </div>
    </li>
  );
}

export default function DeleteChatsModal({
  isOpen,
  onClose,
  sessions = [],
  onJobCreated,
}) {
  const toast = useToast();

  const [revoke, setRevoke] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Source of sessions to clear: the checkbox selection from the page
  // ('sessions'), or one/more saved session lists ('list').
  const [sourceMode, setSourceMode] = useState('sessions');
  const [selectedListIds, setSelectedListIds] = useState([]);

  // Reset the modal whenever it is reopened.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      setRevoke(false);
      setSubmitting(false);
      setSourceMode('sessions');
      setSelectedListIds([]);
    }
    prevOpenRef.current = isOpen;
  }, [isOpen]);

  const sessionIds = useMemo(
    () => sessions.map((s) => String(s.id)),
    [sessions],
  );

  const usingLists = sourceMode === 'list';
  // Whether the confirm button can fire.
  const canSubmit = usingLists
    ? selectedListIds.length > 0
    : sessionIds.length > 0;

  const handleConfirm = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const { data } = usingLists
        ? await clearAllSessionsChats([], revoke, { sessionListIds: selectedListIds })
        : await clearAllSessionsChats(sessionIds, revoke);
      const payload = data?.data || data;
      const jobId = payload?.jobId;
      const job = payload?.job;
      toast?.success?.(
        usingLists
          ? `Job started for ${selectedListIds.length} session list${selectedListIds.length === 1 ? '' : 's'}. Track progress in History.`
          : `Job started for ${sessionIds.length} session${sessionIds.length === 1 ? '' : 's'}. Track progress in History.`,
      );
      if (typeof onJobCreated === 'function') {
        onJobCreated({ jobId, job });
      }
      onClose?.();
    } catch (err) {
      const msg =
        err?.response?.data?.error ||
        err?.message ||
        'Failed to start clear-chats job.';
      toast?.error?.(msg);
      setSubmitting(false);
    }
  };

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={onClose}
        disabled={submitting}
        className="rounded-md border border-white/10 bg-dark-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={handleConfirm}
        disabled={submitting || !canSubmit}
        className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-red-600/40"
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Trash2 className="h-4 w-4" />
        )}
        {submitting
          ? 'Starting job…'
          : `Delete ${revoke ? 'for both sides' : 'for me'}`}
      </button>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={submitting ? () => {} : onClose}
      title="Delete chats"
      size="lg"
      footer={footer}
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-100">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
            <div>
              <p className="font-medium text-red-200">
                This wipes every dialog from the targeted sessions: private
                chats are cleared, bots are removed and blocked, and groups
                and channels are left (or deleted if the account is the
                owner).
              </p>
              <p className="mt-1 text-red-300/80">
                {usingLists
                  ? `The selected session list${selectedListIds.length === 1 ? '' : 's'} will be expanded to their member sessions and processed in parallel. `
                  : `The action runs across ${sessionIds.length} session${sessionIds.length === 1 ? '' : 's'} in parallel and processes each session's dialogs concurrently. `}
                This cannot be undone.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/5 p-3 text-xs text-gray-300">
          <History className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
          <p>
            We&apos;ll start a background job and switch you to the{' '}
            <span className="font-medium text-gray-100">History</span> tab
            where you can watch live progress per session. You can leave
            this page — the job keeps running.
          </p>
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
                Clears private-chat history from this account&apos;s view
                only and leaves every group and channel. The other side
                still sees private messages.
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
                Wipes private-chat history on the other side too, and fully
                deletes any groups or channels this account owns (others
                are left). Channel history is wiped for everyone only if
                the account is an admin.
              </span>
            </span>
          </label>
        </fieldset>

        {/* Source: the checkbox selection, or saved session list(s). */}
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
            Apply to
          </h3>
          <div className="mb-3 grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-dark-900 p-1">
            <button
              type="button"
              disabled={submitting}
              onClick={() => setSourceMode('sessions')}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                !usingLists
                  ? 'bg-primary-500/15 text-primary-300 ring-1 ring-primary-500/40'
                  : 'text-gray-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Users className="h-3.5 w-3.5" />
              Selected sessions{sessionIds.length ? ` (${sessionIds.length})` : ''}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => setSourceMode('list')}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                usingLists
                  ? 'bg-primary-500/15 text-primary-300 ring-1 ring-primary-500/40'
                  : 'text-gray-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              Session lists
            </button>
          </div>

          {usingLists ? (
            <>
              <SessionListSwitcher
                mode="list"
                onModeChange={() => {}}
                multiple
                selectedSessionListIds={selectedListIds}
                onSelectedSessionListIdsChange={setSelectedListIds}
                disabled={submitting}
              />
              <p className="mt-2 text-[11px] text-gray-500">
                Members of the selected list{selectedListIds.length === 1 ? '' : 's'} are
                combined and de-duplicated. A maximum of 50 sessions can be cleared per job.
              </p>
            </>
          ) : sessions.length === 0 ? (
            <p className="rounded-lg border border-white/10 bg-dark-900/60 px-3 py-3 text-xs text-gray-400">
              No sessions selected. Tick sessions on the Sessions tab, or switch to
              <span className="font-medium text-gray-200"> Session lists</span> above.
            </p>
          ) : (
            <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {sessions.map((s) => (
                <_SessionRow key={s.id} session={s} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
