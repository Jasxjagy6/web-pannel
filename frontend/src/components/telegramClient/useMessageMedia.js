/**
 * useMessageMedia — fetch and cache message-media blobs as object URLs
 * keyed on `${sessionId}:${peerType}:${peerId}:${messageId}:${thumb}`.
 *
 * Drives the inline media renderer in MessageBubble (thumbs on scroll)
 * and the full-resolution lightbox.
 *
 * The backend caches the bytes themselves for ~5 minutes; this layer
 * stores the resulting Blob URL so React doesn't have to re-fetch
 * across re-renders.
 */

import { useEffect, useState } from 'react';
import { fetchMessageMediaBlob } from '../../api/telegramClient';

const _cache = new Map(); // key -> { entry, promise }

function _key(sessionId, peerType, peerId, messageId, thumb) {
  return `${sessionId}:${peerType}:${peerId}:${messageId}:${thumb ? 'thumb' : 'full'}`;
}

export function useMessageMedia(sessionId, peerType, peerId, messageId, opts = {}) {
  const enabled = opts.enabled !== false;
  const thumb = !!opts.thumb;
  const [state, setState] = useState({ url: null, meta: null, loading: false, missing: false });

  useEffect(() => {
    if (!enabled || !sessionId || !peerType || peerId == null || messageId == null || messageId < 0) {
      return undefined;
    }
    const k = _key(sessionId, peerType, peerId, messageId, thumb);
    const cached = _cache.get(k);
    if (cached?.entry) {
      setState({
        url: cached.entry.url,
        meta: cached.entry.meta,
        loading: false,
        missing: !cached.entry.url,
      });
      return undefined;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));

    const promise =
      cached?.promise ||
      fetchMessageMediaBlob(sessionId, peerType, peerId, messageId, { thumb })
        .then((res) => {
          if (!res || !res.blob) {
            _cache.set(k, { entry: { url: null, meta: null } });
            return { url: null, meta: null };
          }
          const objUrl = URL.createObjectURL(res.blob);
          const entry = {
            url: objUrl,
            meta: {
              kind: res.kind,
              width: res.width,
              height: res.height,
              duration: res.duration,
              mimeType: res.mimeType,
              isThumb: res.isThumb,
            },
          };
          _cache.set(k, { entry });
          return entry;
        })
        .catch(() => {
          _cache.set(k, { entry: { url: null, meta: null } });
          return { url: null, meta: null };
        });

    if (!cached?.promise) _cache.set(k, { promise });

    promise.then((entry) => {
      if (cancelled) return;
      setState({
        url: entry.url,
        meta: entry.meta,
        loading: false,
        missing: !entry.url,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId, peerType, peerId, messageId, thumb, enabled]);

  return state;
}

/**
 * Best-effort eager prefetch for the full-resolution version. Useful
 * before opening the lightbox so the click feels instant.
 */
export function prefetchMessageMedia(sessionId, peerType, peerId, messageId, opts = {}) {
  const thumb = !!opts.thumb;
  const k = _key(sessionId, peerType, peerId, messageId, thumb);
  if (_cache.get(k)?.entry?.url) return Promise.resolve(_cache.get(k).entry);
  if (_cache.get(k)?.promise) return _cache.get(k).promise;
  const promise = fetchMessageMediaBlob(sessionId, peerType, peerId, messageId, { thumb })
    .then((res) => {
      if (!res || !res.blob) {
        _cache.set(k, { entry: { url: null, meta: null } });
        return { url: null, meta: null };
      }
      const objUrl = URL.createObjectURL(res.blob);
      const entry = {
        url: objUrl,
        meta: {
          kind: res.kind,
          width: res.width,
          height: res.height,
          duration: res.duration,
          mimeType: res.mimeType,
          isThumb: res.isThumb,
        },
      };
      _cache.set(k, { entry });
      return entry;
    })
    .catch(() => {
      _cache.set(k, { entry: { url: null, meta: null } });
      return { url: null, meta: null };
    });
  _cache.set(k, { promise });
  return promise;
}
