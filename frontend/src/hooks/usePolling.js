import { useEffect, useRef, useCallback, useState } from 'react';

/**
 * Hook: returns true while the page is the foreground tab and the
 * window has the OS focus. Used to throttle pollers (and skip them
 * entirely when the tab is hidden) so we don't load the backend with
 * useless requests for tabs the user isn't even looking at.
 *
 * Re-exported so consumers can compose their own enabled-flags.
 */
export function usePageVisible() {
  const [visible, setVisible] = useState(
    typeof document === 'undefined'
      ? true
      : document.visibilityState !== 'hidden'
  );
  useEffect(() => {
    function onVis() {
      setVisible(document.visibilityState !== 'hidden');
    }
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    window.addEventListener('blur', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
      window.removeEventListener('blur', onVis);
    };
  }, []);
  return visible;
}

/**
 * usePolling — runs `callback` on a steady interval while `enabled`
 * is true. v8: also automatically suspends when the tab is hidden,
 * so a user with 10 tabs open doesn't multiply backend QPS by 10.
 * Pass `respectVisibility=false` to opt out (e.g. for a long-running
 * background sweep that has to keep ticking).
 */
export function usePolling(callback, interval = 15000, enabled = true, options = {}) {
  const { respectVisibility = true } = options;
  const savedCallback = useRef(callback);
  const intervalRef = useRef(null);
  const visible = usePageVisible();

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
    const shouldRun = enabled && (!respectVisibility || visible);
    if (shouldRun) {
      start();
    } else {
      stop();
    }
    return () => stop();
  }, [enabled, visible, respectVisibility, start, stop]);

  return { start, stop };
}
