import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Pin, BadgeCheck, Megaphone, Users, User as UserIcon,
  Loader2, X, Globe2,
} from 'lucide-react';
import Avatar from './Avatar';
import { peerKey } from './tgClientStore';
import { searchGlobal as searchGlobalApi } from '../../api/telegramClient';
import { useCapabilities } from '../../context/PlatformContext';

const FILTER_CHIPS = [
  { key: 'all',      label: 'All' },
  { key: 'photo',    label: 'Photos' },
  { key: 'video',    label: 'Videos' },
  { key: 'document', label: 'Files' },
  { key: 'audio',    label: 'Audio' },
  { key: 'voice',    label: 'Voice' },
  { key: 'url',      label: 'Links' },
];

function _formatPreview(msg) {
  if (!msg) return '';
  if (msg.text) return msg.text;
  if (msg.hasMedia) return '[media]';
  return '';
}

function _shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const day = 24 * 60 * 60 * 1000;
  if (now - d < 7 * day) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function DialogList({ sessionId, store }) {
  const dialogOrder = store((s) => s.dialogOrder);
  const dialogs = store((s) => s.dialogs);
  const selectedPeerKey = store((s) => s.selectedPeerKey);
  const selectPeer = store((s) => s.selectPeer);
  const upsertDialog = store((s) => s.upsertDialog);
  const dialogsLoading = store((s) => s.dialogsLoading);

  const capabilities = useCapabilities();
  const canSearch = !!capabilities?.tgc_search;

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [globalResults, setGlobalResults] = useState(null);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [globalError, setGlobalError] = useState(null);
  const debounceRef = useRef(null);
  const reqIdRef = useRef(0);

  const filteredOrder = useMemo(() => {
    if (!query.trim()) return dialogOrder;
    const q = query.trim().toLowerCase();
    return dialogOrder.filter((k) => {
      const d = dialogs.get(k);
      if (!d) return false;
      return (
        (d.title || '').toLowerCase().includes(q) ||
        (d.username || '').toLowerCase().includes(q) ||
        (d.lastMessage?.text || '').toLowerCase().includes(q) ||
        (d.draft?.text || '').toLowerCase().includes(q)
      );
    });
  }, [dialogOrder, dialogs, query]);

  // D4 — debounced global search across every chat the account is in.
  useEffect(() => {
    if (!canSearch) {
      setGlobalResults(null);
      setGlobalError(null);
      return undefined;
    }
    const trimmed = query.trim();
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (trimmed.length < 2 && filter === 'all') {
      setGlobalResults(null);
      setGlobalError(null);
      setGlobalLoading(false);
      return undefined;
    }
    if (filter !== 'all' && trimmed.length === 0) {
      // SearchGlobal requires a non-empty query, so skip until the
      // user types at least 1 char when they pick a filter.
      setGlobalResults(null);
      setGlobalError(null);
      setGlobalLoading(false);
      return undefined;
    }

    setGlobalLoading(true);
    setGlobalError(null);
    const myId = ++reqIdRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const { data } = await searchGlobalApi(sessionId, {
          q: trimmed, filter, limit: 30,
        });
        if (reqIdRef.current !== myId) return;
        const payload = data?.data || data || {};
        setGlobalResults(payload);
      } catch (err) {
        if (reqIdRef.current !== myId) return;
        setGlobalError(
          err?.response?.data?.error?.message
          || err?.message
          || 'Search failed'
        );
      } finally {
        if (reqIdRef.current === myId) setGlobalLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, filter, sessionId, canSearch]);

  const onClickGlobalResult = (msg) => {
    const chat = msg.chat;
    if (!chat) return;
    const k = peerKey(chat.peerType, chat.peerId);
    if (!dialogs.has(k)) {
      upsertDialog({
        peerType: chat.peerType,
        peerId: chat.peerId,
        title: chat.title || '',
        unreadCount: 0,
        lastMessage: null,
      });
    }
    selectPeer(chat.peerType, chat.peerId);
  };

  return (
    <div className="flex h-full w-full flex-col bg-dark-900 text-gray-200">
      <div className="border-b border-white/5 p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={canSearch ? 'Search chats and messages…' : 'Search chats…'}
            className="w-full rounded-lg bg-dark-800 pl-9 pr-9 py-2 text-sm placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); setFilter('all'); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-500 hover:bg-white/5 hover:text-gray-200"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {canSearch && query.trim().length > 0 && (
          <div className="mt-2 flex items-center gap-1.5 overflow-x-auto">
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
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {dialogsLoading && filteredOrder.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-500">Loading chats…</div>
        ) : (
          <>
            {filteredOrder.length === 0 && !globalLoading && !globalResults ? (
              <div className="px-4 py-6 text-center text-sm text-gray-500">
                {query ? 'No matches.' : 'No chats yet.'}
              </div>
            ) : (
              <ul className="py-1">
                {filteredOrder.map((k) => {
                  const d = dialogs.get(k);
                  if (!d) return null;
                  const isActive = selectedPeerKey === k;
                  return (
                    <li
                      key={k}
                      className={`flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-white/5 ${
                        isActive ? 'bg-blue-500/10 hover:bg-blue-500/15' : ''
                      }`}
                      onClick={() => selectPeer(d.peerType, d.peerId)}
                    >
                      <Avatar
                        sessionId={sessionId}
                        peerType={d.peerType}
                        peerId={d.peerId}
                        label={d.title}
                        size="md"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-gray-100">
                            {d.title || 'Untitled'}
                          </span>
                          {d.isVerified && (
                            <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                          )}
                          {d.peerType === 'channel' && d.isBroadcast && (
                            <Megaphone className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                          )}
                          {d.peerType === 'channel' && !d.isBroadcast && (
                            <Users className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                          )}
                          {d.peerType === 'chat' && (
                            <Users className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                          )}
                          {d.peerType === 'user' && d.isBot && (
                            <span className="rounded bg-blue-500/10 px-1 text-[10px] font-medium text-blue-300">
                              BOT
                            </span>
                          )}
                          <span className="ml-auto shrink-0 text-[11px] text-gray-500">
                            {_shortDate(d.draft?.date || d.lastMessage?.date)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {d.draft && d.draft.text ? (
                            <span className="truncate text-xs text-gray-400">
                              <span className="font-semibold italic text-red-400">Draft: </span>
                              <span className="italic text-gray-300">{d.draft.text}</span>
                            </span>
                          ) : (
                            <span className="truncate text-xs text-gray-400">
                              {d.lastMessage?.out ? <span className="text-gray-500">You: </span> : null}
                              {_formatPreview(d.lastMessage)}
                            </span>
                          )}
                          {d.pinned && (
                            <Pin className="h-3 w-3 shrink-0 text-gray-500" />
                          )}
                          {d.unreadCount > 0 && (
                            <span className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-blue-500 px-1.5 text-[11px] font-semibold text-white">
                              {d.unreadCount > 99 ? '99+' : d.unreadCount}
                            </span>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {canSearch && (globalLoading || globalResults || globalError) && (
              <div className="border-t border-white/5">
                <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  <span className="inline-flex items-center gap-1.5">
                    <Globe2 className="h-3 w-3" />
                    Messages
                  </span>
                </div>
                {globalLoading ? (
                  <div className="flex items-center justify-center px-3 py-3 text-xs text-gray-500">
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Searching…
                  </div>
                ) : globalError ? (
                  <div className="px-3 py-3 text-xs text-red-300">{globalError}</div>
                ) : globalResults?.messages?.length ? (
                  <ul className="pb-2">
                    {globalResults.messages.map((m) => (
                      <li
                        key={`${m.chat?.peerType}:${m.chat?.peerId}:${m.id}`}
                        className="flex cursor-pointer items-start gap-3 px-3 py-2 transition-colors hover:bg-white/5"
                        onClick={() => onClickGlobalResult(m)}
                      >
                        <Avatar
                          sessionId={sessionId}
                          peerType={m.chat?.peerType}
                          peerId={m.chat?.peerId}
                          label={m.chat?.title}
                          size="sm"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-xs font-medium text-gray-200">
                              {m.chat?.title || 'Unknown'}
                            </span>
                            <span className="ml-auto shrink-0 text-[10px] text-gray-500">
                              {_shortDate(m.date)}
                            </span>
                          </div>
                          <div className="truncate text-xs text-gray-400">
                            {_formatPreview(m)}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : query.trim() ? (
                  <div className="px-3 py-3 text-xs text-gray-500">No messages found.</div>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
