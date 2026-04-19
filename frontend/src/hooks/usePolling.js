import { useEffect, useRef, useCallback } from 'react';

export function usePolling(callback, interval = 15000, enabled = true) {
  const savedCallback = useRef(callback);
  const intervalRef = useRef(null);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  const start = useCallback(() => {
    if (intervalRef.current) return;
    
    savedCallback.current();
    intervalRef.current = setInterval(() => {
      savedCallback.current();
    }, interval);
  }, [interval]);

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      start();
    } else {
      stop();
    }
    return () => stop();
  }, [enabled, start, stop]);

  return { start, stop };
}
