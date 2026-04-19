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
      return () => socketRef.current.off(event, callback);
    }
  }, []);

  const off = useCallback((event, callback) => {
    if (socketRef.current) {
      socketRef.current.off(event, callback);
    }
  }, []);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return { socket: socketRef.current, connected, notifications, connect, disconnect, emit, on, off };
}
