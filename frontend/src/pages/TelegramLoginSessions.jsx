/**
 * TelegramLoginSessions — the "Login" sidebar page for the Telegram panel.
 *
 * Shows every Telegram session the user has on the panel and lets them
 * tap one to launch the in-panel Telegram client for that account in a
 * dedicated browser window. Re-tapping the same session refocuses the
 * existing window instead of opening a duplicate.
 *
 * The page also doubles as the entry point for the bulk "Delete chats"
 * action: the user multi-selects sessions, picks "Delete for me" or
 * "Delete for both sides", and the panel wipes the chat history of every
 * dialog inside every selected session in parallel. See
 * `DeleteChatsModal` for the confirm + result UI.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  RefreshCcw,
  ExternalLink,
  Search,
  ShieldCheck,
  Star,
  AlertTriangle,
  XCircle,
  CheckCircle2,
  Trash2,
  CheckSquare,
  Square,
} from 'lucide-react';
import { listClientSessions, connectClientSession } from '../api/telegramClient';
import Avatar from '../components/telegramClient/Avatar';
import DeleteChatsModal from '../components/telegramClient/DeleteChatsModal';
import { usePlatform } from '../context/PlatformContext';
import { useToast } from '../components/common/Toast';

function _statusPill(s) {
  if (!s) return null;
  if (s.status === 'revoked') {
    return { label: 'Revoked', tone: 'red', Icon: XCircle };
  }
  if (s.status === 'error') {
    return { label: 'Login error', tone: 'amber', Icon: AlertTriangle };
  }
  if (s.isRestricted) {
    return { label: 'Restricted', tone: 'amber', Icon: AlertTriangle };
  }
  if (s.status === 'active' && s.isLoggedIn) {
    return { label: 'Active', tone: 'emerald', Icon: CheckCircle2 };
  }
  if (s.status === 'uploaded') {
    return { label: 'Uploaded', tone: 'sky', Icon: ShieldCheck };
  }
  if (s.status === 'inactive') {
    return { label: 'Inactive', tone: 'gray', Icon: ShieldCheck };
  }
  return { label: s.status || 'Unknown', tone: 'gray', Icon: ShieldCheck };
}

const TONE_CLASSES = {
  emerald: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  sky:     'bg-sky-500/10 text-sky-300 border-sky-500/30',
  amber:   'bg-amber-500/10 text-amber-200 border-amber-500/30',
  red:     'bg-red-500/10 text-red-300 border-red-500/30',
  gray:    'bg-white/5 text-gray-300 border-white/10',
};

// A session is selectable for "Clear chat history" only if it's logged
// in to Telegram — revoked / error / never-uploaded sessions don't have
// a live MTProto client to talk to, so trying to clear them would only
// produce a misleading "client not loaded" error.
function _canClearChats(s) {
  if (!s) return false;
  if (s.status === 'revoked' || s.status === 'error') return false;
  return !!s.isLoggedIn;
}

export default function TelegramLoginSessions() {
  const { platform } = usePlatform();
  const toast = useToast();

  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [openingId, setOpeningId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const isTelegram = platform === 'telegram';

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await listClientSessions();
      const list = data?.data?.sessions || [];
      setSessions(list);
      // Drop selected ids that no longer exist (e.g. session was deleted
      // elsewhere) so the action bar stays in sync with the rendered list.
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const present = new Set(list.map((s) => String(s.id)));
        const next = new Set();
        for (const id of prev) {
          if (present.has(id)) next.add(id);
        }
        return next;
      });
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isTelegram) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTelegram]);

  const filtered = useMemo(() => {
    if (!query.trim()) return sessions;
    const q = query.trim().toLowerCase();
    return sessions.filter(
      (s) =>
        (s.displayName || '').toLowerCase().includes(q) ||
        (s.username || '').toLowerCase().includes(q) ||
        (s.phone || '').toLowerCase().includes(q) ||
        String(s.id).includes(q)
    );
  }, [sessions, query]);

  // Sessions visible *and* selectable in the current filtered view.
  // Bulk "Select all" toggles only over this set so search-narrowed views
  // don't quietly select hidden sessions.
  const selectableFiltered = useMemo(
    () => filtered.filter(_canClearChats),
    [filtered],
  );
  const filteredSelectableIds = useMemo(
    () => selectableFiltered.map((s) => String(s.id)),
    [selectableFiltered],
  );
  const allFilteredSelected =
    filteredSelectableIds.length > 0 &&
    filteredSelectableIds.every((id) => selectedIds.has(id));
  const someFilteredSelected =
    !allFilteredSelected &&
    filteredSelectableIds.some((id) => selectedIds.has(id));

  const totalSelectableCount = useMemo(
    () => sessions.filter(_canClearChats).length,
    [sessions],
  );

  const selectedSessions = useMemo(
    () => sessions.filter((s) => selectedIds.has(String(s.id))),
    [sessions, selectedIds],
  );

  const toggleOne = (s) => {
    if (!_canClearChats(s)) return;
    const id = String(s.id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const id of filteredSelectableIds) next.delete(id);
      } else {
        for (const id of filteredSelectableIds) next.add(id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const openDeleteModal = () => {
    if (selectedIds.size === 0) {
      toast?.info?.('Select at least one session to clear chats from.');
      return;
    }
    setShowDeleteModal(true);
  };

  const closeDeleteModal = () => {
    setShowDeleteModal(false);
    // Reload the session list — backend may have updated last-active /
    // dialog counters; either way users expect a fresh snapshot.
    refresh();
  };

  const open = async (s) => {
    if (!s) return;
    if (!s.isLoginReady) {
      toast?.error?.(
        s.status === 'revoked'
          ? "This session has been revoked by Telegram and can't be opened."
          : 'This session is not ready to launch. Try Recover from the Sessions page.'
      );
      return;
    }
    const id = s.id;
    setOpeningId(id);
    try {
      // Pre-warm the backend client so the new window opens straight into
      // a connected state. Failures here are surfaced to the user before
      // the window is opened so they aren't met with an empty client.
      await connectClientSession(id);
      const url = `/telegram/client/${encodeURIComponent(id)}`;
      const winName = `tg_client_${id}`;
      const features =
        'popup=yes,noopener=no,noreferrer=no,resizable=yes,scrollbars=yes,width=1100,height=760';
      const w = window.open(url, winName, features);
      if (!w) {
        toast?.error?.(
          'Your browser blocked the popup. Please allow popups for this site and try again.'
        );
      } else {
        try { w.focus(); } catch (_) { /* ignore */ }
      }
    } catch (err) {
      toast?.error?.(
        err?.response?.data?.error ||
          err?.message ||
          'Failed to connect this session.'
      );
    } finally {
      setOpeningId(null);
    }
  };

  if (!isTelegram) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-white/10 bg-dark-900 p-6 text-sm text-gray-300">
          The in-panel Telegram client is only available on the Telegram panel.
          Switch to Telegram to use Login.
        </div>
      </div>
    );
  }

  const SelectAllIcon = allFilteredSelected || someFilteredSelected ? CheckSquare : Square;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-100">Login</h1>
          <p className="text-sm text-gray-400">
            Tap any active Telegram session to open its full chat client in a new
            window. Each account opens in its own window — log into multiple
            accounts in parallel.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openDeleteModal}
            disabled={selectedIds.size === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-gray-500"
            title={
              selectedIds.size === 0
                ? 'Select one or more sessions to clear their chat history'
                : `Clear chat history for ${selectedIds.size} session${selectedIds.size === 1 ? '' : 's'}`
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete chats
            {selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
          </button>
          <button
            onClick={refresh}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-dark-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </header>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, @username, phone, or session id…"
          className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 pl-9 pr-3 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
        />
      </div>

      {!loading && !error && filteredSelectableIds.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-dark-900/60 px-3 py-2 text-sm text-gray-300">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleAllFiltered}
              className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-dark-800 px-2.5 py-1 text-xs font-medium text-gray-200 hover:bg-white/5"
            >
              <SelectAllIcon
                className={`h-3.5 w-3.5 ${
                  someFilteredSelected && !allFilteredSelected ? 'text-blue-300' : ''
                }`}
              />
              {allFilteredSelected ? 'Deselect all' : 'Select all'}
              {filtered.length !== filteredSelectableIds.length
                ? ` (${filteredSelectableIds.length} eligible)`
                : ''}
            </button>
            {selectedIds.size > 0 && (
              <button
                type="button"
                onClick={clearSelection}
                className="rounded-md border border-white/10 bg-dark-800 px-2.5 py-1 text-xs font-medium text-gray-300 hover:bg-white/5"
              >
                Clear selection
              </button>
            )}
          </div>
          <span className="text-xs text-gray-400">
            {selectedIds.size} of {totalSelectableCount} session
            {totalSelectableCount === 1 ? '' : 's'} selected
          </span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-sm text-gray-400">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading sessions…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
          {error}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-dark-900 p-8 text-center text-sm text-gray-400">
          {query
            ? 'No sessions match your search.'
            : 'You have no Telegram sessions on the panel yet. Upload or create one in Sessions first.'}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((s) => {
            const pill = _statusPill(s);
            const PillIcon = pill?.Icon || ShieldCheck;
            const opening = openingId === s.id;
            const id = String(s.id);
            const selected = selectedIds.has(id);
            const selectable = _canClearChats(s);
            return (
              <li
                key={s.id}
                className={`group relative flex flex-col gap-3 rounded-xl border p-4 transition-colors ${
                  selected
                    ? 'border-red-500/50 bg-red-500/5'
                    : 'border-white/10 bg-dark-900 hover:border-blue-500/40 hover:bg-blue-500/5'
                }`}
              >
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => toggleOne(s)}
                    disabled={!selectable}
                    aria-pressed={selected}
                    aria-label={
                      selected
                        ? `Deselect session ${s.displayName || s.id}`
                        : `Select session ${s.displayName || s.id}`
                    }
                    title={
                      selectable
                        ? selected
                          ? 'Deselect (will not clear)'
                          : 'Select for chat-history clearing'
                        : 'This session is not logged in — cannot clear chats'
                    }
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                      selected
                        ? 'border-red-400 bg-red-500/20 text-red-200'
                        : selectable
                          ? 'border-white/20 bg-dark-800 text-gray-400 hover:border-blue-400 hover:text-blue-200'
                          : 'cursor-not-allowed border-white/5 bg-dark-800 text-gray-600'
                    }`}
                  >
                    {selected ? (
                      <CheckSquare className="h-4 w-4" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                  </button>
                  <Avatar
                    sessionId={s.id}
                    peerType="user"
                    peerId={Number(s.telegramId) || 0}
                    label={s.displayName}
                    size="lg"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-gray-100">
                        {s.displayName}
                      </span>
                      {s.isPremium && <Star className="h-3.5 w-3.5 text-amber-300" />}
                      {s.isVerified && <ShieldCheck className="h-3.5 w-3.5 text-blue-300" />}
                    </div>
                    <div className="truncate text-xs text-gray-500">
                      {s.username ? `@${s.username}` : ''}
                      {s.username && s.phone ? ' · ' : ''}
                      {s.phone || ''}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {pill && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${TONE_CLASSES[pill.tone]}`}
                        >
                          <PillIcon className="h-3 w-3" />
                          {pill.label}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-gray-300">
                        #{s.id}
                      </span>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!s.isLoginReady || opening}
                  onClick={() => open(s)}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-blue-600/30 disabled:text-blue-100/70"
                >
                  {opening ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ExternalLink className="h-4 w-4" />
                  )}
                  {opening ? 'Connecting…' : 'Open client'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <DeleteChatsModal
        isOpen={showDeleteModal}
        onClose={closeDeleteModal}
        sessions={selectedSessions}
      />
    </div>
  );
}
