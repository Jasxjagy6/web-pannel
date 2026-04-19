import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../components/common/Toast';
import { listSessions } from '../api/sessions';
import { sendBulkToGroups, getJobs } from '../api/messages';
import { parseApiError, formatRelativeTime } from '../utils/formatters';
import {
  Loader2,
  Users,
  Link,
  Settings,
  Check,
  Send,
  History,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
} from 'lucide-react';

export default function MessageGroupsTab() {
  const { showSuccess, showError } = useToast();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [groupIds, setGroupIds] = useState('');
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
  const [message, setMessage] = useState('');
  const [delayBetweenRounds, setDelayBetweenRounds] = useState(20);
  const [submitting, setSubmitting] = useState(false);
  const [showAllSessions, setShowAllSessions] = useState(false);

  // Job history
  const [jobHistory, setJobHistory] = useState([]);
  const [jobHistoryLoading, setJobHistoryLoading] = useState(false);

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    try {
      const response = await listSessions({ limit: 100 });
      setSessions(response.data.data?.sessions || []);
    } catch (err) {
      console.warn('Failed to fetch sessions:', parseApiError(err));
    }
  }, []);

  // Fetch job history
  const fetchJobHistory = useCallback(async () => {
    setJobHistoryLoading(true);
    try {
      const response = await getJobs({ page: 1, limit: 20 });
      const jobs = response.data.data?.jobs || [];
      // Filter only bulk_groups jobs
      setJobHistory(jobs.filter(j => j.job_type === 'bulk_groups'));
    } catch (err) {
      console.warn('Failed to fetch job history:', parseApiError(err));
    } finally {
      setJobHistoryLoading(false);
    }
  }, []);

  // Load data on mount
  useEffect(() => {
    fetchSessions();
    fetchJobHistory();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activeSessions = sessions.filter((s) => s.status?.toLowerCase() === 'active' || s.is_logged_in);
  const displayedSessions = showAllSessions ? sessions : activeSessions;

  const toggleSession = (sessionId) => {
    setSelectedSessionIds(prev =>
      prev.includes(sessionId)
        ? prev.filter(id => id !== sessionId)
        : [...prev, sessionId]
    );
  };

  const selectAllSessions = () => {
    const activeIds = activeSessions.map(s => s.id);
    setSelectedSessionIds(activeIds);
  };

  const deselectAllSessions = () => {
    setSelectedSessionIds([]);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Validation
    if (!message.trim()) {
      showError('Please enter a message.', 'Validation Error');
      return;
    }
    if (message.length > 4096) {
      showError('Message exceeds maximum length.', 'Validation Error');
      return;
    }
    if (selectedSessionIds.length === 0) {
      showError('Please select at least one session.', 'Validation Error');
      return;
    }
    if (!groupIds.trim()) {
      showError('Please enter at least one group/channel.', 'Validation Error');
      return;
    }

    setSubmitting(true);

    try {
      const groups = groupIds
        .split('\n')
        .map(g => g.trim())
        .filter(g => g.length > 0);

      const response = await sendBulkToGroups({
        sessionIds: selectedSessionIds,
        groupIds: groups,
        message: message.trim(),
        messageType: 'text',
        delayBetweenRounds: parseInt(delayBetweenRounds, 10),
      });

      const result = response.data.data;
      showSuccess(
        `Job queued successfully! ${result.total} group(s) will receive the message.`,
        'Job Queued'
      );

      // Reset form
      setMessage('');
      setGroupIds('');
      setSelectedSessionIds([]);

      // Refresh job history after a short delay
      setTimeout(() => fetchJobHistory(), 1000);

    } catch (err) {
      showError(parseApiError(err), 'Send Failed');
    } finally {
      setSubmitting(false);
    }
  };

  const inputBase = 'w-full rounded-lg border bg-dark-900 py-2.5 px-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition';
  const inputError = 'border-red-500/50';
  const inputNormal = 'border-white/10';
  const labelClass = 'mb-1.5 block text-sm font-medium text-gray-300';

  return (
    <div className="space-y-6">
      {/* Message Input */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
        <h3 className="mb-4 text-sm font-semibold text-white flex items-center gap-2">
          <Send className="w-4 h-4 text-primary-500" />
          Message
        </h3>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium text-gray-300">Message Content</label>
            <span className={`text-xs font-mono ${message.length > 4096 ? 'text-red-400' : 'text-gray-500'}`}>
              {message.length} / 4096
            </span>
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type your message here..."
            rows={6}
            className={`w-full rounded-lg border bg-dark-900 py-2.5 px-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition resize-y ${
              message.length > 4096 ? inputError : inputNormal
            }`}
          />
          {message.length > 4096 && (
            <p className="mt-1 text-xs text-red-400">
              Message exceeds maximum length by {message.length - 4096} characters.
            </p>
          )}
        </div>
      </div>

      {/* Groups and Sessions Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Groups Input */}
        <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
          <h3 className="mb-4 text-sm font-semibold text-white flex items-center gap-2">
            <Link className="w-4 h-4 text-primary-500" />
            Target Groups/Channels
          </h3>
          <div>
            <label className={labelClass}>
              Groups/Channels (one per line)
            </label>
            <textarea
              value={groupIds}
              onChange={(e) => setGroupIds(e.target.value)}
              placeholder="@group1
@testnets
https://t.me/example_group
(one per line)"
              rows={6}
              className={`${inputBase} ${!groupIds.trim() ? inputNormal : inputNormal} resize-none`}
            />
            {groupIds.trim() && (
              <p className="mt-1 text-xs text-gray-500">
                {groupIds.split('\n').filter(g => g.trim()).length} group(s) entered
              </p>
            )}
          </div>
        </div>

        {/* Session Selection */}
        <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
          <h3 className="mb-4 text-sm font-semibold text-white flex items-center gap-2">
            <Users className="w-4 h-4 text-primary-500" />
            Sessions ({selectedSessionIds.length} selected)
          </h3>

          <div className="flex gap-2 mb-2">
            <button type="button" onClick={selectAllSessions} className="text-xs text-primary-400 hover:text-primary-300">
              Select All Active
            </button>
            <span className="text-xs text-gray-600">|</span>
            <button type="button" onClick={deselectAllSessions} className="text-xs text-gray-400 hover:text-gray-300">
              Deselect All
            </button>
          </div>

          <div className="max-h-48 overflow-y-auto rounded-lg border border-white/10 bg-dark-900 p-2 space-y-1">
            {displayedSessions.map((s) => {
              const isSelected = selectedSessionIds.includes(s.id);
              const isActive = s.status?.toLowerCase() === 'active' || s.is_logged_in;
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
                  <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                    isSelected ? 'border-primary-500 bg-primary-500/30' : 'border-gray-600'
                  }`}>
                    {isSelected && <Check className="w-3 h-3 text-primary-400" />}
                  </div>
                  <span className="truncate">{s.phone || s.id}</span>
                  {s.username && <span className="text-gray-500 text-xs">@{s.username}</span>}
                </button>
              );
            })}
          </div>
          {activeSessions.length === 0 && (
            <p className="mt-2 text-xs text-amber-400">No active sessions. Please login first.</p>
          )}
        </div>
      </div>

      {/* Rate Limiting Settings */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
        <h3 className="mb-4 text-sm font-semibold text-white flex items-center gap-2">
          <Settings className="w-4 h-4 text-primary-500" />
          Rate Limiting
        </h3>
        <div className="max-w-xs">
          <label className={labelClass}>
            Delay Between Rounds (seconds)
          </label>
          <input
            type="number"
            min={5}
            max={300}
            value={delayBetweenRounds}
            onChange={(e) => setDelayBetweenRounds(Math.min(300, Math.max(5, Number(e.target.value))))}
            className={`${inputBase} ${inputNormal}`}
          />
          <p className="mt-1 text-xs text-gray-500">
            Wait time before each session sends to next batch of groups. Higher = safer from bans.
          </p>
        </div>
      </div>

      {/* Send Button */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-6 flex flex-col items-center justify-center">
        <div className="text-center space-y-3 w-full max-w-md">
          <div className="w-12 h-12 rounded-full bg-primary-500/10 flex items-center justify-center mx-auto">
            <Send className="w-6 h-6 text-primary-500" />
          </div>
          <div>
            <p className="text-sm font-medium text-white">Ready to Send</p>
            <p className="text-xs text-gray-500 mt-1">
              {selectedSessionIds.length} session(s) &middot; {groupIds.split('\n').filter(g => g.trim()).length} group(s)
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
                Starting Job...
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Send to All Groups
              </>
            )}
          </button>
        </div>
      </div>

      {/* Job History */}
      <div className="rounded-xl border border-white/5 bg-dark-800 shadow-sm">
      <div className="border-b border-white/5 p-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <History className="w-4 h-4 text-primary-500" />
          Job History
        </h3>
        <button
          onClick={fetchJobHistory}
          disabled={jobHistoryLoading}
          className="text-xs text-primary-400 hover:text-primary-300 disabled:opacity-50"
        >
          {jobHistoryLoading ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Refresh'}
        </button>
      </div>

      <div className="divide-y divide-white/5">
        {jobHistoryLoading ? (
          <div className="py-16 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary-500" />
            <p className="mt-3 text-sm text-gray-400">Loading job history...</p>
          </div>
        ) : jobHistory.length === 0 ? (
          <div className="py-16 text-center">
            <History className="mx-auto mb-3 h-10 w-10 text-gray-600" />
            <p className="text-sm text-gray-400">No job history yet</p>
            <p className="mt-1 text-xs text-gray-500">Send messages to groups to see history here</p>
          </div>
        ) : (
          jobHistory.map((job) => (
            <div key={job.id} className="p-4 hover:bg-white/[0.02] transition-colors">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-white">Job #{job.id}</span>
                    {job.status === 'completed' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/15 text-green-400">
                        <CheckCircle className="w-3 h-3" />
                        Completed
                      </span>
                    )}
                    {job.status === 'running' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/15 text-blue-400">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Running
                      </span>
                    )}
                    {job.status === 'pending' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/15 text-yellow-400">
                        <Clock className="w-3 h-3" />
                        Pending
                      </span>
                    )}
                    {job.status === 'failed' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/15 text-red-400">
                        <XCircle className="w-3 h-3" />
                        Failed
                      </span>
                    )}
                    {job.status === 'cancelled' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/15 text-gray-400">
                        <AlertCircle className="w-3 h-3" />
                        Cancelled
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400 space-y-1">
                    <p>{job.total_count || 0} group(s) &middot; {formatRelativeTime(job.created_at)}</p>
                    {job.started_at && (
                      <p>Started: {formatRelativeTime(job.started_at)}</p>
                    )}
                  </div>
                  {job.message && (
                    <p className="mt-2 text-sm text-gray-300 line-clamp-2">{job.message}</p>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
    </div>
  );
}
