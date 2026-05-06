import React, { useEffect, useMemo, useRef } from 'react';
import { Loader2, MessageSquare, RefreshCcw } from 'lucide-react';
import Avatar from './Avatar';
import MessageBubble from './MessageBubble';
import Composer from './Composer';
import { peerKey } from './tgClientStore';
import { useCapabilities } from '../../context/PlatformContext';
import {
  getClientMessages,
  sendClientMessage,
  markClientRead,
  sendClientMedia,
  sendClientVoice,
} from '../../api/telegramClient';

function _shouldShowSenderHeader(prev, current) {
  if (!current || current.out) return false;
  if (!prev) return true;
  if (prev.out !== current.out) return true;
  if (!prev.fromId || prev.fromId !== current.fromId) return true;
  return false;
}

function _shouldShowAvatar(next, current) {
  if (current?.out) return false;
  if (!next) return true;
  if (next.out !== current.out) return true;
  if (next.fromId !== current.fromId) return true;
  return false;
}

export default function ChatPane({ sessionId, store, onTitleChange }) {
  const selectedPeerKey = store((s) => s.selectedPeerKey);
  const dialogs = store((s) => s.dialogs);
  const messagesByPeer = store((s) => s.messagesByPeer);
  const sendersByKey = store((s) => s.sendersByKey);
  const setMessages = store((s) => s.setMessages);
  const appendMessage = store((s) => s.appendMessage);
  const addPendingOutgoing = store((s) => s.addPendingOutgoing);
  const resolvePendingOutgoing = store((s) => s.resolvePendingOutgoing);
  const failPendingOutgoing = store((s) => s.failPendingOutgoing);
  const clearUnread = store((s) => s.clearUnread);
  const me = store((s) => s.me);

  const uploadProgressByClientId = store((s) => s.uploadProgressByClientId);

  const capabilities = useCapabilities();
  const canSendMedia = !!capabilities?.tgc_send_media;

  const dialog = selectedPeerKey ? dialogs.get(selectedPeerKey) : null;
  const messages = selectedPeerKey ? messagesByPeer.get(selectedPeerKey) || [] : [];

  const scrollerRef = useRef(null);
  const lastLoadedKey = useRef(null);
  const [loadingMessages, setLoadingMessages] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState(null);

  // Notify parent (window title) of the active dialog name.
  useEffect(() => {
    if (onTitleChange) onTitleChange(dialog?.title || null);
  }, [dialog?.title, onTitleChange]);

  // Fetch messages whenever the selected peer changes.
  useEffect(() => {
    if (!dialog) return undefined;
    const k = peerKey(dialog.peerType, dialog.peerId);
    if (lastLoadedKey.current === k) return undefined;
    lastLoadedKey.current = k;

    let cancelled = false;
    setLoadingMessages(true);
    setErrorMessage(null);

    (async () => {
      try {
        const { data } = await getClientMessages(sessionId, dialog.peerType, dialog.peerId, {
          limit: 50,
        });
        if (cancelled) return;
        const payload = data?.data || data || {};
        setMessages(dialog.peerType, dialog.peerId, payload.messages || [], payload.senders || []);
        // Mark read up to the newest visible message.
        const newest = (payload.messages || []).reduce(
          (acc, m) => (m.id != null && m.id > acc ? m.id : acc),
          0
        );
        if (newest > 0) {
          markClientRead(sessionId, dialog.peerType, dialog.peerId, newest).catch(() => {});
          clearUnread(dialog.peerType, dialog.peerId);
        }
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(err?.response?.data?.error || err?.message || 'Failed to load messages');
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    dialog?.peerType,
    dialog?.peerId,
    sessionId,
    setMessages,
    clearUnread,
    dialog,
  ]);

  // Auto-scroll to the newest message whenever the list grows.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 200;
    if (nearBottom || messages.length > 0) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, selectedPeerKey]);

  const handleSend = async (text) => {
    if (!dialog) return false;
    const clientMsgId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const optimistic = {
      id: -Date.now(), // negative ids never collide with server ids
      clientMsgId,
      text,
      out: true,
      fromId: me?.id ? Number(me.id) : null,
      isSelf: true,
      date: new Date().toISOString(),
      pending: true,
      mediaKind: null,
      hasMedia: false,
    };
    appendMessage(dialog.peerType, dialog.peerId, optimistic);
    addPendingOutgoing(dialog.peerType, dialog.peerId, clientMsgId, optimistic);

    try {
      const { data } = await sendClientMessage(sessionId, dialog.peerType, dialog.peerId, {
        text,
      });
      const result = data?.data || {};
      const finalMessage = {
        id: result.messageId,
        text,
        out: true,
        fromId: me?.id ? Number(me.id) : null,
        isSelf: true,
        date: result.date || new Date().toISOString(),
        pending: false,
      };
      resolvePendingOutgoing(clientMsgId, finalMessage);
      return true;
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to send';
      failPendingOutgoing(clientMsgId, msg);
      return false;
    }
  };

  const _mediaKindLabel = (k) => {
    if (k === 'photo') return 'Photo';
    if (k === 'video') return 'Video';
    if (k === 'audio') return 'Audio';
    if (k === 'voice') return 'Voice message';
    if (k === 'sticker') return 'Sticker';
    return 'File';
  };

  const handleSendMedia = async ({ file, kind, caption, clientMsgId }) => {
    if (!dialog || !file) return false;
    const optimistic = {
      id: -Date.now(),
      clientMsgId,
      text: caption || '',
      out: true,
      fromId: me?.id ? Number(me.id) : null,
      isSelf: true,
      date: new Date().toISOString(),
      pending: true,
      mediaKind: kind === 'voice' ? 'voice' : kind,
      hasMedia: true,
      mediaPreview: { fileName: file.name, size: file.size, kind, label: _mediaKindLabel(kind) },
    };
    appendMessage(dialog.peerType, dialog.peerId, optimistic);
    addPendingOutgoing(dialog.peerType, dialog.peerId, clientMsgId, optimistic);

    try {
      const { data } = await sendClientMedia(sessionId, dialog.peerType, dialog.peerId, {
        file,
        kind,
        caption,
        clientMsgId,
      });
      const result = data?.data || {};
      const finalMessage = result.message || {
        id: result.messageId,
        text: caption || '',
        out: true,
        fromId: me?.id ? Number(me.id) : null,
        isSelf: true,
        date: result.date || new Date().toISOString(),
        pending: false,
        hasMedia: true,
        mediaKind: kind,
      };
      resolvePendingOutgoing(clientMsgId, finalMessage);
      return true;
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err?.response?.data?.error || err?.message || 'Failed to send media';
      failPendingOutgoing(clientMsgId, msg);
      return false;
    }
  };

  const handleSendVoice = async ({ file, duration, clientMsgId }) => {
    if (!dialog || !file) return false;
    const optimistic = {
      id: -Date.now(),
      clientMsgId,
      text: '',
      out: true,
      fromId: me?.id ? Number(me.id) : null,
      isSelf: true,
      date: new Date().toISOString(),
      pending: true,
      mediaKind: 'voice',
      hasMedia: true,
      mediaPreview: { fileName: file.name, size: file.size, kind: 'voice', label: 'Voice message', duration },
    };
    appendMessage(dialog.peerType, dialog.peerId, optimistic);
    addPendingOutgoing(dialog.peerType, dialog.peerId, clientMsgId, optimistic);

    try {
      const { data } = await sendClientVoice(sessionId, dialog.peerType, dialog.peerId, {
        file,
        duration,
        clientMsgId,
      });
      const result = data?.data || {};
      const finalMessage = result.message || {
        id: result.messageId,
        text: '',
        out: true,
        fromId: me?.id ? Number(me.id) : null,
        isSelf: true,
        date: result.date || new Date().toISOString(),
        pending: false,
        hasMedia: true,
        mediaKind: 'voice',
      };
      resolvePendingOutgoing(clientMsgId, finalMessage);
      return true;
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err?.response?.data?.error || err?.message || 'Failed to send voice';
      failPendingOutgoing(clientMsgId, msg);
      return false;
    }
  };

  if (!dialog) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 bg-dark-950 text-gray-500">
        <MessageSquare className="h-10 w-10 opacity-40" />
        <div className="text-sm">Select a chat to start messaging.</div>
      </div>
    );
  }

  const senderForMessage = (m) => {
    if (m.out || m.fromId == null) return null;
    return sendersByKey.get(`user:${m.fromId}`) || null;
  };

  return (
    <div className="flex h-full flex-1 flex-col bg-dark-950">
      <div className="flex items-center gap-3 border-b border-white/5 bg-dark-900 px-4 py-3">
        <Avatar
          sessionId={sessionId}
          peerType={dialog.peerType}
          peerId={dialog.peerId}
          label={dialog.title}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-gray-100">
            {dialog.title || 'Untitled'}
          </div>
          <div className="truncate text-xs text-gray-500">
            {dialog.peerType === 'user' && dialog.username && `@${dialog.username}`}
            {dialog.peerType !== 'user' &&
              (dialog.participantsCount
                ? `${dialog.participantsCount.toLocaleString()} members`
                : dialog.peerType === 'channel'
                ? (dialog.isBroadcast ? 'Channel' : 'Supergroup')
                : 'Group')}
          </div>
        </div>
      </div>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-3 py-3">
        {loadingMessages && messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading messages…
          </div>
        ) : errorMessage ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-red-300">
            <span>{errorMessage}</span>
            <button
              className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-gray-200 hover:bg-white/5"
              onClick={() => {
                lastLoadedKey.current = null;
                setErrorMessage(null);
              }}
            >
              <RefreshCcw className="h-3 w-3" />
              Retry
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            No messages yet.
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {messages.map((m, idx) => {
              const prev = idx > 0 ? messages[idx - 1] : null;
              const next = idx < messages.length - 1 ? messages[idx + 1] : null;
              return (
                <MessageBubble
                  key={`${m.id}-${m.clientMsgId || ''}`}
                  sessionId={sessionId}
                  message={m}
                  sender={senderForMessage(m)}
                  showSenderHeader={dialog.peerType !== 'user' && _shouldShowSenderHeader(prev, m)}
                  showAvatar={dialog.peerType !== 'user' && _shouldShowAvatar(next, m)}
                  peerType={dialog.peerType}
                  peerId={dialog.peerId}
                  uploadProgress={
                    m.clientMsgId ? uploadProgressByClientId.get(m.clientMsgId) : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      <Composer
        disabled={loadingMessages && messages.length === 0}
        onSend={handleSend}
        onSendMedia={canSendMedia ? handleSendMedia : undefined}
        onSendVoice={canSendMedia ? handleSendVoice : undefined}
        uploadProgressByClientId={uploadProgressByClientId}
      />
    </div>
  );
}
