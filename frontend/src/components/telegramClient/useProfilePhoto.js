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

function _key(sessionId, peerType, peerId, large) {
  return `${sessionId}:${peerType}:${peerId}:${large ? 'big' : 'small'}`;
}

export function useProfilePhoto(sessionId, peerType, peerId, opts = {}) {
  const [url, setUrl] = useState(null);
  const [missing, setMissing] = useState(false);
  const large = !!opts.large;

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
  }, [sessionId, peerType, peerId, large]);

  return { url, missing };
}
