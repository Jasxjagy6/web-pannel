/**
 * TelegramClient — the per-session client window.
 *
 * This page is intentionally rendered OUTSIDE the panel's `Layout` (no
 * sidebar, no header chrome) so each session feels like its own
 * Telegram-style client. It is opened via `window.open(url, 'tg_client_<id>')`
 * from the Login Sessions page, so multiple sessions land in multiple
 * separate browser windows and a per-session window with the same name
 * just refocuses instead of duplicating.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2, AlertCircle, Wifi, WifiOff, Settings, Users } from 'lucide-react';
import {
  connectClientSession,
  getClientDialogs,
} from '../api/telegramClient';
import { useAuth } from '../context/AuthContext';
import { useCapabilities } from '../context/PlatformContext';
import { createTgClientStore } from '../components/telegramClient/tgClientStore';
import { useTelegramClientSocket } from '../components/telegramClient/useTelegramClientSocket';
import DialogList from '../components/telegramClient/DialogList';
import ChatPane from '../components/telegramClient/ChatPane';
import Avatar from '../components/telegramClient/Avatar';
import SelfProfileDrawer from '../components/telegramClient/SelfProfileDrawer';
import SettingsDrawer from '../components/telegramClient/SettingsDrawer';
import ContactsDrawer from '../components/telegramClient/ContactsDrawer';
import NotificationCenter from '../components/telegramClient/NotificationCenter';

export default function TelegramClient() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  // One Zustand store per window (per session). We instantiate it inside
  // the component but cache the factory result on the first render so
  // re-renders don't blow it away.
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = createTgClientStore();
  const useStore = storeRef.current;
  const status = useStore((s) => s.status);
  const errorMessage = useStore((s) => s.errorMessage);
  const me = useStore((s) => s.me);
  const socketStatus = useStore((s) => s.socketStatus);

  const [retryToken, setRetryToken] = useState(0);

  // Ensure the user is logged into the panel itself; if not, redirect to
  // the panel's login page rather than rendering an empty shell.
  useEffect(() => {
    if (!isAuthenticated) navigate('/login', { replace: true });
  }, [isAuthenticated, navigate]);

  // Connect + initial bootstrap.
  useEffect(() => {
    if (!isAuthenticated || !sessionId) return undefined;

    let cancelled = false;
    const state = useStore.getState();
    state.setStatus('connecting');

    (async () => {
      try {
        const { data } = await connectClientSession(sessionId);
        if (cancelled) return;
        const result = data?.data || {};
        if (result.me) state.setMe(result.me);

        state.setDialogsLoading(true);
        const { data: dlgData } = await getClientDialogs(sessionId, { limit: 100 });
        if (cancelled) return;
        const payload = dlgData?.data || {};
        state.setDialogs(payload.dialogs || []);
        state.setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        const msg =
          err?.response?.data?.error ||
          err?.message ||
          'Failed to connect this session';
        state.setStatus('error', msg);
        state.setDialogsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, isAuthenticated, retryToken, useStore]);

  // Socket subscription (separate effect so a connect failure still leaves
  // the socket cleaned up properly).
  useTelegramClientSocket(sessionId, useStore);

  // Update document title with active dialog name + account label.
  const accountLabel = useMemo(() => {
    if (!me) return null;
    const name = [me.firstName, me.lastName].filter(Boolean).join(' ').trim();
    return name || me.username || me.phone || `Session #${sessionId}`;
  }, [me, sessionId]);

  const [activeDialogTitle, setActiveDialogTitle] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const capabilities = useCapabilities();
  const canContacts = !!capabilities?.tgc_contacts;
  const canNotifications = !!capabilities?.tgc_notifications;
  useEffect(() => {
    const parts = [activeDialogTitle, accountLabel].filter(Boolean);
    document.title =
      parts.length > 0
        ? `${parts.join(' — ')} · Telegram`
        : `Telegram client · #${sessionId}`;
  }, [activeDialogTitle, accountLabel, sessionId]);

  if (!isAuthenticated) return null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-dark-950">
      {/* Top status bar */}
      <div className="flex w-full flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-white/5 bg-dark-900 px-4 py-2">
          {me ? (
            <button
              type="button"
              onClick={() => setProfileOpen(true)}
              className="-mx-1 flex min-w-0 items-center gap-3 rounded-md px-1 py-0.5 text-left hover:bg-white/5"
              title="View my profile"
            >
              <Avatar
                sessionId={sessionId}
                peerType="user"
                peerId={Number(me.id)}
                label={accountLabel}
                size="sm"
              />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-gray-100">
                  {accountLabel}
                </div>
                <div className="truncate text-[11px] text-gray-500">
                  Session #{sessionId}
                  {me.username ? ` · @${me.username}` : ''}
                  {me.phone ? ` · ${me.phone}` : ''}
                </div>
              </div>
            </button>
          ) : (
            <div className="text-sm text-gray-400">Connecting…</div>
          )}
          <div className="relative ml-auto flex items-center gap-2">
            {canContacts && (
              <button
                type="button"
                onClick={() => setContactsOpen(true)}
                className="rounded-md p-1.5 text-gray-400 hover:bg-white/5 hover:text-gray-200"
                title="Contacts"
              >
                <Users className="h-4 w-4" />
              </button>
            )}
            {canNotifications && (
              <NotificationCenter
                sessionId={sessionId}
                store={useStore}
                currentDialogTitle={activeDialogTitle}
              />
            )}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="rounded-md p-1.5 text-gray-400 hover:bg-white/5 hover:text-gray-200"
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </button>
            <ConnectionPill socketStatus={socketStatus} status={status} />
          </div>
        </header>

        {/* Main split */}
        <div className="flex min-h-0 flex-1">
          {status === 'error' ? (
            <div className="flex w-full flex-col items-center justify-center gap-3 text-gray-400">
              <AlertCircle className="h-6 w-6 text-red-400" />
              <div className="max-w-md text-center text-sm">{errorMessage}</div>
              <button
                onClick={() => setRetryToken((n) => n + 1)}
                className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-gray-100 hover:bg-white/5"
              >
                Retry
              </button>
            </div>
          ) : status === 'connecting' ? (
            <div className="flex w-full items-center justify-center gap-2 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Connecting your Telegram session…
            </div>
          ) : (
            <>
              <aside className="w-[320px] shrink-0 border-r border-white/5">
                <DialogList sessionId={sessionId} store={useStore} />
              </aside>
              <main className="min-w-0 flex-1">
                <ChatPane
                  sessionId={sessionId}
                  store={useStore}
                  onTitleChange={setActiveDialogTitle}
                />
              </main>
            </>
          )}
        </div>
      </div>

      <SelfProfileDrawer
        sessionId={sessionId}
        isOpen={profileOpen}
        onClose={() => setProfileOpen(false)}
        onProfileLoaded={(p) => p && useStore.getState().setMe({ ...useStore.getState().me, ...p })}
      />

      <SettingsDrawer
        sessionId={sessionId}
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

      <ContactsDrawer
        sessionId={sessionId}
        isOpen={contactsOpen}
        onClose={() => setContactsOpen(false)}
        onOpenChat={({ peerType, peerId }) => {
          // Reuse the existing dialog when present, otherwise insert a
          // minimal placeholder so the chat pane resolves the entity on
          // first message-fetch and the row appears in the left rail.
          const state = useStore.getState();
          const k = `${peerType}:${peerId}`;
          if (!state.dialogs.has(k)) {
            state.upsertDialog({
              peerType,
              peerId,
              title: '',
              unreadCount: 0,
              lastMessage: null,
            });
          }
          state.selectPeer(peerType, peerId);
        }}
      />
    </div>
  );
}

function ConnectionPill({ socketStatus, status }) {
  const ok = socketStatus === 'connected';
  const Icon = ok ? Wifi : WifiOff;
  const colorClass = ok
    ? 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10'
    : socketStatus === 'connecting' || status === 'connecting'
    ? 'text-amber-300 border-amber-300/30 bg-amber-300/10'
    : 'text-red-300 border-red-300/30 bg-red-300/10';
  const label = ok
    ? 'Live'
    : socketStatus === 'connecting' || status === 'connecting'
    ? 'Connecting'
    : socketStatus === 'disconnected'
    ? 'Offline'
    : 'Error';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${colorClass}`}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}
