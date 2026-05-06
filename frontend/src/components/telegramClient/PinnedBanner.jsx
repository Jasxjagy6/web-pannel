import React, { useEffect, useMemo, useState } from 'react';
import { Pin, ChevronDown, X } from 'lucide-react';
import { getPinnedMessages, unpinMessage } from '../../api/telegramClient';

/**
 * D13 — strip rendered above the chat scroller listing pinned messages.
 *
 * Telegram clients show one pinned message at a time and let the user
 * cycle through. We mirror that behaviour: clicking the strip jumps
 * to the active pin in the message list. A dropdown opens the full
 * pinned-message panel where the user can unpin or unpin-all.
 */
export default function PinnedBanner({
  sessionId,
  peerType,
  peerId,
  pinnedIds,
  messagesById,
  onJumpToMessage,
  onUnpin,
  onUnpinAll,
}) {
  const sortedIds = useMemo(() => {
    return Array.from(new Set(pinnedIds || []))
      .map((v) => Number(v))
      .filter(Number.isFinite)
      .sort((a, b) => b - a);
  }, [pinnedIds]);

  const [activeIdx, setActiveIdx] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMessages, setPanelMessages] = useState([]);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelError, setPanelError] = useState(null);

  useEffect(() => {
    if (activeIdx >= sortedIds.length) setActiveIdx(0);
  }, [sortedIds.length, activeIdx]);

  useEffect(() => {
    if (!panelOpen) return undefined;
    let cancelled = false;
    setPanelLoading(true);
    setPanelError(null);
    (async () => {
      try {
        const { data } = await getPinnedMessages(sessionId, peerType, peerId, { limit: 50 });
        if (cancelled) return;
        const payload = data?.data || data || {};
        setPanelMessages(payload.messages || []);
      } catch (err) {
        if (cancelled) return;
        setPanelError(err?.response?.data?.error?.message || err?.message || 'Failed to load');
      } finally {
        if (!cancelled) setPanelLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [panelOpen, sessionId, peerType, peerId, sortedIds.length]);

  if (sortedIds.length === 0) return null;

  const activeId = sortedIds[activeIdx] ?? sortedIds[0];
  const message = messagesById?.get?.(Number(activeId));

  const previewText =
    message?.text
    || (message?.mediaKind ? `[${message.mediaKind}]` : null)
    || `Pinned message #${activeId}`;

  const cycle = () => {
    setActiveIdx((i) => (sortedIds.length === 0 ? 0 : (i + 1) % sortedIds.length));
  };

  const onClickStrip = () => {
    if (onJumpToMessage) onJumpToMessage(activeId);
    if (sortedIds.length > 1) cycle();
  };

  return (
    <>
      <div className="flex items-center gap-2 border-b border-white/5 bg-dark-900 px-3 py-2">
        <Pin className="h-3.5 w-3.5 text-blue-300" />
        <button
          type="button"
          onClick={onClickStrip}
          className="min-w-0 flex-1 text-left"
          title="Jump to pinned message"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-300">
            Pinned message{sortedIds.length > 1 ? ` (${activeIdx + 1} / ${sortedIds.length})` : ''}
          </div>
          <div className="truncate text-xs text-gray-300">{previewText}</div>
        </button>
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className="rounded p-1 text-gray-400 hover:bg-white/5 hover:text-gray-200"
          title="Show all pinned messages"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      {panelOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-end bg-black/40"
          onClick={() => setPanelOpen(false)}
        >
          <div
            className="flex h-full w-full max-w-md flex-col bg-dark-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <Pin className="h-4 w-4 text-blue-300" />
              <div className="text-sm font-semibold text-gray-100">Pinned messages</div>
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                className="ml-auto rounded-full p-1 text-gray-400 hover:bg-white/5 hover:text-gray-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {panelLoading ? (
                <div className="px-4 py-6 text-center text-sm text-gray-500">Loading…</div>
              ) : panelError ? (
                <div className="px-4 py-6 text-center text-sm text-red-300">{panelError}</div>
              ) : panelMessages.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-gray-500">
                  No pinned messages.
                </div>
              ) : (
                <ul className="py-1">
                  {panelMessages.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-start gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-white/5"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (onJumpToMessage) onJumpToMessage(m.id);
                          setPanelOpen(false);
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate">
                          {m.text || (m.mediaKind ? `[${m.mediaKind}]` : `Message #${m.id}`)}
                        </div>
                        <div className="mt-0.5 text-[10px] text-gray-500">
                          {m.date ? new Date(m.date).toLocaleString() : ''}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await unpinMessage(sessionId, peerType, peerId, m.id);
                            setPanelMessages((arr) => arr.filter((x) => x.id !== m.id));
                            onUnpin?.(m);
                          } catch (_) { /* ignore */ }
                        }}
                        className="rounded px-2 py-1 text-[11px] text-gray-400 hover:bg-white/5 hover:text-gray-200"
                      >
                        Unpin
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {panelMessages.length > 0 && (
              <div className="border-t border-white/5 px-3 py-2">
                <button
                  type="button"
                  onClick={() => {
                    onUnpinAll?.();
                    setPanelOpen(false);
                  }}
                  className="w-full rounded-md bg-red-500/10 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-500/15"
                >
                  Unpin all messages
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
