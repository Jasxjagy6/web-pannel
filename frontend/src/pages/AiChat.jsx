/**
 * AiChat — management page for the Telegram AI auto-responder.
 *
 * Lists every Telegram session for the current user with a master AI
 * toggle.  Expanded session cards show per-chat overrides, memory
 * controls, and recent AI response logs.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  RefreshCcw,
  Bot,
  MessageSquare,
  Trash2,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
} from 'lucide-react';
import { listClientSessions } from '../api/telegramClient';
import {
  getAiSessionSettings,
  updateAiSessionSettings,
  getAiChatSettings,
  updateAiChatSettings,
  clearAiChatMemory,
  getAiLogs,
} from '../api/aiChat';
import { usePlatform } from '../context/PlatformContext';
import { useToast } from '../components/common/Toast';

const PEER_LABEL = { user: 'User', chat: 'Group', channel: 'Channel' };

function _statusPill(status) {
  if (status === 'sent')
    return { label: 'Sent', tone: 'emerald', Icon: CheckCircle2 };
  if (status === 'failed')
    return { label: 'Failed', tone: 'red', Icon: XCircle };
  if (status === 'no_reply')
    return { label: 'No reply', tone: 'gray', Icon: MessageSquare };
  return { label: status, tone: 'gray', Icon: Clock };
}

const TONE_CLASSES = {
  emerald: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  red:     'bg-red-500/10 text-red-300 border-red-500/30',
  gray:    'bg-white/5 text-gray-300 border-white/10',
};

export default function AiChat() {
  const { platform } = usePlatform();
  const toast = useToast();
  const isTelegram = platform === 'telegram';

  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [settingsMap, setSettingsMap] = useState({});
  const [chatSettingsMap, setChatSettingsMap] = useState({});
  const [logsMap, setLogsMap] = useState({});
  const [togglingId, setTogglingId] = useState(null);
  const [chatToggling, setChatToggling] = useState(null);
  const [clearing, setClearing] = useState(null);

  const loadSessions = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await listClientSessions();
      const list = data?.data?.sessions || [];
      setSessions(list);
      // Pre-load settings for each session.
      const settings = {};
      await Promise.all(
        list.map(async (s) => {
          try {
            const { data: st } = await getAiSessionSettings(s.id);
            settings[s.id] = st?.data || { enabled: false, config: {} };
          } catch {
            settings[s.id] = { enabled: false, config: {} };
          }
        })
      );
      setSettingsMap(settings);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isTelegram) return;
    loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTelegram]);

  const toggleSession = async (sessionId) => {
    const current = settingsMap[sessionId] || { enabled: false, config: {} };
    const nextEnabled = !current.enabled;
    setTogglingId(sessionId);
    try {
      const { data } = await updateAiSessionSettings(sessionId, {
        enabled: nextEnabled,
        config: current.config,
      });
      setSettingsMap((prev) => ({
        ...prev,
        [sessionId]: { enabled: data?.data?.enabled ?? nextEnabled, config: data?.data?.config || current.config },
      }));
      toast.success(nextEnabled ? 'AI enabled for this session' : 'AI disabled for this session');
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Failed to update AI setting');
    } finally {
      setTogglingId(null);
    }
  };

  const expandSession = async (sessionId) => {
    if (expandedId === sessionId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(sessionId);
    try {
      const [{ data: cs }, { data: ls }] = await Promise.all([
        getAiChatSettings(sessionId),
        getAiLogs(sessionId),
      ]);
      setChatSettingsMap((prev) => ({
        ...prev,
        [sessionId]: cs?.data?.rows || [],
      }));
      setLogsMap((prev) => ({
        ...prev,
        [sessionId]: ls?.data?.rows || [],
      }));
    } catch (err) {
      toast.error('Failed to load chat settings or logs');
    }
  };

  const toggleChat = async (sessionId, chat) => {
    const { peer_type, peer_id, enabled } = chat;
    setChatToggling(`${sessionId}:${peer_type}:${peer_id}`);
    try {
      await updateAiChatSettings(sessionId, peer_type, peer_id, { enabled: !enabled });
      setChatSettingsMap((prev) => {
        const list = prev[sessionId] || [];
        return {
          ...prev,
          [sessionId]: list.map((c) =>
            c.peer_type === peer_type && c.peer_id === peer_id
              ? { ...c, enabled: !enabled }
              : c
          ),
        };
      });
      toast.success(!enabled ? 'AI enabled for this chat' : 'AI disabled for this chat');
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Failed to update chat setting');
    } finally {
      setChatToggling(null);
    }
  };

  const clearMemory = async (sessionId, peerType, peerId) => {
    setClearing(`${sessionId}:${peerType}:${peerId}`);
    try {
      await clearAiChatMemory(sessionId, peerType, peerId);
      toast.success('Chat memory cleared');
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Failed to clear memory');
    } finally {
      setClearing(null);
    }
  };

  const filteredSessions = useMemo(() => {
    return sessions.filter((s) => s.platform === 'telegram' || !s.platform);
  }, [sessions]);

  if (!isTelegram) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center text-gray-400">
        <div>
          <Bot className="mx-auto mb-4 h-12 w-12 text-gray-500" />
          <p>AI Chat is only available for Telegram.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dark-950 p-6 text-gray-100">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <Bot className="h-7 w-7 text-sky-400" />
              AI Auto-Responder
            </h1>
            <p className="mt-1 text-sm text-gray-400">
              Enable AI per Telegram session and control which chats it handles.
            </p>
          </div>
          <button
            type="button"
            onClick={loadSessions}
            disabled={loading}
            className="flex items-center gap-2 rounded-md bg-dark-800 px-3 py-2 text-sm hover:bg-dark-700 disabled:opacity-50"
          >
            <RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-4 text-red-300">
            <AlertTriangle className="h-5 w-5" />
            {error}
          </div>
        )}

        {loading && !sessions.length ? (
          <div className="flex items-center justify-center py-20 text-gray-400">
            <Loader2 className="mr-2 h-6 w-6 animate-spin" />
            Loading sessions…
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="rounded-lg border border-white/5 bg-dark-900 p-8 text-center text-gray-400">
            No Telegram sessions found. Upload or create a session first.
          </div>
        ) : (
          <div className="space-y-3">
            {filteredSessions.map((s) => {
              const settings = settingsMap[s.id] || { enabled: false, config: {} };
              const expanded = expandedId === s.id;
              return (
                <div
                  key={s.id}
                  className="rounded-lg border border-white/5 bg-dark-900 p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-lg font-semibold">
                          {s.displayName || `Session #${s.id}`}
                        </span>
                        {s.username && (
                          <span className="text-sm text-gray-500">@{s.username}</span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        <span>#{s.id}</span>
                        <span>·</span>
                        <span>{s.phone || 'no phone'}</span>
                        <span>·</span>
                        <span className={s.isLoggedIn ? 'text-emerald-400' : 'text-amber-400'}>
                          {s.isLoggedIn ? 'logged in' : 'not logged in'}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => toggleSession(s.id)}
                        disabled={togglingId === s.id || !s.isLoggedIn}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 focus:ring-offset-dark-900 disabled:opacity-50 ${
                          settings.enabled ? 'bg-sky-500' : 'bg-gray-600'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            settings.enabled ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                      <span className="text-sm font-medium">
                        {settings.enabled ? 'AI ON' : 'AI OFF'}
                      </span>
                      <button
                        type="button"
                        onClick={() => expandSession(s.id)}
                        className="rounded-md p-1 hover:bg-white/5"
                      >
                        {expanded ? (
                          <ChevronUp className="h-5 w-5 text-gray-400" />
                        ) : (
                          <ChevronDown className="h-5 w-5 text-gray-400" />
                        )}
                      </button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="mt-4 border-t border-white/5 pt-4">
                      <h3 className="mb-2 text-sm font-semibold text-gray-300">
                        Per-chat overrides
                      </h3>
                      {(() => {
                        const chats = chatSettingsMap[s.id] || [];
                        if (!chats.length) {
                          return (
                            <p className="text-sm text-gray-500">
                              No chat overrides yet. AI defaults to ON for every chat when the session is enabled.
                            </p>
                          );
                        }
                        return (
                          <div className="space-y-2">
                            {chats.map((c) => (
                              <div
                                key={`${c.peer_type}:${c.peer_id}`}
                                className="flex items-center justify-between rounded-md bg-dark-800/50 px-3 py-2"
                              >
                                <div className="text-sm">
                                  <span className="text-gray-400">{PEER_LABEL[c.peer_type]}:</span>{' '}
                                  <span className="font-mono">{c.peer_id}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => toggleChat(s.id, c)}
                                    disabled={!!chatToggling}
                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                                      c.enabled ? 'bg-sky-500' : 'bg-gray-600'
                                    }`}
                                  >
                                    <span
                                      className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                                        c.enabled ? 'translate-x-5' : 'translate-x-1'
                                      }`}
                                    />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => clearMemory(s.id, c.peer_type, c.peer_id)}
                                    disabled={clearing === `${s.id}:${c.peer_type}:${c.peer_id}`}
                                    title="Clear memory"
                                    className="rounded-md p-1.5 text-gray-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}

                      <h3 className="mb-2 mt-4 text-sm font-semibold text-gray-300">
                        Recent AI logs
                      </h3>
                      {(() => {
                        const logs = logsMap[s.id] || [];
                        if (!logs.length) {
                          return (
                            <p className="text-sm text-gray-500">No AI response logs yet.</p>
                          );
                        }
                        return (
                          <div className="max-h-64 overflow-auto rounded-md bg-dark-800/30">
                            {logs.map((log) => {
                              const pill = _statusPill(log.status);
                              return (
                                <div
                                  key={log.id}
                                  className="flex items-center justify-between border-b border-white/5 px-3 py-2 text-sm last:border-0"
                                >
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${TONE_CLASSES[pill.tone]}`}
                                    >
                                      <pill.Icon className="h-3 w-3" />
                                      {pill.label}
                                    </span>
                                    <span className="text-gray-400">
                                      {PEER_LABEL[log.peer_type]} {log.peer_id}
                                    </span>
                                  </div>
                                  <span className="text-xs text-gray-600">
                                    {new Date(log.created_at).toLocaleString()}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
