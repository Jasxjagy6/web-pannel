import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../components/common/Toast';
import { listSessions } from '../api/sessions';
import { sendSingleUserMassDm } from '../api/messages';
import { parseApiError } from '../utils/formatters';
import SessionListSwitcher from '../components/common/SessionListSwitcher';
import {
  Loader2,
  Users,
  Send,
  AtSign,
  Settings,
  Check,
  AlertCircle,
  X,
  MessageSquare,
} from 'lucide-react';

// Single-User Mass DM tab.
//   - 1..3 target users (username / @username / numeric Telegram id)
//   - per-send delay (1..120 seconds)
//   - sessions picked individually OR via a saved Session List
//
// Working: every selected session DMs every target with `delaySeconds`
// inserted BETWEEN consecutive sends. The target count is hard-capped
// at 3 to keep accounts under Telegram's "DM-strangers" rate limit.
// All those rules are also enforced server-side; the form just keeps
// the operator from making an obvious mistake before submit.
const MAX_TARGETS = 3;
const MIN_DELAY_SECONDS = 1;
const MAX_DELAY_SECONDS = 120;
const MAX_MESSAGE_CHARS = 4096;

export default function MessageSingleUserTab({ onJobQueued }) {
  const { success: showSuccess, error: showError } = useToast();

  const [sessions, setSessions] = useState([]);
  const [message, setMessage] = useState('');
  const [targetsRaw, setTargetsRaw] = useState('');
  const [delaySeconds, setDelaySeconds] = useState(3);
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [sessionPickMode, setSessionPickMode] = useState('sessions');
  const [selectedSessionListId, setSelectedSessionListId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Parse the raw textarea/chip input into a clean array of trimmed,
  // de-duplicated targets. Accepts comma- or newline-separated input.
  const parsedTargets = (() => {
    const seen = new Set();
    const out = [];
    for (const piece of targetsRaw.split(/[,\n]/)) {
      const t = piece.trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  })();
  const targetsOverCap = parsedTargets.length > MAX_TARGETS;

  const fetchSessions = useCallback(async () => {
    try {
      const response = await listSessions({ limit: 100 });
      setSessions(response.data.data?.sessions || []);
    } catch (err) {
      console.warn('Failed to fetch sessions:', parseApiError(err));
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const activeSessions = sessions.filter(
    (s) => s.status?.toLowerCase() === 'active' || s.is_logged_in
  );
  const displayedSessions = showAllSessions ? sessions : activeSessions;

  const toggleSession = (sessionId) => {
    setSelectedSessionIds((prev) =>
      prev.includes(sessionId)
        ? prev.filter((id) => id !== sessionId)
        : [...prev, sessionId]
    );
  };
  const selectAllActiveSessions = () => {
    setSelectedSessionIds(activeSessions.map((s) => s.id));
  };
  const deselectAllSessions = () => setSelectedSessionIds([]);

  const removeTarget = (idx) => {
    const nextList = parsedTargets.filter((_, i) => i !== idx);
    setTargetsRaw(nextList.join(', '));
  };

  const handleSubmit = async (e) => {
    e?.preventDefault();

    if (!message.trim()) {
      showError('Please enter a message.', 'Validation Error');
      return;
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      showError(`Message exceeds ${MAX_MESSAGE_CHARS}-character limit.`, 'Validation Error');
      return;
    }
    if (parsedTargets.length === 0) {
      showError('Please enter at least one target user.', 'Validation Error');
      return;
    }
    if (targetsOverCap) {
      showError(
        `A maximum of ${MAX_TARGETS} targets is allowed. Remove ${parsedTargets.length - MAX_TARGETS} entry(ies).`,
        'Validation Error'
      );
      return;
    }
    const delayNum = Number(delaySeconds);
    if (
      !Number.isFinite(delayNum) ||
      delayNum < MIN_DELAY_SECONDS ||
      delayNum > MAX_DELAY_SECONDS
    ) {
      showError(
        `Delay must be between ${MIN_DELAY_SECONDS} and ${MAX_DELAY_SECONDS} seconds.`,
        'Validation Error'
      );
      return;
    }
    const usingSessionList = sessionPickMode === 'list' && selectedSessionListId;
    if (!usingSessionList && selectedSessionIds.length === 0) {
      showError(
        'Please select at least one session (or pick a session list).',
        'Validation Error'
      );
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        targets: parsedTargets,
        message: message.trim(),
        messageType: 'text',
        delaySeconds: delayNum,
      };
      if (usingSessionList) {
        payload.sessionListId = Number(selectedSessionListId);
      } else {
        payload.sessionIds = selectedSessionIds;
      }
      const response = await sendSingleUserMassDm(payload);
      const result = response.data.data || {};

      showSuccess(
        `Job queued: ${result.total || (parsedTargets.length * (selectedSessionIds.length || 0))} send(s) will fire across ${
          result.sessionCount ?? selectedSessionIds.length
        } session(s).`,
        'Single-User Mass DM started'
      );

      // Reset most of the form, but keep the message/delay so the
      // operator can quickly fire another batch with the same body.
      setTargetsRaw('');
      setSelectedSessionIds([]);
      setSelectedSessionListId('');
      setSessionPickMode('sessions');

      if (typeof onJobQueued === 'function') {
        onJobQueued(result);
      }
    } catch (err) {
      showError(parseApiError(err), 'Failed to queue Single-User Mass DM');
    } finally {
      setSubmitting(false);
    }
  };

  const inputBase =
    'w-full rounded-lg border bg-dark-900 py-2.5 px-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition';
  const labelClass = 'mb-1.5 block text-sm font-medium text-gray-300';

  const sendsPreview =
    parsedTargets.length *
    (sessionPickMode === 'list' ? 0 : selectedSessionIds.length);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* Message Composer */}
        <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
          <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
            <MessageSquare className="h-4 w-4 text-primary-500" />
            Message
          </h3>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-sm font-medium text-gray-300">Message Content</label>
              <span
                className={`font-mono text-xs ${
                  message.length > MAX_MESSAGE_CHARS ? 'text-red-400' : 'text-gray-500'
                }`}
              >
                {message.length} / {MAX_MESSAGE_CHARS}
              </span>
            </div>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Type the message every target will receive..."
              rows={6}
              className={`${inputBase} resize-y ${
                message.length > MAX_MESSAGE_CHARS ? 'border-red-500/50' : 'border-white/10'
              }`}
            />
          </div>
        </div>

        {/* Targets + Delay */}
        <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
          <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
            <AtSign className="h-4 w-4 text-primary-500" />
            Targets ({parsedTargets.length}/{MAX_TARGETS})
          </h3>

          <label className={labelClass}>Usernames or Telegram IDs</label>
          <textarea
            value={targetsRaw}
            onChange={(e) => setTargetsRaw(e.target.value)}
            placeholder={'@alice\n@bob\n12345678'}
            rows={3}
            className={`${inputBase} resize-none ${
              targetsOverCap ? 'border-red-500/50' : 'border-white/10'
            }`}
          />
          <p className="mt-1 text-xs text-gray-500">
            Up to {MAX_TARGETS} targets, one per line (or comma-separated). Accepts numeric IDs, usernames, or @usernames.
          </p>

          {parsedTargets.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {parsedTargets.map((t, i) => (
                <span
                  key={`${t}-${i}`}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
                    i >= MAX_TARGETS
                      ? 'border-red-500/40 bg-red-500/10 text-red-300'
                      : 'border-primary-500/30 bg-primary-500/10 text-primary-300'
                  }`}
                >
                  <span className="max-w-[140px] truncate">{t}</span>
                  <button
                    type="button"
                    onClick={() => removeTarget(i)}
                    className="text-current/70 hover:text-white"
                    aria-label={`Remove ${t}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {targetsOverCap && (
            <p className="mt-2 flex items-center gap-1 text-xs text-red-400">
              <AlertCircle className="h-3 w-3" />
              {parsedTargets.length - MAX_TARGETS} target(s) over the {MAX_TARGETS}-target cap. Remove the highlighted entries before sending.
            </p>
          )}

          <div className="mt-5">
            <label className={labelClass}>Delay between sends (seconds)</label>
            <input
              type="number"
              min={MIN_DELAY_SECONDS}
              max={MAX_DELAY_SECONDS}
              value={delaySeconds}
              onChange={(e) =>
                setDelaySeconds(
                  Math.min(
                    MAX_DELAY_SECONDS,
                    Math.max(MIN_DELAY_SECONDS, Number(e.target.value) || MIN_DELAY_SECONDS)
                  )
                )
              }
              className={`${inputBase} max-w-[140px] border-white/10`}
            />
            <p className="mt-1 text-xs text-gray-500">
              The panel waits this long between each session's send. Higher values = safer rate.
            </p>
          </div>
        </div>
      </div>

      {/* Session selection */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
            <Users className="h-4 w-4 text-primary-500" />
            {sessionPickMode === 'list'
              ? 'Sessions (from session list)'
              : `Sessions (${selectedSessionIds.length} selected)`}
          </h3>
          {sessionPickMode === 'sessions' && sessions.length > activeSessions.length && (
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={showAllSessions}
                onChange={(e) => setShowAllSessions(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Show inactive sessions
            </label>
          )}
        </div>

        <SessionListSwitcher
          mode={sessionPickMode}
          onModeChange={setSessionPickMode}
          selectedSessionListId={selectedSessionListId}
          onSelectedSessionListIdChange={setSelectedSessionListId}
          className="mb-3"
        />

        {sessionPickMode === 'sessions' && (
          <>
            <div className="mb-2 flex gap-2">
              <button
                type="button"
                onClick={selectAllActiveSessions}
                className="text-xs text-primary-400 hover:text-primary-300"
              >
                Select All Active
              </button>
              <span className="text-xs text-gray-600">|</span>
              <button
                type="button"
                onClick={deselectAllSessions}
                className="text-xs text-gray-400 hover:text-gray-300"
              >
                Deselect All
              </button>
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-white/10 bg-dark-900 p-2">
              {displayedSessions.map((s) => {
                const isSelected = selectedSessionIds.includes(s.id);
                const isActive = s.status?.toLowerCase() === 'active' || s.is_logged_in;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleSession(s.id)}
                    disabled={!isActive}
                    className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
                      isSelected
                        ? 'border border-primary-500/30 bg-primary-500/20 text-primary-300'
                        : 'border border-transparent text-gray-300 hover:bg-white/5'
                    } ${!isActive ? 'opacity-50' : ''}`}
                  >
                    <div
                      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                        isSelected ? 'border-primary-500 bg-primary-500/30' : 'border-gray-600'
                      }`}
                    >
                      {isSelected && <Check className="h-3 w-3 text-primary-400" />}
                    </div>
                    <span className="truncate">{s.phone || s.id}</span>
                    {s.username && <span className="text-xs text-gray-500">@{s.username}</span>}
                  </button>
                );
              })}
              {displayedSessions.length === 0 && (
                <p className="px-2 py-3 text-center text-xs text-gray-500">
                  No sessions to display.
                </p>
              )}
            </div>
            {activeSessions.length === 0 && (
              <p className="mt-2 text-xs text-amber-400">
                No active sessions. Please log in at least one session first.
              </p>
            )}
          </>
        )}
      </div>

      {/* Summary + Send */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <SummaryStat label="Targets" value={parsedTargets.length} max={MAX_TARGETS} />
          <SummaryStat
            label="Sessions"
            value={
              sessionPickMode === 'list' && selectedSessionListId
                ? '— (from list)'
                : selectedSessionIds.length
            }
          />
          <SummaryStat label="Delay (s)" value={delaySeconds} />
        </div>

        <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-gray-400">
            <Settings className="mr-1.5 inline h-4 w-4 text-gray-500" />
            {sessionPickMode === 'list' && selectedSessionListId
              ? `Each session in the chosen list will DM all ${parsedTargets.length} target(s), waiting ${delaySeconds}s between sends.`
              : `${sendsPreview} send(s) total — ${selectedSessionIds.length} session(s) × ${parsedTargets.length} target(s), ${delaySeconds}s apart.`}
          </p>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || targetsOverCap}
            className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary-600 to-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-600/25 transition-all duration-200 hover:from-primary-500 hover:to-blue-500 hover:shadow-primary-500/30 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:ring-offset-2 focus:ring-offset-dark-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Starting Job...
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Send Mass DM
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryStat({ label, value, max }) {
  const isNumber = typeof value === 'number';
  const overCap = isNumber && typeof max === 'number' && value > max;
  return (
    <div className="rounded-lg border border-white/5 bg-dark-900 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p
        className={`mt-1 text-lg font-semibold ${
          overCap ? 'text-red-400' : 'text-white'
        }`}
      >
        {String(value)}
        {typeof max === 'number' ? ` / ${max}` : ''}
      </p>
    </div>
  );
}
