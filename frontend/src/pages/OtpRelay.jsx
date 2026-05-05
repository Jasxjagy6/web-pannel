import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ShieldCheck,
  Plus,
  Trash2,
  RefreshCcw,
  Power,
  PowerOff,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Loader2,
  Info,
  Activity,
} from 'lucide-react';
import { useToast } from '../components/common/Toast';
import { listSessions } from '../api/sessions';
import {
  listOtpRelays,
  createOtpRelay,
  updateOtpRelay,
  deleteOtpRelay,
  listOtpRelayEvents,
} from '../api/otpRelays';
import { parseApiError, formatRelativeTime } from '../utils/formatters';

const STATUS_PILL = {
  forwarded: {
    label: 'Forwarded',
    cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    icon: CheckCircle2,
  },
  skipped_regex: {
    label: 'Skipped (regex)',
    cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    icon: Info,
  },
  rate_limited: {
    label: 'Rate limited',
    cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    icon: AlertTriangle,
  },
  send_failed: {
    label: 'Send failed',
    cls: 'bg-red-500/15 text-red-300 border-red-500/30',
    icon: XCircle,
  },
  watch_disconnected: {
    label: 'Relay offline',
    cls: 'bg-red-500/15 text-red-300 border-red-500/30',
    icon: XCircle,
  },
};

