import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';

// Use relative URL (same origin) since WebSocket is proxied through nginx
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}` : '');

export function useWebSocket() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [notifications, setNotifications] = useState([]);

  const connect = useCallback((token) => {
    if (socketRef.current?.connected) return;

    socketRef.current = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    socketRef.current.on('connect', () => {
      setConnected(true);
    });

    socketRef.current.on('disconnect', () => {
      setConnected(false);
    });

    socketRef.current.on('notification', (data) => {
      setNotifications((prev) => [...prev.slice(-9), data]);
    });

    return socketRef.current;
  }, []);

  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
      setConnected(false);
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

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return { socket: socketRef.current, connected, notifications, connect, disconnect, emit, on, off };
}
