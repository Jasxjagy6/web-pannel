/* eslint-disable jsx-a11y/media-has-caption */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellOff, X, Volume2, VolumeX } from 'lucide-react';

const PREF_KEY = 'tg-client:notif-prefs:v1';
// We synthesise a short blip using WebAudio rather than shipping an
// audio file — this keeps the panel dependency-free and avoids a
// network round-trip for every incoming message.
function _playBeep(volume = 0.18) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    setTimeout(() => { try { ctx.close(); } catch (_) { /* ignore */ } }, 600);
  } catch (_) { /* ignore */ }
}

function _loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v !== 'object' || v == null) return null;
    return v;
  } catch (_) { return null; }
}
function _savePrefs(prefs) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ }
}

const DEFAULT_PREFS = {
  enabled: true,
  silent: false,
  systemNotifications: true,
  perPeer: {}, // { 'user:123': { mute: true } }
};

// Telegram-blue dot for the favicon while there's an unread notification.
function _setFaviconDot(on) {
  try {
    const link = document.querySelector("link[rel*='icon']");
    if (!link) return;
    const baseHref = link.dataset.tgClientOriginalHref || link.href;
    if (!link.dataset.tgClientOriginalHref) link.dataset.tgClientOriginalHref = baseHref;
    if (!on) {
      link.href = baseHref;
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        const size = Math.max(img.width || 32, 32);
        c.width = size;
        c.height = size;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        const r = Math.round(size * 0.32);
        ctx.beginPath();
        ctx.arc(size - r - 1, size - r - 1, r, 0, 2 * Math.PI);
        ctx.fillStyle = '#3b82f6';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#0b1220';
        ctx.stroke();
        link.href = c.toDataURL('image/png');
      } catch (_) {
        // Cross-origin canvas taint or other; fall back to no dot.
      }
    };
    img.onerror = () => { /* keep the original */ };
    img.src = baseHref;
  } catch (_) { /* ignore */ }
}

let _titleFlashTimer = null;
function _flashTitle(notice) {
  if (!notice) {
    if (_titleFlashTimer) { clearInterval(_titleFlashTimer); _titleFlashTimer = null; }
    if (document.title.startsWith('● ')) document.title = document.title.replace(/^●\s*/, '');
    return;
  }
  if (_titleFlashTimer) return;
  _titleFlashTimer = setInterval(() => {
    if (document.title.startsWith('● ')) {
      document.title = document.title.replace(/^●\s*/, '');
    } else {
      document.title = `● ${document.title}`;
    }
  }, 1200);
}

function _peerKey(p) {
  if (!p) return null;
  return `${p.peerType}:${p.peerId}`;
}

/**
 * D14 — in-app notification centre.
 *
 * - Subscribes to the `tg-client:newMessage` socket event (forwarded as
 *   the window-level `tg-client:newMessage` CustomEvent).
 * - Renders toast cards in the bottom-right.
 * - Plays a synthesised blip (unless silent) and asks the OS to show a
 *   system notification (when permission granted).
 * - Flashes the document title and adds a blue dot to the favicon
 *   while the window is unfocused and there are unread messages.
 * - Provides per-peer mute, a global silent toggle, and a global
 *   master toggle persisted to localStorage.
 *
 * Mounted once at the top of the TelegramClient page so it observes
 * messages across all chats in this window.
 */
