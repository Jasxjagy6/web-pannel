import React, { useEffect, useMemo, useState } from 'react';
import { X, Forward } from 'lucide-react';
import Avatar from './Avatar';

/**
 * ForwardDialog — modal that lets the user pick a destination dialog
 * to forward the message into. Renders the current dialog list (already
 * loaded into the store) with a search input.
 */
export default function ForwardDialog({ sessionId, dialogs, message, onCancel, onSelect }) {
  const [q, setQ] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return dialogs;
    return dialogs.filter((d) => (d.title || '').toLowerCase().includes(needle));
  }, [dialogs, q]);

  const choose = async (d) => {
    setSubmitting(true);
    setError(null);
    try {
      await onSelect?.({ toPeerType: d.peerType, toPeerId: d.peerId });
    } catch (err) {
      setError(err?.message || 'Failed to forward');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-white/10 bg-dark-900 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
          <Forward className="h-4 w-4 text-blue-300" />
          <div className="text-sm font-semibold text-gray-100">Forward to…</div>
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto rounded-full p-1 text-gray-400 hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-4 py-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search chats…"
            className="w-full rounded-md bg-dark-800 px-3 py-1.5 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        {error && (
          <div className="mx-4 mb-2 rounded-md bg-red-900/30 px-3 py-1 text-xs text-red-300">
            {error}
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-gray-500">No matching chats.</div>
          ) : (
            <ul className="divide-y divide-white/5">
              {filtered.map((d) => (
                <li key={`${d.peerType}:${d.peerId}`}>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => choose(d)}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-white/5 disabled:opacity-50"
                  >
                    <Avatar
                      sessionId={sessionId}
                      peerType={d.peerType}
                      peerId={d.peerId}
                      label={d.title}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-gray-100">
                        {d.title || `${d.peerType} ${d.peerId}`}
                      </div>
                      <div className="truncate text-[11px] text-gray-500">
                        {d.peerType}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
