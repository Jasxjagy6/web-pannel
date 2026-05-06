/**
 * Lightweight per-window cache of profile-photo object URLs.
 *
 * The backend serves /photo/:peerType/:peerId as raw JPEG bytes gated on
 * the panel JWT. <img src="..."> can't carry the JWT header, so we
 * fetch via axios (which does), turn the response into a Blob URL, and
 * memoize the result.
 *
 * Cache is window-local (Map keyed on `${sessionId}:${peerType}:${peerId}`)
 * — different windows have different stores, so the cache resets when
 * the user closes that account's window. The backend additionally sets
 * `Cache-Control: private, max-age=300`.
 */

import { useEffect, useState } from 'react';
import { fetchProfilePhotoBlob } from '../../api/telegramClient';

const _cache = new Map(); // key -> { url, promise }
const _listeners = new Set();

function _key(sessionId, peerType, peerId, large) {
  return `${sessionId}:${peerType}:${peerId}:${large ? 'big' : 'small'}`;
}

/**
 * Invalidate the cached blob URL for a given peer (both small and large)
 * and notify all live useProfilePhoto subscribers so they re-fetch.
 */
export function invalidateProfilePhoto(sessionId, peerType, peerId) {
  for (const variant of [false, true]) {
    const k = _key(sessionId, peerType, peerId, variant);
    const entry = _cache.get(k);
    if (entry?.url) {
      try { URL.revokeObjectURL(entry.url); } catch (_) { /* ignore */ }
    }
    _cache.delete(k);
  }
  _listeners.forEach((fn) => {
    try { fn(sessionId, peerType, peerId); } catch (_) { /* ignore */ }
  });
}

export function useProfilePhoto(sessionId, peerType, peerId, opts = {}) {
  const [url, setUrl] = useState(null);
  const [missing, setMissing] = useState(false);
  const [bust, setBust] = useState(0);
  const large = !!opts.large;

  // Subscribe to invalidation events so a profile-photo update on the
  // server re-triggers our fetch.
  useEffect(() => {
    const fn = (sid, pt, pid) => {
      if (
        String(sid) === String(sessionId) &&
        pt === peerType &&
        Number(pid) === Number(peerId)
      ) {
        setUrl(null);
        setMissing(false);
        setBust((n) => n + 1);
      }
    };
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
  }, [sessionId, peerType, peerId]);

  useEffect(() => {
    if (!sessionId || !peerType || peerId == null) return undefined;
    const k = _key(sessionId, peerType, peerId, large);
    const cached = _cache.get(k);
    if (cached?.url) {
      setUrl(cached.url);
      return undefined;
    }

    let cancelled = false;
    const promise =
      cached?.promise ||
      fetchProfilePhotoBlob(sessionId, peerType, peerId, { large })
        .then((blob) => {
          if (!blob) {
            _cache.set(k, { url: null });
            return null;
          }
          const objUrl = URL.createObjectURL(blob);
          _cache.set(k, { url: objUrl });
          return objUrl;
        })
        .catch(() => {
          _cache.set(k, { url: null });
          return null;
        });

    if (!cached?.promise) _cache.set(k, { promise });

    promise.then((objUrl) => {
      if (cancelled) return;
      if (objUrl) setUrl(objUrl);
      else setMissing(true);
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId, peerType, peerId, large, bust]);

  return { url, missing };
}
