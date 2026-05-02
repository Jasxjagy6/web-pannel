/**
 * Threads — Instagram DM threads page.
 *
 * Lists active conversations for the selected IG session, lets the user
 * open one to read recent messages and send a reply. Telegram doesn't
 * have a 1:1 analog (TG users use the Groups + Messaging pages
 * instead), so this route is hidden by the sidebar capability gate when
 * platform=telegram.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import { usePlatform, useCapability } from '../context/PlatformContext';

function formatRelative(ts) {
  if (!ts) return '';
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export default function Threads() {
  const { platform } = usePlatform();
  const supportsThreads = useCapability('messaging_threads');
  const [searchParams, setSearchParams] = useSearchParams();

  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(searchParams.get('sessionId') || '');
  const [threads, setThreads] = useState([]);
  const [loadingThreads, setLoadingThreads] = useState(false);

  const [openThread, setOpenThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  // Fetch sessions for the active platform.
  useEffect(() => {
    let alive = true;
    api.get(`/${platform}/sessions`).then((r) => {
      if (!alive) return;
      const list = r.data?.sessions || r.data?.data || [];
      setSessions(list);
      if (!sessionId && list[0]) setSessionId(String(list[0].id));
    }).catch(() => {});
    return () => { alive = false; };
  }, [platform]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync sessionId → URL.
  useEffect(() => {
    const sp = new URLSearchParams(searchParams);
    if (sessionId) sp.set('sessionId', sessionId); else sp.delete('sessionId');
    setSearchParams(sp, { replace: true });
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch threads.
  useEffect(() => {
    if (!sessionId) { setThreads([]); return; }
    let alive = true;
    setLoadingThreads(true);
    api.get(`/${platform}/threads`, { params: { sessionId } })
      .then((r) => { if (alive) setThreads(r.data?.threads || []); })
      .catch((e) => { if (alive) setError(e.response?.data?.error?.message || e.message); })
      .finally(() => { if (alive) setLoadingThreads(false); });
    return () => { alive = false; };
  }, [platform, sessionId]);

  const sortedThreads = useMemo(
    () => [...threads].sort((a, b) => {
      const at = a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0;
      const bt = b.last_activity_at ? new Date(b.last_activity_at).getTime() : 0;
      return bt - at;
    }),
    [threads]
  );

  async function handleOpenThread(t) {
    setOpenThread(t);
    setMessages([]);
    try {
      const r = await api.get(`/${platform}/threads/${t.thread_id}`, { params: { sessionId } });
      setMessages(r.data?.messages || []);
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message);
    }
  }

  async function handleSendReply() {
    if (!openThread || !reply.trim()) return;
    setSending(true);
    setError(null);
    try {
      await api.post(`/${platform}/threads/${openThread.thread_id}/send`, {
        sessionId,
        text: reply.trim(),
      });
      setReply('');
      // Refresh messages
      const r = await api.get(`/${platform}/threads/${openThread.thread_id}`, { params: { sessionId } });
      setMessages(r.data?.messages || []);
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message);
    } finally {
      setSending(false);
    }
  }

  if (!supportsThreads) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
        <h2 className="text-lg font-semibold text-gray-900">Threads aren't available on Telegram</h2>
        <p className="mt-2 text-sm text-gray-600">
          Switch to the Instagram panel using the platform toggle to manage DMs.
          Telegram users can use <Link to="../groups" className="text-brand-600 underline">Groups</Link>{' '}
          and <Link to="../messaging" className="text-brand-600 underline">Messaging</Link> instead.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Threads list */}
      <div className="lg:col-span-1">
        <div className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">Conversations</h3>
            <select
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              className="input max-w-[180px] text-xs"
            >
              <option value="">Select session</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.username || `#${s.id}`}</option>
              ))}
            </select>
          </div>
          {loadingThreads ? (
            <div className="py-6 text-center text-sm text-gray-500">Loading…</div>
          ) : sortedThreads.length === 0 ? (
            <div className="py-6 text-center text-sm text-gray-500">
              {sessionId ? 'No threads yet.' : 'Pick a session to load conversations.'}
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {sortedThreads.map((t) => (
                <li key={t.thread_id}>
                  <button
                    onClick={() => handleOpenThread(t)}
                    className={`block w-full px-2 py-3 text-left transition-colors hover:bg-gray-50 ${
                      openThread?.thread_id === t.thread_id ? 'bg-brand-50' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate text-sm font-medium text-gray-900">
                        {t.thread_title || (t.is_group ? `Group of ${t.participant_count}` : 'DM')}
                      </span>
                      <span className="text-xs text-gray-400">{formatRelative(t.last_activity_at)}</span>
                    </div>
                    {t.unread_count > 0 ? (
                      <span className="mt-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] font-medium text-white">
                        {t.unread_count}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Open thread */}
      <div className="lg:col-span-2">
        <div className="card flex h-[70vh] flex-col p-4">
          {!openThread ? (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
              Select a conversation to view messages.
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between border-b border-gray-100 pb-3">
                <h3 className="text-sm font-semibold text-gray-900">
                  {openThread.thread_title || `Thread #${openThread.thread_id}`}
                </h3>
                <span className="text-xs text-gray-400">{openThread.participant_count} participants</span>
              </div>
              <div className="flex-1 space-y-2 overflow-auto pr-2">
                {messages.length === 0 ? (
                  <div className="text-center text-sm text-gray-400">No messages cached yet.</div>
                ) : messages
                  .slice()
                  .reverse()
                  .map((m) => (
                    <div
                      key={m.id}
                      className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm ${
                          m.direction === 'out'
                            ? 'bg-brand-500 text-white'
                            : 'bg-gray-100 text-gray-900'
                        }`}
                      >
                        {m.text || <em className="opacity-70">[{m.message_type}]</em>}
                        <div className={`mt-0.5 text-[10px] ${m.direction === 'out' ? 'text-white/70' : 'text-gray-400'}`}>
                          {formatRelative(m.sent_at)}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
              <form
                onSubmit={(e) => { e.preventDefault(); handleSendReply(); }}
                className="mt-3 flex items-center gap-2"
              >
                <input
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Send a message…"
                  className="input flex-1"
                  disabled={sending}
                />
                <button
                  type="submit"
                  disabled={sending || !reply.trim()}
                  className="btn bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50"
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </form>
              {error ? <div className="mt-2 text-xs text-error-600">{error}</div> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
