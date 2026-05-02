import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';

// Use relative URL (same origin) since WebSocket is proxied through nginx
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}` : '');

const SUBSCRIBE_EVENT = 'platform:subscribe';
const UNSUBSCRIBE_EVENT = 'platform:unsubscribe';

/**
 * useWebSocket — thin wrapper around the Socket.IO client.
 *
 * Multiplatform note (Phase 3): on connect we now also send a
 *   socket.emit('platform:subscribe', { platform })
 * for the current panel platform so the backend can join the
 * `platform:<id>:<platform>` room. The server scopes notifications,
 * job-progress, and live counters by platform so the IG dashboard
 * doesn't see TG events and vice versa. Switching platforms via the
 * header toggle automatically re-subscribes — see the second useEffect
 * below that watches localStorage('panel_platform').
 */
export function useWebSocket() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const subscribedPlatformRef = useRef(null);

  const _activePlatform = () => {
    try {
      const stored = localStorage.getItem('panel_platform');
      if (stored === 'telegram' || stored === 'instagram') return stored;
    } catch (_) { /* SSR */ }
    return 'telegram';
  };

  const _resubscribe = useCallback(() => {
    const sock = socketRef.current;
    if (!sock || !sock.connected) return;
    const next = _activePlatform();
    if (subscribedPlatformRef.current === next) return;
    if (subscribedPlatformRef.current) {
      sock.emit(UNSUBSCRIBE_EVENT, { platform: subscribedPlatformRef.current });
    }
    sock.emit(SUBSCRIBE_EVENT, { platform: next });
    subscribedPlatformRef.current = next;
  }, []);

  const connect = useCallback((token) => {
    if (socketRef.current?.connected) return;

    socketRef.current = io(SOCKET_URL, {
      auth: { token },
      // Stamp the platform on the handshake so the server can join the
      // right room before the first event flows.
      query: { platform: _activePlatform() },
      transports: ['websocket', 'polling'],
    });

    socketRef.current.on('connect', () => {
      setConnected(true);
      _resubscribe();
    });

    socketRef.current.on('disconnect', () => {
      setConnected(false);
      subscribedPlatformRef.current = null;
    });

    socketRef.current.on('notification', (data) => {
      setNotifications((prev) => [...prev.slice(-9), data]);
    });

    return socketRef.current;
  }, [_resubscribe]);

  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
      setConnected(false);
      subscribedPlatformRef.current = null;
    }
  }, []);

  const emit = useCallback((event, data) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit(event, data);
    }
  }, []);

  const on = useCallback((event, callback) => {
    if (socketRef.current) {
      socketRef.current.on(event, callback);
    }
    // Always return a cleanup that's safe to call even after the socket
    // has been disconnected (e.g. on unmount or React StrictMode double
    // invocation). Reading socketRef.current at call-time prevents the
    // "Cannot read properties of null (reading 'off')" crash that broke
    // the Get OTP and Change 2FA pages.
    return () => {
      const sock = socketRef.current;
      if (sock) sock.off(event, callback);
    };
  }, []);

  const off = useCallback((event, callback) => {
    const sock = socketRef.current;
    if (sock) sock.off(event, callback);
  }, []);

  // Watch for platform-toggle changes (handled by PlatformContext writing
  // localStorage('panel_platform')) and re-subscribe on the open socket.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e) => {
      if (e.key === 'panel_platform') _resubscribe();
    };
    window.addEventListener('storage', onStorage);
    // Same-tab updates don't fire 'storage' — use a custom event from
    // PlatformContext instead. Fallback poll every 2s in case nothing
    // dispatches the event.
    const pollId = setInterval(_resubscribe, 2000);
    return () => {
      window.removeEventListener('storage', onStorage);
      clearInterval(pollId);
    };
  }, [_resubscribe]);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return { socket: socketRef.current, connected, notifications, connect, disconnect, emit, on, off };
}
