import React, { useEffect, useMemo, useRef } from 'react';
import { Loader2, MessageSquare, RefreshCcw, Search } from 'lucide-react';
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
  sendClientSticker,
  editClientMessage,
  deleteClientMessages,
  forwardClientMessages,
  saveDraft,
  clearDraft,
  pinMessage,
  unpinMessage,
  unpinAllMessages,
  getPinnedMessages,
} from '../../api/telegramClient';
import ForwardDialog from './ForwardDialog';
import PeerProfileDrawer from './PeerProfileDrawer';
import PinnedBanner from './PinnedBanner';
import ChatSearchPanel from './ChatSearchPanel';

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
  const replyTarget = store((s) => s.replyTarget);
  const editTarget = store((s) => s.editTarget);
  const setReplyTarget = store((s) => s.setReplyTarget);
  const setEditTarget = store((s) => s.setEditTarget);
  const clearComposeTargets = store((s) => s.clearComposeTargets);
  const replaceMessage = store((s) => s.replaceMessage);
  const removeMessages = store((s) => s.removeMessages);
  const dialogOrder = store((s) => s.dialogOrder);

  const capabilities = useCapabilities();
  const canSendMedia = !!capabilities?.tgc_send_media;
  const canMessageActions = !!capabilities?.tgc_message_actions;
  const canDrafts = !!capabilities?.tgc_drafts;
  const canPinned = !!capabilities?.tgc_pinned;
  const canSearch = !!capabilities?.tgc_search;
  const canStickers = !!capabilities?.tgc_stickers;

  const setDraftInStore = store((s) => s.setDraft);
  const setPinnedIds = store((s) => s.setPinnedIds);
  const removePinnedIds = store((s) => s.removePinnedIds);
  const addPinnedIds = store((s) => s.addPinnedIds);
  const pinnedByPeer = store((s) => s.pinnedByPeer);

  const dialog = selectedPeerKey ? dialogs.get(selectedPeerKey) : null;
  const messages = selectedPeerKey ? messagesByPeer.get(selectedPeerKey) || [] : [];
  const pinnedIds = selectedPeerKey ? pinnedByPeer.get(selectedPeerKey) || [] : [];

  const messagesById = useMemo(() => {
    const map = new Map();
    for (const m of messages) {
      if (m && m.id != null) map.set(Number(m.id), m);
    }
    return map;
  }, [messages]);

  const [forwardingMessage, setForwardingMessage] = React.useState(null);
  const [actionError, setActionError] = React.useState(null);
  const [peerProfileOpen, setPeerProfileOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);

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

  // D13 — fetch the chat's pinned messages on chat-open. Live updates
  // (pin / unpin / unpin-all) flow in via tg-client:pinnedUpdate.
  useEffect(() => {
    if (!dialog || !canPinned) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await getPinnedMessages(sessionId, dialog.peerType, dialog.peerId, {
          limit: 50,
        });
        if (cancelled) return;
        const payload = data?.data || data || {};
        const ids = (payload.messages || []).map((m) => Number(m.id)).filter(Number.isFinite);
        setPinnedIds(dialog.peerType, dialog.peerId, ids);
      } catch (_) {
        // Pinned-message fetch is non-critical; banner just stays empty.
      }
    })();
    return () => { cancelled = true; };
  }, [dialog?.peerType, dialog?.peerId, sessionId, canPinned, setPinnedIds, dialog]);

  // D12 — debounced server-side draft save.
  const draftSaveTimerRef = useRef(null);
  const lastDraftSentRef = useRef('');
  const handleDraftChange = React.useCallback(
    (value) => {
      if (!dialog || !canDrafts) return;
      // Optimistically update the in-memory dialog row so the
      // sidebar shows "Draft: …" immediately.
      setDraftInStore(dialog.peerType, dialog.peerId, value
        ? { text: value, date: new Date().toISOString(), replyToMsgId: null, noWebpage: false }
        : null);
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
      const peerType = dialog.peerType;
      const peerId = dialog.peerId;
      draftSaveTimerRef.current = setTimeout(async () => {
        if (lastDraftSentRef.current === value) return;
        lastDraftSentRef.current = value;
        try {
          if (value === '') {
            await clearDraft(sessionId, peerType, peerId);
          } else {
            await saveDraft(sessionId, peerType, peerId, { text: value });
          }
        } catch (_) { /* surface silently — typing should not fail loud */ }
      }, 350);
    },
    [dialog, sessionId, canDrafts, setDraftInStore]
  );

  // D13 — pin / unpin handlers used by the message bubble menu and the
  // pinned banner.
  const handlePin = React.useCallback(async (msg, opts = {}) => {
    if (!dialog || !msg || msg.id == null || msg.id < 0) return;
    try {
      await pinMessage(sessionId, dialog.peerType, dialog.peerId, msg.id, opts);
      addPinnedIds(dialog.peerType, dialog.peerId, [Number(msg.id)]);
    } catch (err) {
      setActionError(err?.response?.data?.error?.message || err?.message || 'Failed to pin');
    }
  }, [dialog, sessionId, addPinnedIds]);

  const handleUnpin = React.useCallback(async (msg) => {
    if (!dialog || !msg || msg.id == null || msg.id < 0) return;
    try {
      await unpinMessage(sessionId, dialog.peerType, dialog.peerId, msg.id);
      removePinnedIds(dialog.peerType, dialog.peerId, [Number(msg.id)]);
    } catch (err) {
      setActionError(err?.response?.data?.error?.message || err?.message || 'Failed to unpin');
    }
  }, [dialog, sessionId, removePinnedIds]);

  const handleUnpinAll = React.useCallback(async () => {
    if (!dialog) return;
    if (typeof window !== 'undefined' && !window.confirm('Unpin all pinned messages?')) return;
    try {
      await unpinAllMessages(sessionId, dialog.peerType, dialog.peerId);
      setPinnedIds(dialog.peerType, dialog.peerId, []);
    } catch (err) {
      setActionError(err?.response?.data?.error?.message || err?.message || 'Failed to unpin all');
    }
  }, [dialog, sessionId, setPinnedIds]);

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

    // Edit mode (D3): the composer is editing an existing message —
    // submit a PATCH and update the bubble in place.
    if (editTarget && editTarget.id != null && editTarget.id > 0) {
      try {
        await editClientMessage(sessionId, dialog.peerType, dialog.peerId, editTarget.id, text);
        replaceMessage(dialog.peerType, dialog.peerId, {
          id: editTarget.id,
          text,
          editDate: new Date().toISOString(),
        });
        clearComposeTargets();
        return true;
      } catch (err) {
        setActionError(err?.response?.data?.error?.message || err?.message || 'Failed to edit');
        return false;
      }
    }

    const replyToMsgId = replyTarget && replyTarget.id != null && replyTarget.id > 0
      ? Number(replyTarget.id)
      : null;
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
      replyToMsgId,
    };
    appendMessage(dialog.peerType, dialog.peerId, optimistic);
    addPendingOutgoing(dialog.peerType, dialog.peerId, clientMsgId, optimistic);
    if (replyToMsgId) clearComposeTargets();

    try {
      const { data } = await sendClientMessage(sessionId, dialog.peerType, dialog.peerId, {
        text,
        replyToMsgId,
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
        replyToMsgId,
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
    const replyToMsgId = replyTarget && replyTarget.id != null && replyTarget.id > 0
      ? Number(replyTarget.id)
      : null;
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
      replyToMsgId,
    };
    appendMessage(dialog.peerType, dialog.peerId, optimistic);
    addPendingOutgoing(dialog.peerType, dialog.peerId, clientMsgId, optimistic);
    if (replyToMsgId) clearComposeTargets();

    try {
      const { data } = await sendClientMedia(sessionId, dialog.peerType, dialog.peerId, {
        file,
        kind,
        caption,
        clientMsgId,
        replyToMsgId,
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
    const replyToMsgId = replyTarget && replyTarget.id != null && replyTarget.id > 0
      ? Number(replyTarget.id)
      : null;
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
      replyToMsgId,
    };
    appendMessage(dialog.peerType, dialog.peerId, optimistic);
    addPendingOutgoing(dialog.peerType, dialog.peerId, clientMsgId, optimistic);
    if (replyToMsgId) clearComposeTargets();

    try {
      const { data } = await sendClientVoice(sessionId, dialog.peerType, dialog.peerId, {
        file,
        duration,
        clientMsgId,
        replyToMsgId,
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

  const senderForMessage = (m) => {
    if (m.out || m.fromId == null) return null;
    return sendersByKey.get(`user:${m.fromId}`) || null;
  };

  const handleReply = (msg) => {
    if (!dialog || !msg || msg.id == null || msg.id < 0) return;
    setReplyTarget({
      id: msg.id,
      text: msg.text || (msg.mediaKind ? `[${msg.mediaKind}]` : ''),
      senderTitle: senderForMessage(msg)?.title || (msg.out ? 'You' : ''),
    });
  };

  const handleEdit = (msg) => {
    if (!dialog || !msg || !msg.out) return;
    setEditTarget({ id: msg.id, text: msg.text || '' });
  };

  const handleDelete = async (msg, revoke = true) => {
    if (!dialog || !msg || msg.id == null || msg.id < 0) return;
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        revoke
          ? 'Delete this message for everyone?'
          : 'Delete this message just for you?'
      );
      if (!ok) return;
    }
    try {
      await deleteClientMessages(sessionId, dialog.peerType, dialog.peerId, [msg.id], revoke);
      removeMessages(dialog.peerType, dialog.peerId, [msg.id]);
    } catch (err) {
      setActionError(err?.response?.data?.error?.message || err?.message || 'Failed to delete');
    }
  };

  const handleForward = (msg) => {
    if (!dialog || !msg || msg.id == null || msg.id < 0) return;
    setForwardingMessage({ ...msg, fromPeerType: dialog.peerType, fromPeerId: dialog.peerId });
  };

  const performForward = async ({ toPeerType, toPeerId }) => {
    if (!forwardingMessage) return;
    try {
      await forwardClientMessages(sessionId, {
        fromPeerType: forwardingMessage.fromPeerType,
        fromPeerId: forwardingMessage.fromPeerId,
        toPeerType,
        toPeerId,
        messageIds: [forwardingMessage.id],
      });
      setForwardingMessage(null);
    } catch (err) {
      setActionError(err?.response?.data?.error?.message || err?.message || 'Failed to forward');
    }
  };

  const handleJumpToMessage = (msgId) => {
    const el = scrollerRef.current?.querySelector(`#tgmsg-${msgId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-blue-300/70');
    setTimeout(() => el.classList.remove('ring-2', 'ring-blue-300/70'), 1500);
  };

  // D11 — pick-and-send sticker / GIF from the composer picker.
  const handleSendSticker = async (sticker) => {
    if (!dialog || !sticker) return false;
    const replyToMsgId = replyTarget && replyTarget.id != null && replyTarget.id > 0
      ? Number(replyTarget.id)
      : null;
    const clientMsgId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const optimistic = {
      id: -Date.now(),
      clientMsgId,
      text: '',
      out: true,
      fromId: me?.id ? Number(me.id) : null,
      isSelf: true,
      date: new Date().toISOString(),
      pending: true,
      mediaKind: 'sticker',
      hasMedia: true,
      replyToMsgId,
    };
    appendMessage(dialog.peerType, dialog.peerId, optimistic);
    addPendingOutgoing(dialog.peerType, dialog.peerId, clientMsgId, optimistic);
    if (replyToMsgId) clearComposeTargets();
    try {
      const { data } = await sendClientSticker(sessionId, dialog.peerType, dialog.peerId, {
        documentId: sticker.id,
        accessHash: sticker.accessHash,
        fileReference: sticker.fileReference,
        replyToMsgId,
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
        mediaKind: 'sticker',
      };
      resolvePendingOutgoing(clientMsgId, finalMessage);
      return true;
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err?.message || 'Failed to send sticker';
      failPendingOutgoing(clientMsgId, msg);
      return false;
    }
  };

  const handleSendGif = async (gif) => {
    if (!dialog || !gif) return false;
    return handleSendSticker({
      id: gif.id,
      accessHash: gif.accessHash,
      fileReference: gif.fileReference,
    });
  };

  const handleSearchJump = (msg) => {
    if (!msg || msg.id == null) return;
    setSearchOpen(false);
    // The chat may have only loaded the latest 50 messages; pull older
    // pages until the requested id appears, then jump to it. For now
    // we just scroll if it's already in the list.
    handleJumpToMessage(msg.id);
  };

  if (!dialog) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 bg-dark-950 text-gray-500">
        <MessageSquare className="h-10 w-10 opacity-40" />
        <div className="text-sm">Select a chat to start messaging.</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 flex-col bg-dark-950">
      <div className="flex items-stretch border-b border-white/5 bg-dark-900">
        <button
          type="button"
          onClick={() => setPeerProfileOpen(true)}
          className="flex flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-white/5"
          title="View profile"
        >
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
        </button>
        {canSearch && (
          <button
            type="button"
            onClick={() => setSearchOpen((v) => !v)}
            className={`px-3 text-gray-400 hover:bg-white/5 hover:text-gray-200 ${
              searchOpen ? 'bg-white/5 text-gray-200' : ''
            }`}
            title="Search in this chat"
            aria-label="Search in this chat"
          >
            <Search className="h-5 w-5" />
          </button>
        )}
      </div>

      {canPinned && pinnedIds.length > 0 && (
        <PinnedBanner
          sessionId={sessionId}
          peerType={dialog.peerType}
          peerId={dialog.peerId}
          pinnedIds={pinnedIds}
          messagesById={messagesById}
          onJumpToMessage={handleJumpToMessage}
          onUnpin={handleUnpin}
          onUnpinAll={handleUnpinAll}
        />
      )}

      {canSearch && searchOpen && (
        <ChatSearchPanel
          sessionId={sessionId}
          peerType={dialog.peerType}
          peerId={dialog.peerId}
          onClose={() => setSearchOpen(false)}
          onJump={handleSearchJump}
        />
      )}

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
                  messagesById={messagesById}
                  canMessageActions={canMessageActions}
                  onReply={canMessageActions ? handleReply : undefined}
                  onForward={canMessageActions ? handleForward : undefined}
                  onEdit={canMessageActions ? handleEdit : undefined}
                  onDelete={canMessageActions ? handleDelete : undefined}
                  onJumpToMessage={handleJumpToMessage}
                  isPinned={pinnedIds.includes(Number(m.id))}
                  canPinned={canPinned}
                  onPin={canPinned ? handlePin : undefined}
                  onUnpin={canPinned ? handleUnpin : undefined}
                />
              );
            })}
          </div>
        )}
      </div>

      {actionError && (
        <div className="mx-3 mb-1 rounded-md bg-red-900/40 px-3 py-1 text-xs text-red-300">
          {actionError}
          <button
            type="button"
            className="ml-2 text-red-200 underline"
            onClick={() => setActionError(null)}
          >dismiss</button>
        </div>
      )}

      <Composer
        disabled={loadingMessages && messages.length === 0}
        onSend={handleSend}
        onSendMedia={canSendMedia && !editTarget ? handleSendMedia : undefined}
        onSendVoice={canSendMedia && !editTarget ? handleSendVoice : undefined}
        onSendSticker={canStickers && !editTarget ? handleSendSticker : undefined}
        onSendGif={canStickers && !editTarget ? handleSendGif : undefined}
        uploadProgressByClientId={uploadProgressByClientId}
        replyTarget={replyTarget}
        editTarget={editTarget}
        onClearComposeTarget={clearComposeTargets}
        draftKey={canDrafts ? `${dialog.peerType}:${dialog.peerId}` : undefined}
        initialDraftText={canDrafts ? (dialog.draft?.text || '') : ''}
        onDraftChange={canDrafts ? handleDraftChange : undefined}
        showStickerButton={canStickers}
        sessionId={sessionId}
      />

      {forwardingMessage && (
        <ForwardDialog
          sessionId={sessionId}
          dialogs={dialogOrder.map((k) => dialogs.get(k)).filter(Boolean)}
          message={forwardingMessage}
          onCancel={() => setForwardingMessage(null)}
          onSelect={performForward}
        />
      )}

      <PeerProfileDrawer
        sessionId={sessionId}
        peerType={dialog.peerType}
        peerId={dialog.peerId}
        isOpen={peerProfileOpen}
        onClose={() => setPeerProfileOpen(false)}
      />
    </div>
  );
}
