/**
 * AiChatTracking — full visibility into what the AI auto-responder did.
 *
 * Three drill-down levels, all backed by the existing ai_response_logs
 * audit trail (so historical data is fully covered):
 *
 *   1. Overview      — owner-wide totals + status breakdown.
 *   2. Sessions      — per-session cards (conversations / messages sent).
 *   3. Conversations — every peer the AI talked to in a session, and a
 *                      full message-by-message transcript of exactly what
 *                      the user said and what the AI replied.
 *
 * Rendered as the "Tracking" tab inside the AI Chat page.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  RefreshCcw,
  Activity,
  MessageSquare,
  Send,
  Users2,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronRight,
  ArrowLeft,
  Bot,
  User as UserIcon,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import {
  getAiTrackingOverview,
  getAiTrackedConversations,
  getAiConversationTranscript,
} from '../api/aiChat';
import { useToast } from '../components/common/Toast';

const STATUS_TONE = {
  sent:         { label: 'Sent',         cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', Icon: CheckCircle2 },
  failed:       { label: 'Failed',       cls: 'bg-red-500/10 text-red-300 border-red-500/30',             Icon: XCircle },
  send_failed:  { label: 'Send failed',  cls: 'bg-red-500/10 text-red-300 border-red-500/30',             Icon: XCircle },
  rate_limited: { label: 'Rate limited', cls: 'bg-amber-500/10 text-amber-200 border-amber-500/30',       Icon: Clock },
  no_reply:     { label: 'No reply',     cls: 'bg-white/5 text-gray-300 border-white/10',                 Icon: MessageSquare },
  not_our_turn: { label: 'Not our turn', cls: 'bg-white/5 text-gray-300 border-white/10',                 Icon: Clock },
  ghosting:     { label: 'Ghosting',     cls: 'bg-white/5 text-gray-300 border-white/10',                 Icon: Clock },
  pending:      { label: 'Pending',      cls: 'bg-sky-500/10 text-sky-200 border-sky-500/30',             Icon: Clock },
};

function statusTone(status) {
  return STATUS_TONE[status] || { label: status || 'unknown', cls: 'bg-white/5 text-gray-300 border-white/10', Icon: Clock };
}

function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function StatCard({ icon: Icon, label, value, tone = 'sky', hint }) {
  const toneCls = {
    sky:     'text-sky-400',
    emerald: 'text-emerald-400',
    violet:  'text-violet-400',
    amber:   'text-amber-400',
    gray:    'text-gray-400',
  }[tone] || 'text-sky-400';
  return (
    <div className="rounded-xl border border-white/5 bg-dark-900 p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-gray-500">
        <Icon className={`h-4 w-4 ${toneCls}`} />
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold text-gray-100">{value}</div>
      {hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
    </div>
  );
}

function convoLabel(c) {
  if (c.recipientName) return c.recipientName;
  if (c.recipientUsername && c.recipientUsername !== 'john_smith2') return `@${c.recipientUsername}`;
  return `User ${c.peerId}`;
}

export default function AiChatTracking() {
  const toast = useToast();

  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Drill-down state
  const [activeSession, setActiveSession] = useState(null); // { sessionId, displayName }
  const [conversations, setConversations] = useState([]);
  const [convosLoading, setConvosLoading] = useState(false);

  const [activeConvo, setActiveConvo] = useState(null); // conversation row
  const [transcript, setTranscript] = useState(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);

  const loadOverview = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await getAiTrackingOverview();
      setOverview(data?.data || null);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.response?.data?.error || err?.message || 'Failed to load tracking data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openSession = async (sess) => {
    setActiveSession(sess);
    setActiveConvo(null);
    setTranscript(null);
    setConversations([]);
    setConvosLoading(true);
    try {
      const { data } = await getAiTrackedConversations(sess.sessionId);
      setConversations(data?.data?.rows || []);
    } catch (err) {
      toast.error('Failed to load conversations for this session');
    } finally {
      setConvosLoading(false);
    }
  };

  const openConvo = async (convo) => {
    setActiveConvo(convo);
    setTranscript(null);
    setTranscriptLoading(true);
    try {
      const { data } = await getAiConversationTranscript(
        activeSession.sessionId,
        convo.peerType,
        convo.peerId
      );
      setTranscript(data?.data || { events: [], total: 0 });
    } catch (err) {
      toast.error('Failed to load conversation transcript');
    } finally {
      setTranscriptLoading(false);
    }
  };

  const backToSessions = () => {
    setActiveSession(null);
    setActiveConvo(null);
    setTranscript(null);
    setConversations([]);
  };

  const backToConversations = () => {
    setActiveConvo(null);
    setTranscript(null);
  };

  const totals = overview?.totals || {};
  const sessions = overview?.sessions || [];

  const sentRate = useMemo(() => {
    if (!totals.totalEvents) return 0;
    return Math.round((totals.sent / totals.totalEvents) * 100);
  }, [totals]);

  // ── Breadcrumb ────────────────────────────────────────────────────
  const Breadcrumb = () => (
    <div className="mb-4 flex flex-wrap items-center gap-1 text-sm text-gray-400">
      <button onClick={backToSessions} className="hover:text-sky-300">All sessions</button>
      {activeSession && (
        <>
          <ChevronRight className="h-4 w-4 text-gray-600" />
          <button onClick={backToConversations} className={activeConvo ? 'hover:text-sky-300' : 'text-gray-200 font-medium'}>
            {activeSession.displayName}
          </button>
        </>
      )}
      {activeConvo && (
        <>
          <ChevronRight className="h-4 w-4 text-gray-600" />
          <span className="text-gray-200 font-medium">{convoLabel(activeConvo)}</span>
        </>
      )}
    </div>
  );

  if (loading && !overview) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        <Loader2 className="mr-2 h-6 w-6 animate-spin" />
        Loading AI tracking…
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-4 text-red-300">
        <AlertTriangle className="h-5 w-5" />
        {error}
      </div>
    );
  }

  return (
    <div>
      {/* Header + refresh */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-100">
            <Activity className="h-5 w-5 text-sky-400" />
            AI Activity Tracking
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Every conversation the AI handled and the exact messages it sent — across all sessions and history.
          </p>
        </div>
        <button
          type="button"
          onClick={() => (activeConvo ? openConvo(activeConvo) : activeSession ? openSession(activeSession) : loadOverview())}
          className="flex items-center gap-2 rounded-md bg-dark-800 px-3 py-2 text-sm hover:bg-dark-700"
        >
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {/* LEVEL 1: overview stats (always visible at top when no session drilled) */}
      {!activeSession && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard icon={Users2}       label="Sessions"      value={fmtNum(totals.activeSessions)} tone="sky" hint="with AI activity" />
            <StatCard icon={MessageSquare} label="Conversations" value={fmtNum(totals.conversations)}  tone="violet" hint="distinct chats" />
            <StatCard icon={Send}         label="Messages sent" value={fmtNum(totals.sent)}           tone="emerald" hint={`${sentRate}% of attempts`} />
            <StatCard icon={Activity}     label="Total events"  value={fmtNum(totals.totalEvents)}    tone="gray" hint="all AI attempts" />
            <StatCard icon={Sparkles}     label="Conversions"   value={fmtNum(totals.conversions)}    tone="amber" hint="did-convert flag" />
            <StatCard icon={Clock}        label="Last activity" value={totals.lastActivity ? new Date(totals.lastActivity).toLocaleDateString() : '—'} tone="gray" hint={totals.lastActivity ? new Date(totals.lastActivity).toLocaleTimeString() : ''} />
          </div>

          {/* Status breakdown */}
          {overview?.statusBreakdown?.length > 0 && (
            <div className="mb-6 flex flex-wrap gap-2">
              {overview.statusBreakdown.map((s) => {
                const t = statusTone(s.status);
                return (
                  <span key={s.status} className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${t.cls}`}>
                    <t.Icon className="h-3.5 w-3.5" />
                    {t.label}
                    <span className="font-semibold">{fmtNum(s.count)}</span>
                  </span>
                );
              })}
            </div>
          )}

          {/* LEVEL 2: per-session cards */}
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Per-session activity</h3>
          {sessions.length === 0 ? (
            <div className="rounded-lg border border-white/5 bg-dark-900 p-8 text-center text-gray-500">
              No AI activity recorded yet. Once the AI replies to a chat, it will show up here.
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => (
                <button
                  key={s.sessionId}
                  onClick={() => openSession(s)}
                  className="flex w-full items-center justify-between rounded-lg border border-white/5 bg-dark-900 p-4 text-left transition-colors hover:border-sky-500/30 hover:bg-dark-800"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold text-gray-100">{s.displayName}</span>
                      <span className="text-xs text-gray-600">#{s.sessionId}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                      <span className="flex items-center gap-1"><MessageSquare className="h-3.5 w-3.5 text-violet-400" />{fmtNum(s.conversations)} conversations</span>
                      <span className="flex items-center gap-1"><Send className="h-3.5 w-3.5 text-emerald-400" />{fmtNum(s.sent)} sent</span>
                      <span className="flex items-center gap-1"><Activity className="h-3.5 w-3.5 text-gray-400" />{fmtNum(s.totalEvents)} events</span>
                      {s.conversions > 0 && <span className="flex items-center gap-1"><Sparkles className="h-3.5 w-3.5 text-amber-400" />{fmtNum(s.conversions)} converted</span>}
                      <span>· last {fmtDateTime(s.lastActivity)}</span>
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5 shrink-0 text-gray-600" />
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* LEVEL 2.5: conversation list for a session */}
      {activeSession && !activeConvo && (
        <>
          <Breadcrumb />
          <button onClick={backToSessions} className="mb-3 flex items-center gap-1 text-sm text-gray-400 hover:text-sky-300">
            <ArrowLeft className="h-4 w-4" /> Back to sessions
          </button>
          <h3 className="mb-3 text-sm font-semibold text-gray-200">
            Conversations for {activeSession.displayName}
          </h3>
          {convosLoading ? (
            <div className="flex items-center py-10 text-gray-400">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading conversations…
            </div>
          ) : conversations.length === 0 ? (
            <div className="rounded-lg border border-white/5 bg-dark-900 p-8 text-center text-gray-500">
              No AI conversations recorded for this session.
            </div>
          ) : (
            <div className="space-y-2">
              {conversations.map((c) => (
                <button
                  key={`${c.peerType}:${c.peerId}`}
                  onClick={() => openConvo(c)}
                  className="flex w-full items-center justify-between rounded-lg border border-white/5 bg-dark-900 p-3 text-left transition-colors hover:border-sky-500/30 hover:bg-dark-800"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-500/10 text-sky-300">
                      <UserIcon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-medium text-gray-100">{convoLabel(c)}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-gray-500">
                        <span className="flex items-center gap-1"><Send className="h-3 w-3 text-emerald-400" />{fmtNum(c.sent)} sent</span>
                        <span className="flex items-center gap-1"><Activity className="h-3 w-3 text-gray-400" />{fmtNum(c.totalEvents)} events</span>
                        {c.conversions > 0 && <span className="flex items-center gap-1"><Sparkles className="h-3 w-3 text-amber-400" />converted</span>}
                        <span>· last {fmtDateTime(c.lastAt)}</span>
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5 shrink-0 text-gray-600" />
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* LEVEL 3: full transcript */}
      {activeSession && activeConvo && (
        <>
          <Breadcrumb />
          <button onClick={backToConversations} className="mb-3 flex items-center gap-1 text-sm text-gray-400 hover:text-sky-300">
            <ArrowLeft className="h-4 w-4" /> Back to conversations
          </button>

          <div className="mb-4 rounded-lg border border-white/5 bg-dark-900 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-500/10 text-sky-300">
                <UserIcon className="h-5 w-5" />
              </div>
              <div>
                <div className="font-semibold text-gray-100">{convoLabel(activeConvo)}</div>
                <div className="text-xs text-gray-500">
                  {activeConvo.peerType} · id {activeConvo.peerId} · {fmtNum(activeConvo.sent)} messages sent by AI
                </div>
              </div>
            </div>
          </div>

          {transcriptLoading ? (
            <div className="flex items-center py-10 text-gray-400">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading transcript…
            </div>
          ) : !transcript || transcript.events.length === 0 ? (
            <div className="rounded-lg border border-white/5 bg-dark-900 p-8 text-center text-gray-500">
              No transcript available for this conversation.
            </div>
          ) : (
            <div className="space-y-4">
              {transcript.events.map((ev) => {
                const t = statusTone(ev.status);
                return (
                  <div key={ev.id} className="rounded-lg border border-white/5 bg-dark-900/60 p-3">
                    <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
                      <span className="flex items-center gap-2">
                        <span className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${t.cls}`}>
                          <t.Icon className="h-3 w-3" />
                          {t.label}
                        </span>
                        {ev.isFollowUp && <span className="rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-violet-200">Follow-up</span>}
                        {ev.didConvert && <span className="flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-200"><Sparkles className="h-3 w-3" />Converted</span>}
                        {ev.category && <span className="text-gray-600">{ev.category}</span>}
                      </span>
                      <span>{fmtDateTime(ev.createdAt)}</span>
                    </div>

                    {/* Incoming user message */}
                    {ev.incomingText ? (
                      <div className="mb-2 flex gap-2">
                        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/5 text-gray-400">
                          <UserIcon className="h-3.5 w-3.5" />
                        </div>
                        <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-dark-800 px-3 py-2 text-sm text-gray-200">
                          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">User</div>
                          <span className="whitespace-pre-wrap break-words">{ev.incomingText}</span>
                        </div>
                      </div>
                    ) : null}

                    {/* AI reply */}
                    {ev.aiText ? (
                      <div className="flex flex-row-reverse gap-2">
                        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-sky-300">
                          <Bot className="h-3.5 w-3.5" />
                        </div>
                        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-sky-500/10 px-3 py-2 text-sm text-sky-100">
                          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-400/70">AI {ev.aiSent ? 'sent' : '(not sent)'}</div>
                          <span className="whitespace-pre-wrap break-words">{ev.aiText}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-row-reverse gap-2">
                        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/5 text-gray-500">
                          <Bot className="h-3.5 w-3.5" />
                        </div>
                        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-white/5 px-3 py-2 text-sm text-gray-400">
                          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">AI — no message</div>
                          <span className="italic">{ev.errorMessage || t.label}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