function StatusPill({ status }) {
  const cfg = STATUS_PILL[status] || {
    label: status,
    cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    icon: Info,
  };
  const Icon = cfg.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cfg.cls}`}
    >
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}

function CreateRow({ sessions, onSubmit, busy }) {
  const [watchId, setWatchId] = useState('');
  const [relayId, setRelayId] = useState('');
  const [senderFilter, setSenderFilter] = useState('777000,Telegram');
  const [regex, setRegex] = useState('');
  const [prefix, setPrefix] = useState('');
  const [rate, setRate] = useState(30);

  const submit = (e) => {
    e.preventDefault();
    if (!watchId || !relayId || watchId === relayId) return;
    onSubmit({
      watchSessionId: parseInt(watchId, 10),
      relaySessionId: parseInt(relayId, 10),
      senderFilter: senderFilter
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      regex: regex.trim() || null,
      prefix: prefix.trim() || null,
      rateLimitPerMin: parseInt(rate, 10) || 30,
    });
  };

  return (
    <form
      onSubmit={submit}
      className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3"
    >
      <div>
        <label className="block text-[11px] text-slate-400 mb-1">Watch session (source)</label>
        <select
          value={watchId}
          onChange={(e) => setWatchId(e.target.value)}
          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white"
          required
        >
          <option value="">— select session —</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id} disabled={String(s.id) === relayId}>
              {s.phone || `Session ${s.id}`}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[11px] text-slate-400 mb-1">Relay session (Saved Messages → here)</label>
        <select
          value={relayId}
          onChange={(e) => setRelayId(e.target.value)}
          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white"
          required
        >
          <option value="">— select session —</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id} disabled={String(s.id) === watchId}>
              {s.phone || `Session ${s.id}`}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[11px] text-slate-400 mb-1">Sender allow-list (comma-sep)</label>
        <input
          type="text"
          value={senderFilter}
          onChange={(e) => setSenderFilter(e.target.value)}
          placeholder="777000,Telegram"
          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white"
        />
      </div>
      <div>
        <label className="block text-[11px] text-slate-400 mb-1">Body regex (optional)</label>
        <input
          type="text"
          value={regex}
          onChange={(e) => setRegex(e.target.value)}
          placeholder="^Login code:"
          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm font-mono text-white"
        />
      </div>
      <div>
        <label className="block text-[11px] text-slate-400 mb-1">Prefix (optional)</label>
        <input
          type="text"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          placeholder="OTP for +91…"
          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white"
          maxLength={200}
        />
      </div>
      <div>
        <label className="block text-[11px] text-slate-400 mb-1">Rate limit (per minute)</label>
        <input
          type="number"
          min={1}
          max={600}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white"
        />
      </div>
      <div className="lg:col-span-3 flex justify-end">
        <button
          type="submit"
          disabled={busy || !watchId || !relayId || watchId === relayId}
          className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed px-4 py-2 rounded text-sm font-medium text-white"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Attach relay
        </button>
      </div>
    </form>
  );
}

function EventsPanel({ relayId }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listOtpRelayEvents(relayId, { limit: 50 });
      setEvents(r.data?.data?.items || []);
    } catch {
      // best-effort — failure is surfaced via the relay row's last_forward_error
    } finally {
      setLoading(false);
    }
  }, [relayId]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, [refresh]);

  if (loading && events.length === 0) {
    return (
      <div className="text-center text-slate-500 py-6 text-xs">
        <Loader2 className="w-4 h-4 animate-spin inline-block mr-1.5 -mb-0.5" />
        Loading events…
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="text-center text-slate-500 py-6 text-xs">
        No events yet. As soon as a 777000 DM lands on the watch session, you'll see it here.
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {events.map((e) => (
        <div
          key={e.id}
          className="flex items-start gap-2 px-3 py-2 bg-slate-900/50 border border-slate-800 rounded text-xs"
        >
          <StatusPill status={e.status} />
          <div className="flex-1 min-w-0">
            {e.message_excerpt && (
              <div className="text-slate-300 break-words">{e.message_excerpt}</div>
            )}
            {e.error_message && (
              <div className="text-red-300 mt-0.5">err: {e.error_message}</div>
            )}
            <div className="text-slate-500 mt-0.5 font-mono text-[10px]">
              from {e.sender_id || '?'} · {formatRelativeTime(e.created_at)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function OtpRelay() {
  const { showError, showSuccess } = useToast();
  const [sessions, setSessions] = useState([]);
  const [relays, setRelays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [actionId, setActionId] = useState(null);
  const [openEventsFor, setOpenEventsFor] = useState(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [sResp, rResp] = await Promise.all([
        listSessions({ limit: 200 }),
        listOtpRelays(),
      ]);
      const sessionItems = sResp.data?.data?.sessions || sResp.data?.data?.items || [];
      setSessions(sessionItems.filter((s) => s.is_logged_in || s.status === 'active'));
      setRelays(rResp.data?.data?.items || []);
    } catch (err) {
      showError(parseApiError(err), 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const onCreate = async (payload) => {
    setCreating(true);
    try {
      await createOtpRelay(payload);
      showSuccess('Relay attached. Listener live.', 'OTP Relay');
      await fetchAll();
    } catch (err) {
      showError(parseApiError(err), 'Attach failed');
    } finally {
      setCreating(false);
    }
  };

  const onToggle = async (r) => {
    setActionId(r.id);
    try {
      await updateOtpRelay(r.id, { enabled: !r.enabled });
      showSuccess(r.enabled ? 'Relay paused.' : 'Relay re-enabled.', 'OTP Relay');
      await fetchAll();
    } catch (err) {
      showError(parseApiError(err), 'Update failed');
    } finally {
      setActionId(null);
    }
  };

  const onDelete = async (r) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Detach this OTP relay? Audit history will be deleted.')) return;
    setActionId(r.id);
    try {
      await deleteOtpRelay(r.id);
      showSuccess('Relay detached.', 'OTP Relay');
      await fetchAll();
    } catch (err) {
      showError(parseApiError(err), 'Delete failed');
    } finally {
      setActionId(null);
    }
  };

  const sessionLabel = useMemo(() => {
    const m = new Map();
    for (const s of sessions) m.set(String(s.id), s.phone || `Session ${s.id}`);
    return (id) => m.get(String(id)) || `Session ${id}`;
  }, [sessions]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            Saved-Messages OTP Relay
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Forward incoming DMs from <code className="text-slate-300">777000</code>{' '}
            on a "watch" session into the Saved Messages of a different "relay"
            account. The relay account survives even if Telegram wipes the
            watch account end-to-end.
          </p>
        </div>
        <button
          onClick={fetchAll}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded text-sm text-slate-200 disabled:opacity-50"
        >
          <RefreshCcw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Education banner */}
      <div className="bg-emerald-950/40 border border-emerald-800 rounded-xl p-4 flex gap-3">
        <Info className="w-5 h-5 text-emerald-300 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-emerald-100/90 space-y-1.5">
          <p className="font-semibold text-emerald-200">
            How this complements anti-revoke Phase 4
          </p>
          <ul className="list-disc pl-5 space-y-0.5 text-emerald-100/80">
            <li>
              <b>Phase 4</b> stops Telegram from wiping the panel session due to
              <i> transient</i> errors, idle TTL, or the unconfirmed-window race.
            </li>
            <li>
              <b>This relay</b> is the safety net for the one case Phase 4 can't
              prevent: an <i>intentional</i> Telegram-side wipe of the watch
              account itself (SIM swap, password reset, account takedown, or a
              "Terminate all other sessions" tap on the phone).
            </li>
            <li>
              The relay account must be a <b>different Telegram number</b> (or
              userbot) — it does NOT need to be related to the watch account.
              Add it via Create Session like any other panel session, then
              attach it below.
            </li>
            <li>
              Forwards land in the relay account's <b>Saved Messages</b>. Open
              that chat from any device to read the OTP after a wipe.
            </li>
          </ul>
        </div>
      </div>

      {/* Create form */}
      {sessions.length >= 2 ? (
        <CreateRow sessions={sessions} onSubmit={onCreate} busy={creating} />
      ) : (
        <div className="bg-amber-950/40 border border-amber-800 rounded-xl p-4 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-300 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-100">
            You need at least 2 active Telegram sessions to attach a relay — one
            to watch and one to receive forwards. Add a second account via the{' '}
            <b>Create Session</b> page first.
          </div>
        </div>
      )}

      {/* Relay list */}
      <div className="space-y-3">
        {loading && relays.length === 0 ? (
          <div className="text-center text-slate-500 py-12 text-sm">
            <Loader2 className="w-5 h-5 animate-spin inline-block mr-2 -mb-0.5" />
            Loading relays…
          </div>
        ) : relays.length === 0 ? (
          <div className="text-center text-slate-500 py-12 text-sm bg-slate-800/40 rounded-xl border border-slate-800 border-dashed">
            No relays configured. Attach one above to forward 777000 DMs to a
            different account's Saved Messages.
          </div>
        ) : (
          relays.map((r) => (
            <div
              key={r.id}
              className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden"
            >
              <div className="p-4 flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm text-white">
                      {sessionLabel(r.watch_session_id)}
                    </span>
                    <ArrowRight className="w-4 h-4 text-slate-500" />
                    <span className="font-mono text-sm text-emerald-300">
                      {sessionLabel(r.relay_session_id)} (Saved)
                    </span>
                    {r.attached ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                        <Activity className="w-3 h-3" />
                        Live
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-500/15 text-slate-300 border border-slate-500/30">
                        Idle
                      </span>
                    )}
                    {!r.enabled && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-700 text-slate-300 border border-slate-600">
                        Paused
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1.5 font-mono">
                    senders: {(r.sender_filter || []).join(', ') || '—'}
                    {r.regex && <span className="ml-3">regex: {r.regex}</span>}
                    <span className="ml-3">limit: {r.rate_limit_per_min}/min</span>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1">
                    {r.last_forwarded_at ? (
                      <>last forward: {formatRelativeTime(r.last_forwarded_at)}</>
                    ) : (
                      <>never forwarded yet</>
                    )}
                    {r.event_count != null && (
                      <span className="ml-3">events: {r.event_count}</span>
                    )}
                  </div>
                  {r.last_forward_error && (
                    <div className="text-[11px] text-red-300 mt-1">
                      last error: {r.last_forward_error}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => onToggle(r)}
                    disabled={actionId === r.id}
                    className="p-2 text-slate-400 hover:text-white disabled:opacity-50"
                    title={r.enabled ? 'Pause' : 'Enable'}
                  >
                    {r.enabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={() =>
                      setOpenEventsFor(openEventsFor === r.id ? null : r.id)
                    }
                    className="px-2.5 py-1 text-xs bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded text-white"
                  >
                    {openEventsFor === r.id ? 'Hide events' : 'Events'}
                  </button>
                  <button
                    onClick={() => onDelete(r)}
                    disabled={actionId === r.id}
                    className="p-2 text-red-400 hover:text-red-300 disabled:opacity-50"
                    title="Detach"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {openEventsFor === r.id && (
                <div className="border-t border-slate-700 bg-slate-900/40 p-3">
                  <EventsPanel relayId={r.id} />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