export default function NotificationCenter({ sessionId, store, currentDialogTitle }) {
  const [prefs, setPrefs] = useState(() => ({ ...DEFAULT_PREFS, ...(_loadPrefs() || {}) }));
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const meIdRef = useRef(null);

  // Subscribe to me.id so we ignore our own outgoing messages.
  useEffect(() => store.subscribe?.((s, prev) => {
    if (s?.me?.id !== prev?.me?.id) meIdRef.current = s?.me?.id ? Number(s.me.id) : null;
  }) || (() => {}), [store]);
  useEffect(() => {
    meIdRef.current = store.getState?.()?.me?.id ? Number(store.getState().me.id) : null;
  }, [store]);

  const [unreadCount, setUnreadCount] = useState(0);
  const [windowFocused, setWindowFocused] = useState(typeof document === 'undefined' ? true : !document.hidden);

  // Track focus / visibility — title flash and favicon dot are only
  // active while the window is unfocused/hidden.
  useEffect(() => {
    const onFocus = () => {
      setWindowFocused(true);
      setUnreadCount(0);
      _flashTitle(false);
      _setFaviconDot(false);
    };
    const onBlur = () => setWindowFocused(false);
    const onVis = () => {
      if (document.hidden) {
        setWindowFocused(false);
      } else {
        setWindowFocused(true);
        setUnreadCount(0);
        _flashTitle(false);
        _setFaviconDot(false);
      }
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
      _flashTitle(false);
      _setFaviconDot(false);
    };
  }, []);

  // Also clear unread count when the user actively switches chats —
  // they obviously already saw the notice.
  useEffect(() => {
    setUnreadCount(0);
    _flashTitle(false);
    _setFaviconDot(false);
  }, [currentDialogTitle]);

  useEffect(() => {
    if (windowFocused) return undefined;
    if (unreadCount > 0) {
      _flashTitle(true);
      _setFaviconDot(true);
    } else {
      _flashTitle(false);
      _setFaviconDot(false);
    }
    return undefined;
  }, [windowFocused, unreadCount]);

  const updatePref = useCallback((patch) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      _savePrefs(next);
      return next;
    });
  }, []);

  const togglePeerMute = useCallback((peer) => {
    if (!peer) return;
    const k = _peerKey(peer);
    setPrefs((p) => {
      const cur = p.perPeer?.[k] || {};
      const next = {
        ...p,
        perPeer: { ...(p.perPeer || {}), [k]: { ...cur, mute: !cur.mute } },
      };
      _savePrefs(next);
      return next;
    });
  }, []);

  const isPeerMuted = useCallback((peer) => {
    if (!peer) return false;
    const k = _peerKey(peer);
    return !!(prefsRef.current.perPeer?.[k]?.mute);
  }, []);

  // Socket subscription happens at the window level via the
  // useTelegramClientSocket hook in TelegramClient.jsx; we just
  // listen for the forwarded CustomEvent.
  useEffect(() => {
    const handler = (e) => {
      const payload = e?.detail || {};
      if (!payload || String(payload.sessionId) !== String(sessionId)) return;
      const msg = payload.message;
      if (!msg) return;
      // Skip outgoing messages — telegram fires newMessage for our own
      // sends too.
      if (msg.out) return;
      if (msg.fromId != null && meIdRef.current != null && Number(msg.fromId) === meIdRef.current) return;
      const chat = payload.chat || {};
      const peer = chat.peerType && chat.peerId != null ? { peerType: chat.peerType, peerId: chat.peerId } : null;

      if (!prefsRef.current.enabled) return;
      if (peer && isPeerMuted(peer)) return;

      const sender = payload.sender || {};
      const title = chat.title
        || (sender && sender.title)
        || (chat.peerType === 'user' ? '' : 'Group');
      const senderTitle = sender?.title;
      const isPrivate = chat.peerType === 'user';
      const heading = isPrivate ? (senderTitle || title || 'New message') : (title || 'New message');
      const body =
        msg.text
        || (msg.mediaKind ? `[${msg.mediaKind}]` : null)
        || (isPrivate ? 'sent a message' : 'New message');
      const subText = !isPrivate && senderTitle ? `${senderTitle}: ${body}` : body;

      // Toast
      const id = ++toastIdRef.current;
      setToasts((arr) => {
        const next = [...arr, { id, heading, body: subText, peer, ts: Date.now() }];
        // Cap at 4 visible toasts; oldest fall off.
        return next.length > 4 ? next.slice(next.length - 4) : next;
      });
      // Auto-dismiss after 4.5s
      setTimeout(() => {
        setToasts((arr) => arr.filter((t) => t.id !== id));
      }, 4500);

      // Sound (unless globally silent or message arrives with telegram's silent flag)
      if (!prefsRef.current.silent && !msg.silent) _playBeep();

      // Native system notification
      if (
        prefsRef.current.systemNotifications
        && typeof Notification !== 'undefined'
        && Notification.permission === 'granted'
        && document.hidden
      ) {
        try {
          const n = new Notification(heading, {
            body: subText,
            tag: `tg-client:${sessionId}:${peer ? _peerKey(peer) : 'unknown'}`,
            silent: !!msg.silent || !!prefsRef.current.silent,
            renotify: false,
          });
          n.onclick = () => {
            window.focus();
            try { n.close(); } catch (_) { /* ignore */ }
            try {
              if (peer) {
                store.getState?.().selectPeer?.(peer.peerType, peer.peerId);
              }
            } catch (_) { /* ignore */ }
          };
        } catch (_) { /* permission revoked / older browser */ }
      }

      // Title flash + favicon dot only while window is unfocused/hidden.
      if (document.hidden || !document.hasFocus()) {
        setUnreadCount((c) => c + 1);
      }
    };
    window.addEventListener('tg-client:newMessage', handler);
    return () => window.removeEventListener('tg-client:newMessage', handler);
  }, [sessionId, isPeerMuted, store]);

  // Ask for system-notification permission once when the user first
  // enables the option (a user-gesture is required by browsers).
  const requestSystemPerm = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') return;
    try { await Notification.requestPermission(); } catch (_) { /* ignore */ }
  }, []);

  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setPanelOpen((v) => !v)}
        className={`relative rounded-md p-1.5 ${
          prefs.enabled
            ? (prefs.silent ? 'text-gray-400 hover:bg-white/5 hover:text-gray-200' : 'text-gray-300 hover:bg-white/5 hover:text-gray-100')
            : 'text-gray-500 hover:bg-white/5'
        }`}
        title={prefs.enabled ? (prefs.silent ? 'Notifications: silent' : 'Notifications: on') : 'Notifications: off'}
        aria-label="Notification settings"
      >
        {prefs.enabled
          ? (prefs.silent ? <VolumeX className="h-4 w-4" /> : <Bell className="h-4 w-4" />)
          : <BellOff className="h-4 w-4" />}
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-2 w-2 rounded-full bg-blue-400" />
        )}
      </button>

      {panelOpen && (
        <NotificationPanel
          prefs={prefs}
          updatePref={updatePref}
          requestSystemPerm={requestSystemPerm}
          onClose={() => setPanelOpen(false)}
        />
      )}

      <ToastStack
        toasts={toasts}
        store={store}
        onDismiss={(id) => setToasts((arr) => arr.filter((t) => t.id !== id))}
        onMute={togglePeerMute}
        isPeerMuted={isPeerMuted}
      />
    </>
  );
}

