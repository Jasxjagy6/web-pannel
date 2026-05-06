import React, { useMemo, useState } from 'react';
import { Search, Pin, BadgeCheck, Megaphone, Users, User as UserIcon } from 'lucide-react';
import Avatar from './Avatar';
import { peerKey } from './tgClientStore';

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
  const dialogsLoading = store((s) => s.dialogsLoading);

  const [query, setQuery] = useState('');

  const filteredOrder = useMemo(() => {
    if (!query.trim()) return dialogOrder;
    const q = query.trim().toLowerCase();
    return dialogOrder.filter((k) => {
      const d = dialogs.get(k);
      if (!d) return false;
      return (
        (d.title || '').toLowerCase().includes(q) ||
        (d.username || '').toLowerCase().includes(q) ||
        (d.lastMessage?.text || '').toLowerCase().includes(q)
      );
    });
  }, [dialogOrder, dialogs, query]);

  return (
    <div className="flex h-full w-full flex-col bg-dark-900 text-gray-200">
      <div className="border-b border-white/5 p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="w-full rounded-lg bg-dark-800 pl-9 pr-3 py-2 text-sm placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {dialogsLoading && filteredOrder.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-500">Loading chats…</div>
        ) : filteredOrder.length === 0 ? (
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
                        {_shortDate(d.lastMessage?.date)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs text-gray-400">
                        {d.lastMessage?.out ? <span className="text-gray-500">You: </span> : null}
                        {_formatPreview(d.lastMessage)}
                      </span>
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
      </div>
    </div>
  );
}
