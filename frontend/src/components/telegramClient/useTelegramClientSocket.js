/**
 * useTelegramClientSocket — sets up a per-window Socket.IO connection
 * scoped to a single Telegram session.
 *
 * Each TG client window is a fresh React tree (opened via window.open),
 * so its socket is fully separate from the main panel's socket. We
 * authenticate with the same JWT in localStorage and immediately call
 * `tg-client:subscribe` to join the per-session room.
 */

import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { invalidateProfilePhoto } from './useProfilePhoto';

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.host}`
    : '');

export function useTelegramClientSocket(sessionId, store) {
  const socketRef = useRef(null);

  useEffect(() => {
    if (!sessionId) return undefined;
    const token = (() => {
      try { return localStorage.getItem('token'); } catch { return null; }
    })();
    if (!token) {
      store.getState().setSocketStatus('error');
      return undefined;
    }

    store.getState().setSocketStatus('connecting');
    const socket = io(SOCKET_URL, {
      auth: { token },
      query: { platform: 'telegram' },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    const subscribe = () => {
      socket.emit(
        'tg-client:subscribe',
        { sessionId: String(sessionId) },
        (ack) => {
          if (ack && ack.ok) {
            store.getState().setSocketStatus('connected');
          } else {
            store.getState().setSocketStatus('error');
          }
        }
      );
    };

    socket.on('connect', subscribe);
    socket.on('disconnect', () => {
      store.getState().setSocketStatus('disconnected');
    });
    socket.on('connect_error', () => {
      store.getState().setSocketStatus('error');
    });

    socket.on('tg-client:newMessage', (data) => {
      if (!data || String(data.sessionId) !== String(sessionId)) return;
      const { chat, message } = data;
      if (!chat || !message) return;
      const state = store.getState();
      // Skip if this is the ack of one of our own optimistic sends —
      // resolvePendingOutgoing will already have inserted the final row.
      const k = `${chat.peerType}:${chat.peerId}`;
      const existing = state.messagesByPeer.get(k) || [];
      if (existing.some((m) => m.id === message.id)) return;
      state.appendMessage(chat.peerType, chat.peerId, message);
      // Track sender for avatar/name rendering.
      if (data.sender) {
        const nextSenders = new Map(state.sendersByKey);
        nextSenders.set(`${data.sender.peerType}:${data.sender.peerId}`, data.sender);
        store.setState({ sendersByKey: nextSenders });
      }
    });

    socket.on('tg-client:editMessage', (data) => {
      if (!data || String(data.sessionId) !== String(sessionId)) return;
      const m = data.message;
      if (!m || m.id == null) return;
      // We don't know the peer key from the edit alone; iterate.
      const messagesByPeer = store.getState().messagesByPeer;
      for (const [k, list] of messagesByPeer.entries()) {
        if (list.some((x) => x.id === m.id)) {
          const [peerType, peerIdStr] = k.split(':');
          store.getState().replaceMessage(peerType, Number(peerIdStr), m);
          break;
        }
      }
    });

    socket.on('tg-client:deleteMessages', (data) => {
      if (!data || String(data.sessionId) !== String(sessionId)) return;
      const ids = Array.isArray(data.messageIds) ? data.messageIds : [];
      if (ids.length === 0) return;
      // If the broadcast carries an explicit peer (service-emitted), we
      // use it directly. Otherwise (raw-update path), drop matching ids
      // from every peer this window has loaded — the stream-level
      // delete event only carries channel ids.
      if (data.peerType && data.peerId != null) {
        store.getState().removeMessages(data.peerType, data.peerId, ids);
        return;
      }
      const messagesByPeer = store.getState().messagesByPeer;
      const idSet = new Set(ids.map(Number));
      for (const [k, list] of messagesByPeer.entries()) {
        if (list.some((x) => idSet.has(Number(x.id)))) {
          const [peerType, peerIdStr] = k.split(':');
          store.getState().removeMessages(peerType, Number(peerIdStr), ids);
        }
      }
    });

    socket.on('tg-client:dialogUpdate', (data) => {
      if (!data || String(data.sessionId) !== String(sessionId)) return;
      const { chat, lastMessage, unreadDelta } = data;
      if (!chat) return;
      store
        .getState()
        .bumpDialogPreview(chat.peerType, chat.peerId, lastMessage, unreadDelta || 0);
    });

    socket.on('tg-client:readHistory', (data) => {
      if (!data || String(data.sessionId) !== String(sessionId)) return;
      const peer = data.peer;
      if (!peer) return;
      // Inbox read = clear unread; outbox read is informational only.
      if (data.direction === 'inbox') {
        store.getState().clearUnread(peer.peerType, peer.peerId);
      }
    });

    socket.on('tg-client:uploadProgress', (data) => {
      if (!data || String(data.sessionId) !== String(sessionId)) return;
      const { clientMsgId, progress } = data;
      if (!clientMsgId) return;
      store.getState().setUploadProgress(clientMsgId, progress);
    });

    socket.on('tg-client:profileChanged', (data) => {
      if (!data || String(data.sessionId) !== String(sessionId)) return;
      const profile = data.profile;
      if (!profile) return;
      // Self update — refresh the cached `me` so headers / footers
      // reflect the new name+username, and invalidate the avatar cache
      // so a new photo loads instantly.
      if (data.kind === 'self') {
        store.getState().setMe(profile);
        if (profile.id != null) invalidateProfilePhoto(sessionId, 'user', Number(profile.id));
      } else if (data.kind === 'peer' && profile.id != null) {
        // D6 peer profile updates also flow through this event.
        const peerType = profile.peerType || 'user';
        invalidateProfilePhoto(sessionId, peerType, Number(profile.id));
      }
    });

    socket.on('tg-client:participantUpdate', (data) => {
      if (!data || String(data.sessionId) !== String(sessionId)) return;
      // The admin panel listens on the window to refresh its members
      // list. Using a CustomEvent keeps this decoupled from the Zustand
      // store (members are panel-local, not store-global).
      try {
        window.dispatchEvent(new CustomEvent('tg-client:participantUpdate', { detail: data }));
      } catch (_) { /* ignore */ }
    });

    socket.on('tg-client:contactsChanged', (data) => {
      if (!data || String(data.sessionId) !== String(sessionId)) return;
      // The contacts drawer listens on the window to refresh its list
      // when our contacts change side-channel (another device, another
      // panel window, or as a side-effect of addContact/deleteContacts).
      try {
        window.dispatchEvent(new CustomEvent('tg-client:contactsChanged', { detail: data }));
      } catch (_) { /* ignore */ }
    });

    socket.on('tg-client:typing', (data) => {
      if (!data || String(data.sessionId) !== String(sessionId)) return;
      // Typing indicators are best-effort; we just record them with a
      // 6-second TTL and let the UI decide whether to render.
      const peer = data.peer;
      if (!peer) return;
      const k = `${peer.peerType}:${peer.peerId}`;
      const nextTyping = new Map(store.getState().typingByPeer);
      nextTyping.set(k, { fromId: data.fromId, expiresAt: Date.now() + 6000 });
      store.setState({ typingByPeer: nextTyping });
    });

    return () => {
      try {
        socket.emit('tg-client:unsubscribe', { sessionId: String(sessionId) });
      } catch (_) { /* ignore */ }
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [sessionId, store]);

  return socketRef;
}
