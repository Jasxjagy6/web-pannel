/**
 * Schedule tab — Messaging > Schedule.
 *
 * Lets the operator pick sessions + groups + a message + an
 * intervalMinutes cool-down, and the backend's message-schedule
 * tick loop keeps re-dispatching the same bulk-groups job after
 * each completion until the schedule is cancelled.
 *
 * The "Active Schedules" history below is auto-refreshed every 10s
 * so newly-dispatched runs (and "running"/"completed" badges)
 * reflect within at most one polling interval.
 *
 * Concurrency: many schedules can run side-by-side; the cancel
 * controls only ever affect the operator's own rows.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Loader2,
  Users,
  Link as LinkIcon,
  Settings,
  Check,
  Send,
  History,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
  Repeat,
  Trash2,
  Hash,
} from 'lucide-react';
import { useToast } from '../components/common/Toast';
import { listSessions } from '../api/sessions';
import {
  createSchedule,
  listSchedules,
  cancelSchedule as cancelScheduleApi,
  cancelAllSchedules as cancelAllSchedulesApi,
} from '../api/messages';
import { parseApiError, formatRelativeTime } from '../utils/formatters';
import SessionListSwitcher from '../components/common/SessionListSwitcher';

const POLL_INTERVAL_MS = 10_000;

const inputBase =
  'w-full rounded-lg border bg-dark-900 py-2.5 px-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition';
const inputNormal = 'border-white/10';
const labelClass = 'mb-1.5 block text-sm font-medium text-gray-300';

function StatusBadge({ status }) {
  const map = {
    running: {
      cls: 'bg-blue-500/15 text-blue-400',
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
      label: 'Running',
    },
    cancelled: {
      cls: 'bg-gray-500/15 text-gray-400',
      icon: <AlertCircle className="w-3 h-3" />,
      label: 'Cancelled',
    },
    completed: {
      cls: 'bg-green-500/15 text-green-400',
      icon: <CheckCircle className="w-3 h-3" />,
      label: 'Completed',
    },
    failed: {
      cls: 'bg-red-500/15 text-red-400',
      icon: <XCircle className="w-3 h-3" />,
      label: 'Failed',
    },
  };
  const cfg = map[status] || {
    cls: 'bg-gray-500/15 text-gray-400',
    icon: <AlertCircle className="w-3 h-3" />,
    label: status || 'unknown',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.cls}`}
    >
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function LastJobBadge({ status }) {
  if (!status) return null;
  const map = {
    pending: { cls: 'bg-yellow-500/15 text-yellow-400', label: 'Last run: pending' },
    running: { cls: 'bg-blue-500/15 text-blue-400', label: 'Last run: in flight' },
    completed: { cls: 'bg-green-500/15 text-green-400', label: 'Last run: completed' },
    failed: { cls: 'bg-red-500/15 text-red-400', label: 'Last run: failed' },
    cancelled: { cls: 'bg-gray-500/15 text-gray-400', label: 'Last run: cancelled' },
  };
  const cfg = map[status] || {
    cls: 'bg-gray-500/15 text-gray-400',
    label: `Last run: ${status}`,
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}

export default function MessageSchedulesTab() {
  const { showSuccess, showError } = useToast();

  const [sessions, setSessions] = useState([]);
  const [groupIds, setGroupIds] = useState('');
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
  const [message, setMessage] = useState('');
  const [delayBetweenRounds, setDelayBetweenRounds] = useState(20);
  const [intervalMinutes, setIntervalMinutes] = useState(20);
  const [scheduleName, setScheduleName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showAllSessions, setShowAllSessions] = useState(false);
  // "Pick sessions" vs. "Use saved session list" — mirrors the
  // toggle the Users tab uses. Backend's createSchedule already
  // accepts `sessionListId` via resolveSessionIdsFromRequest.
  const [sessionPickMode, setSessionPickMode] = useState('sessions');
  const [selectedSessionListId, setSelectedSessionListId] = useState('');

  const [schedules, setSchedules] = useState([]);
  const [schedulesLoading, setSchedulesLoading] = useState(false);
  const [cancellingId, setCancellingId] = useState(null);
  const [cancellingAll, setCancellingAll] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      const response = await listSessions({ limit: 100 });
      setSessions(response.data.data?.sessions || []);
    } catch (err) {
      console.warn('Failed to fetch sessions:', parseApiError(err));
    }
  }, []);

  const fetchSchedules = useCallback(async () => {
    setSchedulesLoading(true);
    try {
      const response = await listSchedules({ limit: 100 });
      setSchedules(response.data.data?.schedules || []);
    } catch (err) {
      console.warn('Failed to fetch schedules:', parseApiError(err));
    } finally {
      setSchedulesLoading(false);
    }
  }, []);

  // Initial load + polling for live updates while schedules are running.
  useEffect(() => {
    fetchSessions();
    fetchSchedules();
    const handle = setInterval(fetchSchedules, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [fetchSessions, fetchSchedules]);

  const activeSessions = useMemo(
    () =>
      sessions.filter(
        (s) => s.status?.toLowerCase() === 'active' || s.is_logged_in
      ),
    [sessions]
  );
  const displayedSessions = showAllSessions ? sessions : activeSessions;

  const toggleSession = (sessionId) => {
    setSelectedSessionIds((prev) =>
      prev.includes(sessionId)
        ? prev.filter((id) => id !== sessionId)
        : [...prev, sessionId]
    );
  };
  const selectAllSessions = () =>
    setSelectedSessionIds(activeSessions.map((s) => s.id));
  const deselectAllSessions = () => setSelectedSessionIds([]);

  const groupCount = useMemo(
    () => groupIds.split('\n').filter((g) => g.trim()).length,
    [groupIds]
  );

  const runningCount = useMemo(
    () => schedules.filter((s) => s.status === 'running').length,
    [schedules]
  );

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!message.trim()) {
      showError('Please enter a message.', 'Validation Error');
      return;
    }
    if (message.length > 4096) {
      showError('Message exceeds maximum length.', 'Validation Error');
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
    if (!groupIds.trim()) {
      showError('Please enter at least one group/channel.', 'Validation Error');
      return;
    }
    const intNum = parseInt(intervalMinutes, 10);
    if (!Number.isFinite(intNum) || intNum < 1 || intNum > 10080) {
      showError(
        'Interval must be between 1 minute and 7 days (10080 minutes).',
        'Validation Error'
      );
      return;
    }

    setSubmitting(true);
    try {
      const groups = groupIds
        .split('\n')
        .map((g) => g.trim())
        .filter((g) => g.length > 0);

      const payload = {
        groupIds: groups,
        message: message.trim(),
        messageType: 'text',
        delayBetweenRounds: parseInt(delayBetweenRounds, 10),
        intervalMinutes: intNum,
        name: scheduleName.trim() || null,
      };
      if (usingSessionList) {
        payload.sessionListId = Number(selectedSessionListId);
      } else {
        payload.sessionIds = selectedSessionIds;
      }
      const response = await createSchedule(payload);

      const schedule = response.data.data;
      showSuccess(
        `Schedule #${schedule.id} created. Re-runs every ${schedule.intervalMinutes} minute(s) until cancelled.`,
        'Schedule Active'
      );

      setMessage('');
      setGroupIds('');
      setSelectedSessionIds([]);
      setSelectedSessionListId('');
      setSessionPickMode('sessions');
      setScheduleName('');
      // Don't reset interval/delay — operators usually keep the same cadence.
      fetchSchedules();
    } catch (err) {
      showError(parseApiError(err), 'Schedule Failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id) => {
    setCancellingId(id);
    try {
      await cancelScheduleApi(id);
      showSuccess(`Schedule #${id} cancelled.`, 'Cancelled');
      fetchSchedules();
    } catch (err) {
      showError(parseApiError(err), 'Cancel Failed');
    } finally {
      setCancellingId(null);
    }
  };

  const handleCancelAll = async () => {
    if (runningCount === 0) return;
    if (
      !window.confirm(
        `Cancel all ${runningCount} running schedule(s)? Any in-flight bulk-groups jobs will also be stopped.`
      )
    ) {
      return;
    }
    setCancellingAll(true);
    try {
      const response = await cancelAllSchedulesApi();
      const count = response.data.data?.cancelled ?? 0;
      showSuccess(`Cancelled ${count} schedule(s).`, 'Cancelled All');
      fetchSchedules();
    } catch (err) {
      showError(parseApiError(err), 'Cancel All Failed');
    } finally {
      setCancellingAll(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Message */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
        <h3 className="mb-4 text-sm font-semibold text-white flex items-center gap-2">
          <Send className="w-4 h-4 text-primary-500" />
          Message
        </h3>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium text-gray-300">
              Message Content
            </label>
            <span
              className={`text-xs font-mono ${
                message.length > 4096 ? 'text-red-400' : 'text-gray-500'
              }`}
            >
              {message.length} / 4096
            </span>
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type your message here..."
            rows={6}
            className={`${inputBase} ${
              message.length > 4096 ? 'border-red-500/50' : inputNormal
            } resize-y`}
          />
          {message.length > 4096 && (
            <p className="mt-1 text-xs text-red-400">
              Message exceeds maximum length by {message.length - 4096}{' '}
              characters.
            </p>
          )}
        </div>
      </div>

      {/* Groups + Sessions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
          <h3 className="mb-4 text-sm font-semibold text-white flex items-center gap-2">
            <LinkIcon className="w-4 h-4 text-primary-500" />
            Target Groups/Channels
          </h3>
          <label className={labelClass}>Groups/Channels (one per line)</label>
          <textarea
            value={groupIds}
            onChange={(e) => setGroupIds(e.target.value)}
            placeholder={'@group1\n@channel\nhttps://t.me/example_group'}
            rows={6}
            className={`${inputBase} ${inputNormal} resize-none`}
          />
          {groupIds.trim() && (
            <p className="mt-1 text-xs text-gray-500">
              {groupCount} group(s) entered
            </p>
          )}
        </div>

        <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
          <h3 className="mb-4 text-sm font-semibold text-white flex items-center gap-2">
            <Users className="w-4 h-4 text-primary-500" />
            {sessionPickMode === 'list'
              ? 'Sessions (from session list)'
              : `Sessions (${selectedSessionIds.length} selected)`}
          </h3>

          <SessionListSwitcher
            mode={sessionPickMode}
            onModeChange={setSessionPickMode}
            selectedSessionListId={selectedSessionListId}
            onSelectedSessionListIdChange={setSelectedSessionListId}
            className="mb-3"
          />

          {sessionPickMode === 'sessions' && (
            <>
              <div className="flex gap-2 mb-2">
                <button
                  type="button"
                  onClick={selectAllSessions}
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
                <span className="text-xs text-gray-600">|</span>
                <button
                  type="button"
                  onClick={() => setShowAllSessions((v) => !v)}
                  className="text-xs text-gray-400 hover:text-gray-300"
                >
                  {showAllSessions ? 'Show active only' : 'Show all'}
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto rounded-lg border border-white/10 bg-dark-900 p-2 space-y-1">
                {displayedSessions.map((s) => {
                  const isSelected = selectedSessionIds.includes(s.id);
                  const isActive =
                    s.status?.toLowerCase() === 'active' || s.is_logged_in;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggleSession(s.id)}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition ${
                        isSelected
                          ? 'bg-primary-500/20 text-primary-300 border border-primary-500/30'
                          : 'hover:bg-white/5 text-gray-300 border border-transparent'
                      } ${!isActive ? 'opacity-50' : ''}`}
                      disabled={!isActive}
                    >
                      <div
                        className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                          isSelected
                            ? 'border-primary-500 bg-primary-500/30'
                            : 'border-gray-600'
                        }`}
                      >
                        {isSelected && (
                          <Check className="w-3 h-3 text-primary-400" />
                        )}
                      </div>
                      <span className="truncate">{s.phone || s.id}</span>
                      {s.username && (
                        <span className="text-gray-500 text-xs">@{s.username}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              {activeSessions.length === 0 && (
                <p className="mt-2 text-xs text-amber-400">
                  No active sessions. Please login first.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Schedule Settings */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
        <h3 className="mb-4 text-sm font-semibold text-white flex items-center gap-2">
          <Settings className="w-4 h-4 text-primary-500" />
          Schedule Settings
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>
              Repeat every (minutes) <span className="text-red-400">*</span>
            </label>
            <input
              type="number"
              min={1}
              max={10080}
              value={intervalMinutes}
              onChange={(e) =>
                setIntervalMinutes(
                  Math.min(10080, Math.max(1, Number(e.target.value)))
                )
              }
              className={`${inputBase} ${inputNormal}`}
            />
            <p className="mt-1 text-xs text-gray-500">
              Wait this many minutes after a run finishes before sending the
              same message again.
            </p>
          </div>
          <div>
            <label className={labelClass}>
              Delay between rounds (seconds)
            </label>
            <input
              type="number"
              min={0}
              max={3600}
              value={delayBetweenRounds}
              onChange={(e) =>
                setDelayBetweenRounds(
                  Math.min(3600, Math.max(0, Number(e.target.value)))
                )
              }
              className={`${inputBase} ${inputNormal}`}
            />
            <p className="mt-1 text-xs text-gray-500">
              Intra-job rate limit between groups. Higher = safer.
            </p>
          </div>
          <div>
            <label className={labelClass}>Schedule name (optional)</label>
            <input
              type="text"
              value={scheduleName}
              onChange={(e) => setScheduleName(e.target.value)}
              maxLength={120}
              placeholder="Daily promo, weekend reminder…"
              className={`${inputBase} ${inputNormal}`}
            />
            <p className="mt-1 text-xs text-gray-500">
              Shown in the Active Schedules list below.
            </p>
          </div>
        </div>
      </div>

      {/* Submit */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-6 flex flex-col items-center justify-center">
        <div className="text-center space-y-3 w-full max-w-md">
          <div className="w-12 h-12 rounded-full bg-primary-500/10 flex items-center justify-center mx-auto">
            <Repeat className="w-6 h-6 text-primary-500" />
          </div>
          <div>
            <p className="text-sm font-medium text-white">
              Ready to Schedule
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {selectedSessionIds.length} session(s) &middot; {groupCount}{' '}
              group(s) &middot; every {intervalMinutes} min
            </p>
          </div>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary-600 to-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-primary-600/25 transition-all duration-200 hover:from-primary-500 hover:to-blue-500 hover:shadow-primary-500/30 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:ring-offset-2 focus:ring-offset-dark-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating Schedule...
              </>
            ) : (
              <>
                <Repeat className="w-4 h-4" />
                Start Recurring Schedule
              </>
            )}
          </button>
        </div>
      </div>

      {/* Active Schedules History */}
      <div className="rounded-xl border border-white/5 bg-dark-800 shadow-sm">
        <div className="border-b border-white/5 p-4 flex items-center justify-between gap-3 flex-wrap">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <History className="w-4 h-4 text-primary-500" />
            Active Schedules
            {runningCount > 0 && (
              <span className="text-xs text-gray-400">
                ({runningCount} running)
              </span>
            )}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchSchedules}
              disabled={schedulesLoading}
              className="text-xs text-primary-400 hover:text-primary-300 disabled:opacity-50"
            >
              {schedulesLoading ? (
                <Loader2 className="w-3 h-3 animate-spin inline" />
              ) : (
                'Refresh'
              )}
            </button>
            <button
              onClick={handleCancelAll}
              disabled={runningCount === 0 || cancellingAll}
              className="text-xs px-2 py-1 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {cancellingAll ? (
                <Loader2 className="w-3 h-3 animate-spin inline" />
              ) : (
                'Cancel All'
              )}
            </button>
          </div>
        </div>

        <div className="divide-y divide-white/5">
          {schedulesLoading && schedules.length === 0 ? (
            <div className="py-16 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary-500" />
              <p className="mt-3 text-sm text-gray-400">Loading schedules...</p>
            </div>
          ) : schedules.length === 0 ? (
            <div className="py-16 text-center">
              <Repeat className="mx-auto mb-3 h-10 w-10 text-gray-600" />
              <p className="text-sm text-gray-400">No schedules yet</p>
              <p className="mt-1 text-xs text-gray-500">
                Create one above to start recurring sends to your groups.
              </p>
            </div>
          ) : (
            schedules.map((s) => (
              <div
                key={s.id}
                className="p-4 hover:bg-white/[0.02] transition-colors"
              >
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-white">
                        {s.name || `Schedule #${s.id}`}
                      </span>
                      <StatusBadge status={s.status} />
                      <LastJobBadge status={s.lastJobStatus} />
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-white/5 text-gray-300">
                        <Clock className="w-3 h-3" />
                        every {s.intervalMinutes} min
                      </span>
                    </div>
                    <div className="text-xs text-gray-400 space-y-0.5">
                      <p>
                        <Hash className="inline w-3 h-3 mr-1" />
                        {(s.groupIds || []).length} group(s) &middot;{' '}
                        {(s.sessionIds || []).length} session(s)
                        {' '}&middot;{' '}
                        Runs: {s.totalRuns ?? 0}
                      </p>
                      <p>
                        Created {formatRelativeTime(s.createdAt)}
                        {s.lastRunAt && (
                          <>
                            {' '}&middot; Last dispatched{' '}
                            {formatRelativeTime(s.lastRunAt)}
                          </>
                        )}
                        {s.lastJobId && (
                          <> &middot; Job #{s.lastJobId}</>
                        )}
                      </p>
                      {s.lastError && (
                        <p className="text-red-400">
                          Last error: {s.lastError}
                        </p>
                      )}
                    </div>
                    {s.message && (
                      <p className="mt-2 text-sm text-gray-300 line-clamp-2">
                        {s.message}
                      </p>
                    )}
                  </div>
                  {s.status === 'running' && (
                    <button
                      onClick={() => handleCancel(s.id)}
                      disabled={cancellingId === s.id}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {cancellingId === s.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Trash2 className="w-3 h-3" />
                      )}
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
