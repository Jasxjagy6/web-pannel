import React, { useEffect, useRef, useState } from 'react';
import { Search, X, Loader2 } from 'lucide-react';
import { searchInChat } from '../../api/telegramClient';

const FILTER_CHIPS = [
  { key: 'all',      label: 'All' },
  { key: 'photo',    label: 'Photos' },
  { key: 'video',    label: 'Videos' },
  { key: 'document', label: 'Files' },
  { key: 'audio',    label: 'Audio' },
  { key: 'voice',    label: 'Voice' },
  { key: 'url',      label: 'Links' },
  { key: 'gif',      label: 'GIFs' },
  { key: 'mention',  label: 'Mentions' },
];

/**
 * D4 — search inside the currently-open chat. Renders below the chat
 * header. Debounces the request 300ms after the last keystroke,
 * supports filter chips for media-type filtering, and shows results
 * as a scrollable strip the user can click to jump.
 */
export default function ChatSearchPanel({
  sessionId,
  peerType,
  peerId,
  onClose,
  onJump,
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);
  const reqIdRef = useRef(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim() && filter === 'all') {
      setResults(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    setError(null);
    const myId = ++reqIdRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const { data } = await searchInChat(sessionId, peerType, peerId, {
          q: query.trim(),
          filter,
          limit: 50,
        });
        if (reqIdRef.current !== myId) return;
        const payload = data?.data || data || {};
        setResults(payload);
      } catch (err) {
        if (reqIdRef.current !== myId) return;
        setError(
          err?.response?.data?.error?.message
          || err?.message
          || 'Search failed'
        );
      } finally {
        if (reqIdRef.current === myId) setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, filter, sessionId, peerType, peerId]);

  const messages = results?.messages || [];

  return (
    <div className="border-b border-white/5 bg-dark-900">
      <div className="flex items-center gap-2 px-3 py-2">
        <Search className="h-4 w-4 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search in this chat…"
          className="flex-1 bg-transparent text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-gray-400 hover:bg-white/5 hover:text-gray-100"
          aria-label="Close search"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto px-3 pb-2">
        {FILTER_CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setFilter(c.key)}
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
              filter === c.key
                ? 'bg-blue-500/20 text-blue-200'
                : 'bg-dark-800 text-gray-400 hover:bg-white/5 hover:text-gray-200'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {(query.trim() || filter !== 'all') && (
        <div className="max-h-64 overflow-y-auto border-t border-white/5">
          {loading ? (
            <div className="flex items-center justify-center px-3 py-3 text-xs text-gray-500">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Searching…
            </div>
          ) : error ? (
            <div className="px-3 py-3 text-xs text-red-300">{error}</div>
          ) : messages.length === 0 ? (
            <div className="px-3 py-3 text-xs text-gray-500">No results.</div>
          ) : (
            <ul className="py-1">
              {messages.map((m) => (
                <li
                  key={m.id}
                  className="cursor-pointer px-3 py-2 text-sm text-gray-200 hover:bg-white/5"
                  onClick={() => onJump?.(m)}
                >
                  <div className="truncate">
                    {m.text || (m.mediaKind ? `[${m.mediaKind}]` : `Message #${m.id}`)}
                  </div>
                  <div className="mt-0.5 text-[10px] text-gray-500">
                    {m.date ? new Date(m.date).toLocaleString() : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
