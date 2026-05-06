/**
 * Per-session Zustand store for the in-panel Telegram client.
 *
 * One store instance per browser window — sessions in different windows
 * therefore have completely isolated state. We keep the per-store factory
 * exported so each window can call `createTgClientStore(sessionId)` once
 * on mount and pass the resulting hook to its subtree.
 *
 * Shape:
 *   - me                     normalized self user
 *   - dialogs                Map<peerKey, Dialog>
 *   - dialogOrder            string[]   (peer keys, sorted by recency)
 *   - selectedPeerKey        string | null
 *   - messagesByPeer         Map<peerKey, Message[]>   (descending: newest first)
 *   - sendersByKey           Map<peerKey, Sender>      (cached from getMessages)
 *   - typingByPeer           Map<peerKey, { fromId, expiresAt }>
 *   - status                 'idle' | 'connecting' | 'ready' | 'error'
 *   - errorMessage           string | null
 *
 * peerKey format: `${peerType}:${peerId}` so user 5 and chat 5 don't collide.
 */

import { create } from 'zustand';

export function peerKey(peerType, peerId) {
  return `${peerType}:${peerId}`;
}

export function peerKeyOf(obj) {
  if (!obj) return null;
  if (obj.peerType && obj.peerId != null) return peerKey(obj.peerType, obj.peerId);
  return null;
}

const DIALOG_INITIAL = () => ({
  me: null,
  status: 'idle',
  errorMessage: null,
  socketStatus: 'idle', // 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

  dialogs: new Map(),
  dialogOrder: [],
  dialogsLoaded: false,
  dialogsLoading: false,

  selectedPeerKey: null,

  messagesByPeer: new Map(),
  messageLoadingByPeer: new Map(),

  sendersByKey: new Map(),
  typingByPeer: new Map(),

  // Optimistic outgoing messages keyed by clientMsgId (uuid). Cleared on ack.
  pendingOutgoing: new Map(),

  // Live media-upload progress per pending clientMsgId, in [0,1].
  uploadProgressByClientId: new Map(),

  // Currently-quoted message in the composer (D3). Only one slot per
  // window; null means "no reply staged".
  replyTarget: null,

  // Currently-edited message id (D3). When set, the composer opens
  // pre-filled with that message's text and submits as a PATCH.
  editTarget: null,
});

function _sortDialogOrder(dialogs) {
  // Most recent message first; pinned dialogs always at the top.
  const arr = Array.from(dialogs.values());
  arr.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    const ad = a.lastMessage?.date ? new Date(a.lastMessage.date).getTime() : 0;
    const bd = b.lastMessage?.date ? new Date(b.lastMessage.date).getTime() : 0;
    return bd - ad;
  });
  return arr.map((d) => peerKey(d.peerType, d.peerId));
}