function NotificationPanel({ prefs, updatePref, requestSystemPerm, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target)) onClose?.();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);
  const sysPerm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';

  return (
    <div
      ref={ref}
      className="absolute right-3 top-12 z-40 w-72 rounded-lg border border-white/10 bg-dark-900 p-3 shadow-xl"
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-gray-100">Notifications</div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-1 text-gray-400 hover:bg-white/5 hover:text-gray-200"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <Toggle
        label="Enable notifications"
        value={prefs.enabled}
        onChange={(v) => updatePref({ enabled: v })}
      />
      <Toggle
        label="Silent mode (no sound)"
        value={prefs.silent}
        onChange={(v) => updatePref({ silent: v })}
        disabled={!prefs.enabled}
      />
      <Toggle
        label="Show OS notifications"
        value={prefs.systemNotifications}
        onChange={async (v) => {
          updatePref({ systemNotifications: v });
          if (v) await requestSystemPerm();
        }}
        disabled={!prefs.enabled}
      />
      {prefs.systemNotifications && sysPerm !== 'granted' && sysPerm !== 'unsupported' && (
        <button
          type="button"
          onClick={requestSystemPerm}
          className="mt-2 w-full rounded-md bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-200 hover:bg-blue-500/15"
        >
          {sysPerm === 'denied'
            ? 'Permission denied — enable in browser settings'
            : 'Grant browser permission'}
        </button>
      )}
      <div className="mt-2 text-[10px] text-gray-500">
        Per-chat mute is available from the toast actions when a notification arrives.
      </div>
    </div>
  );
}

function Toggle({ label, value, onChange, disabled }) {
  return (
    <label
      className={`flex items-center justify-between py-1.5 text-xs ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      }`}
    >
      <span className="text-gray-200">{label}</span>
      <input
        type="checkbox"
        className="h-4 w-7 cursor-pointer appearance-none rounded-full bg-dark-700 transition-colors checked:bg-blue-500 disabled:cursor-not-allowed"
        checked={!!value}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
    </label>
  );
}

function ToastStack({ toasts, store, onDismiss, onMute, isPeerMuted }) {
  if (!toasts || toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto rounded-lg border border-white/10 bg-dark-800 p-3 shadow-xl"
        >
          <div className="flex items-start gap-2">
            <Volume2 className="mt-0.5 h-4 w-4 text-blue-300" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-gray-100">{t.heading}</div>
              <div className="line-clamp-2 text-xs text-gray-300">{t.body}</div>
            </div>
            <button
              type="button"
              onClick={() => onDismiss?.(t.id)}
              className="rounded-full p-1 text-gray-400 hover:bg-white/5 hover:text-gray-200"
              aria-label="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          {t.peer && (
            <div className="mt-2 flex items-center gap-2 border-t border-white/5 pt-2">
              <button
                type="button"
                onClick={() => {
                  try { store.getState?.().selectPeer?.(t.peer.peerType, t.peer.peerId); } catch (_) { /* ignore */ }
                  onDismiss?.(t.id);
                }}
                className="rounded-md bg-blue-500/10 px-2.5 py-1 text-[11px] font-medium text-blue-200 hover:bg-blue-500/15"
              >
                Open chat
              </button>
              <button
                type="button"
                onClick={() => onMute?.(t.peer)}
                className="rounded-md bg-dark-700 px-2.5 py-1 text-[11px] text-gray-300 hover:bg-white/10 hover:text-gray-100"
              >
                {isPeerMuted(t.peer) ? 'Unmute' : 'Mute'} this chat
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