export function createTgClientStore() {
  return create((set, get) => ({
    ...DIALOG_INITIAL(),

    setStatus: (status, errorMessage = null) => set({ status, errorMessage }),
    setSocketStatus: (socketStatus) => set({ socketStatus }),
    setMe: (me) => set({ me }),

    // Replace the entire dialog list (initial fetch).
    setDialogs: (list) => {
      const next = new Map();
      for (const d of list || []) {
        next.set(peerKey(d.peerType, d.peerId), d);
      }
      set({
        dialogs: next,
        dialogOrder: _sortDialogOrder(next),
        dialogsLoaded: true,
        dialogsLoading: false,
      });
    },

    setDialogsLoading: (v) => set({ dialogsLoading: !!v }),

    upsertDialog: (dialog) => {
      const k = peerKey(dialog.peerType, dialog.peerId);
      const next = new Map(get().dialogs);
      const prev = next.get(k);
      next.set(k, { ...(prev || {}), ...dialog });
      set({
        dialogs: next,
        dialogOrder: _sortDialogOrder(next),
      });
    },

    selectPeer: (peerType, peerId) => {
      const k = peerKey(peerType, peerId);
      set({ selectedPeerKey: k });
    },

    setMessages: (peerType, peerId, messages, senders) => {
      const k = peerKey(peerType, peerId);
      const nextMessages = new Map(get().messagesByPeer);
      // Backend returns newest-first; flip to oldest-first for rendering.
      const flipped = [...(messages || [])].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      nextMessages.set(k, flipped);

      const nextSenders = new Map(get().sendersByKey);
      for (const s of senders || []) {
        nextSenders.set(peerKey(s.peerType, s.peerId), s);
      }
      set({ messagesByPeer: nextMessages, sendersByKey: nextSenders });
    },

    prependMessages: (peerType, peerId, olderMessages) => {
      const k = peerKey(peerType, peerId);
      const nextMessages = new Map(get().messagesByPeer);
      const existing = nextMessages.get(k) || [];
      const seen = new Set(existing.map((m) => m.id));
      const incoming = [...(olderMessages || [])]
        .filter((m) => m && m.id != null && !seen.has(m.id))
        .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      nextMessages.set(k, [...incoming, ...existing]);
      set({ messagesByPeer: nextMessages });
    },

    appendMessage: (peerType, peerId, message) => {
      const k = peerKey(peerType, peerId);
      const nextMessages = new Map(get().messagesByPeer);
      const existing = nextMessages.get(k) || [];
      if (message && message.id != null && existing.some((m) => m.id === message.id)) {
        return;
      }
      nextMessages.set(k, [...existing, message]);
      set({ messagesByPeer: nextMessages });
    },

    removeMessages: (peerType, peerId, ids) => {
      const k = peerKey(peerType, peerId);
      const nextMessages = new Map(get().messagesByPeer);
      const existing = nextMessages.get(k);
      if (!existing) return;
      const drop = new Set(ids.map((v) => Number(v)).filter(Number.isFinite));
      if (drop.size === 0) return;
      const filtered = existing.filter((m) => !drop.has(Number(m.id)));
      if (filtered.length === existing.length) return;
      nextMessages.set(k, filtered);
      // If the dialog's lastMessage was deleted, replace it with the
      // newest remaining message (or null) so the left-rail preview
      // doesn't get stuck on a phantom.
      const nextDialogs = new Map(get().dialogs);
      const dialog = nextDialogs.get(k);
      let nextOrder = get().dialogOrder;
      if (dialog && dialog.lastMessage && drop.has(Number(dialog.lastMessage.id))) {
        const newLast = filtered.length ? filtered[filtered.length - 1] : null;
        nextDialogs.set(k, { ...dialog, lastMessage: newLast });
        nextOrder = _sortDialogOrder(nextDialogs);
      }
      set({ messagesByPeer: nextMessages, dialogs: nextDialogs, dialogOrder: nextOrder });
    },

    setReplyTarget: (target) => set({ replyTarget: target, editTarget: null }),
    setEditTarget: (target) => set({ editTarget: target, replyTarget: null }),
    clearComposeTargets: () => set({ replyTarget: null, editTarget: null }),

    replaceMessage: (peerType, peerId, edited) => {
      if (!edited || edited.id == null) return;
      const k = peerKey(peerType, peerId);
      const nextMessages = new Map(get().messagesByPeer);
      const existing = nextMessages.get(k);
      if (!existing) return;
      const idx = existing.findIndex((m) => m.id === edited.id);
      if (idx === -1) return;
      const copy = existing.slice();
      copy[idx] = { ...existing[idx], ...edited };
      nextMessages.set(k, copy);
      set({ messagesByPeer: nextMessages });
    },

    addPendingOutgoing: (peerType, peerId, clientMsgId, message) => {
      const next = new Map(get().pendingOutgoing);
      next.set(clientMsgId, { peerType, peerId, message });
      set({ pendingOutgoing: next });
    },

    resolvePendingOutgoing: (clientMsgId, finalMessage) => {
      const pending = get().pendingOutgoing.get(clientMsgId);
      if (!pending) return;
      const next = new Map(get().pendingOutgoing);
      next.delete(clientMsgId);
      const k = peerKey(pending.peerType, pending.peerId);
      const nextMessages = new Map(get().messagesByPeer);
      const existing = nextMessages.get(k) || [];

      // Drop the optimistic row by clientMsgId.
      let filtered = existing.filter((m) => m.clientMsgId !== clientMsgId);

      // The Socket.IO broadcast (`tg-client:newMessage`) and the HTTP
      // response race each other — both originate from the same backend
      // sendMessage call. If the socket event won the race the final
      // row is already in the store, keyed by `message.id`. In that
      // case we MUST NOT append again or the chat pane shows the same
      // bubble twice.
      const alreadyHasFinal =
        finalMessage &&
        finalMessage.id != null &&
        filtered.some((m) => m.id === finalMessage.id);
      if (!alreadyHasFinal) {
        filtered = [...filtered, finalMessage];
      }
      nextMessages.set(k, filtered);

      // Bump this dialog's preview locally so the left-rail row updates
      // before the round-tripped Socket.IO `tg-client:dialogUpdate`
      // arrives (and even when GramJS's own NewMessage event fails to
      // fire for the outgoing — e.g. on flaky media-DC proxies).
      const nextDialogs = new Map(get().dialogs);
      const prevDialog = nextDialogs.get(k);
      let nextOrder = get().dialogOrder;
      if (prevDialog) {
        nextDialogs.set(k, {
          ...prevDialog,
          lastMessage: finalMessage,
        });
        nextOrder = _sortDialogOrder(nextDialogs);
      }

      const nextUpload = new Map(get().uploadProgressByClientId);
      nextUpload.delete(clientMsgId);
      set({
        pendingOutgoing: next,
        messagesByPeer: nextMessages,
        dialogs: nextDialogs,
        dialogOrder: nextOrder,
        uploadProgressByClientId: nextUpload,
      });
    },

    failPendingOutgoing: (clientMsgId, errorMessage) => {
      const pending = get().pendingOutgoing.get(clientMsgId);
      if (!pending) return;
      const next = new Map(get().pendingOutgoing);
      next.delete(clientMsgId);
      const k = peerKey(pending.peerType, pending.peerId);
      const nextMessages = new Map(get().messagesByPeer);
      const existing = nextMessages.get(k) || [];
      const idx = existing.findIndex((m) => m.clientMsgId === clientMsgId);
      if (idx !== -1) {
        const copy = existing.slice();
        copy[idx] = { ...existing[idx], failed: true, error: errorMessage };
        nextMessages.set(k, copy);
      }
      const nextUpload = new Map(get().uploadProgressByClientId);
      nextUpload.delete(clientMsgId);
      set({
        pendingOutgoing: next,
        messagesByPeer: nextMessages,
        uploadProgressByClientId: nextUpload,
      });
    },

    bumpDialogPreview: (peerType, peerId, lastMessage, unreadDelta = 0) => {
      const k = peerKey(peerType, peerId);
      const next = new Map(get().dialogs);
      const prev = next.get(k);
      if (!prev) {
        // Dialog isn't in our cache — ignore. The next fetchDialogs() pulls it in.
        return;
      }
      const updated = {
        ...prev,
        lastMessage,
        unreadCount: Math.max(0, (prev.unreadCount || 0) + (unreadDelta || 0)),
      };
      next.set(k, updated);
      set({ dialogs: next, dialogOrder: _sortDialogOrder(next) });
    },

    clearUnread: (peerType, peerId) => {
      const k = peerKey(peerType, peerId);
      const next = new Map(get().dialogs);
      const prev = next.get(k);
      if (!prev) return;
      next.set(k, { ...prev, unreadCount: 0, unreadMentionsCount: 0 });
      set({ dialogs: next });
    },

    setUploadProgress: (clientMsgId, progress) => {
      if (!clientMsgId) return;
      const next = new Map(get().uploadProgressByClientId);
      const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
      if (clamped >= 1) {
        next.delete(clientMsgId);
      } else {
        next.set(clientMsgId, clamped);
      }
      set({ uploadProgressByClientId: next });
    },

    clearUploadProgress: (clientMsgId) => {
      if (!clientMsgId) return;
      const next = new Map(get().uploadProgressByClientId);
      if (!next.has(clientMsgId)) return;
      next.delete(clientMsgId);
      set({ uploadProgressByClientId: next });
    },
  }));
}
