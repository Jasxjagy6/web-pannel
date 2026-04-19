import { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { listSessions } from '../api/sessions';
import {
  sendBulk,
  getJobs,
  cancelJob,
  previewMessage,
  getMessageHistory,
} from '../api/messages';
import { listsAPI } from '../api/lists';
import { parseApiError, formatNumber, formatRelativeTime, formatDateTime } from '../utils/formatters';
import { useToast } from '../components/common/Toast';
import { Modal } from '../components/common/Modal';
import StatusBadge from '../components/common/StatusBadge';
import MessageGroupsTab from './MessageGroupsTab';
import {
  Send,
  Loader2,
  Play,
  X,
  Eye,
  StopCircle,
  FileText,
  Users,
  List,
  Settings,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  CheckCircle,
  Clock,
  MessageSquare,
  Paperclip,
  Image,
  Video,
  File,
  Sparkles,
  BarChart3,
  Search,
  Group,
} from 'lucide-react';
import {
  PaperClipIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline';

// ============================================================
// Message Composer Sub-Component
// ============================================================

function MessageComposer({ message, format, sessions, setMessage, setFormat, mediaFile, setMediaFile, onPreview }) {
  const MAX_CHARS = 4096;
  const fileInputRef = useRef(null);

  const charCount = message.length;
  const isOverLimit = charCount > MAX_CHARS;

  const formatOptions = [
    { value: 'text', label: 'Plain Text', icon: FileText },
    { value: 'html', label: 'HTML', icon: Sparkles },
    { value: 'markdown', label: 'Markdown', icon: Sparkles },
  ];

  const handleMediaChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      setMediaFile(e.target.files[0]);
    }
  };

  const removeMedia = () => {
    setMediaFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const getMediaIcon = (type) => {
    if (!type) return Paperclip;
    if (type.startsWith('image/')) return Image;
    if (type.startsWith('video/')) return Video;
    return File;
  };

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
      <h3 className="mb-4 text-sm font-semibold text-white flex items-center gap-2">
        <MessageSquare className="w-4 h-4 text-primary-500" />
        Message Composer
      </h3>

      <div className="space-y-4">
        {/* Format Selector */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-300">Message Format</label>
          <div className="flex gap-2">
            {formatOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setFormat(opt.value)}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                  format === opt.value
                    ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
                    : 'border-white/10 bg-dark-900 text-gray-400 hover:border-white/20 hover:text-white'
                }`}
              >
                <opt.icon className="w-3.5 h-3.5" />
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Textarea */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium text-gray-300">Message Content</label>
            <span className={`text-xs font-mono ${isOverLimit ? 'text-red-400' : 'text-gray-500'}`}>
              {charCount} / {MAX_CHARS}
            </span>
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type your message here..."
            rows={6}
            className={`w-full rounded-lg border bg-dark-900 py-2.5 px-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition resize-y ${
              isOverLimit ? 'border-red-500/50' : 'border-white/10'
            }`}
          />
          {isOverLimit && (
            <p className="mt-1 text-xs text-red-400">
              Message exceeds maximum length by {charCount - MAX_CHARS} characters.
            </p>
          )}
        </div>

        {/* Media Upload - Currently disabled, requires backend file upload endpoint */}
        <div className="opacity-50 pointer-events-none">
          <label className="mb-1.5 block text-sm font-medium text-gray-300">
            Attach Media (coming soon)
          </label>
          {!mediaFile ? (
            <button
              type="button"
              disabled
              className="flex items-center gap-2 rounded-lg border border-dashed border-white/10 bg-dark-900 px-4 py-3 text-sm text-gray-400 cursor-not-allowed w-full justify-center"
            >
              <Paperclip className="w-4 h-4" />
              Media upload requires backend setup
            </button>
          ) : (
            <div className="flex items-center justify-between rounded-lg border border-white/5 bg-dark-900 px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                {(() => {
                  const Icon = getMediaIcon(mediaFile.type);
                  return <Icon className="w-4 h-4 text-primary-400 flex-shrink-0" />;
                })()}
                <div className="min-w-0">
                  <p className="truncate text-sm text-white">{mediaFile.name}</p>
                  <p className="text-xs text-gray-500">
                    {(mediaFile.size / 1024).toFixed(1)} KB
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={removeMedia}
                className="flex-shrink-0 rounded p-1 text-gray-500 hover:text-white hover:bg-white/10 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,.pdf,.doc,.docx,.zip"
            onChange={handleMediaChange}
            className="hidden"
          />
        </div>

        {/* Preview Button */}
        <button
          type="button"
          onClick={onPreview}
          disabled={!message.trim() || isOverLimit}
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-dark-900 px-4 py-2.5 text-sm font-medium text-gray-300 hover:text-white hover:border-white/20 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Eye className="w-4 h-4" />
          Send Test Message
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Distribution Settings Sub-Component
// ============================================================

function DistributionSettings({
  sessions,
  targetLists,
  selectedList,
  setSelectedList,
  targetIds,
  setTargetIds,
  selectedSessionIds,
  setSelectedSessionIds,
  delayMin,
  setDelayMin,
  delayMax,
  setDelayMax,
  msgsPerSession,
  setMsgsPerSession,
  targetMode,
  setTargetMode,
}) {
  const [showSessionDropdown, setShowSessionDropdown] = useState(false);
  const dropdownRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowSessionDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const toggleSession = (id) => {
    setSelectedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAllSessions = () => {
    const activeSessions = sessions.filter((s) => s.status?.toLowerCase() === 'active');
    if (selectedSessionIds.size === activeSessions.length) {
      setSelectedSessionIds(new Set());
    } else {
      setSelectedSessionIds(new Set(activeSessions.map((s) => s.id)));
    }
  };

  const activeSessions = sessions.filter((s) => s.status?.toLowerCase() === 'active');

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
      <h3 className="mb-4 text-sm font-semibold text-white flex items-center gap-2">
        <Settings className="w-4 h-4 text-primary-500" />
        Distribution Settings
      </h3>

      <div className="space-y-5">
        {/* Target Mode Toggle */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-300">Target Selection</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTargetMode('list')}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                targetMode === 'list'
                  ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
                  : 'border-white/10 bg-dark-900 text-gray-400 hover:border-white/20'
              }`}
            >
              <UserGroupIcon className="w-3.5 h-3.5" />
              From List
            </button>
            <button
              type="button"
              onClick={() => setTargetMode('manual')}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                targetMode === 'manual'
                  ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
                  : 'border-white/10 bg-dark-900 text-gray-400 hover:border-white/20'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              Manual IDs
            </button>
          </div>
        </div>

        {/* Target List or Manual IDs */}
        {targetMode === 'list' ? (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-gray-500" />
              Target List
            </label>
            <select
              value={selectedList}
              onChange={(e) => setSelectedList(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-dark-900 py-2.5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition"
            >
              <option value="">Select a target list...</option>
              {targetLists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name} ({formatNumber(list.itemsCount || list.count || 0)} users)
                </option>
              ))}
            </select>
            {targetLists.length === 0 && (
              <p className="mt-1 text-xs text-amber-400">
                No lists available. Import or scrape users first.
              </p>
            )}
          </div>
        ) : (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-gray-500" />
              User IDs (comma-separated)
            </label>
            <textarea
              value={targetIds}
              onChange={(e) => setTargetIds(e.target.value)}
              placeholder="12345678, 87654321, 11223344..."
              rows={3}
              className="w-full rounded-lg border border-white/10 bg-dark-900 py-2.5 px-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition resize-y font-mono"
            />
            {targetIds.trim() && (
              <p className="mt-1 text-xs text-gray-500">
                {targetIds.split(',').filter((id) => id.trim()).length} user ID(s) entered
              </p>
            )}
          </div>
        )}

        {/* Session Multi-Select */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-300 flex items-center gap-1.5">
            <PaperClipIcon className="w-3.5 h-3.5 text-gray-500" />
            Sessions ({selectedSessionIds.size} selected)
          </label>
          <div ref={dropdownRef} className="relative">
            <button
              type="button"
              onClick={() => setShowSessionDropdown(!showSessionDropdown)}
              className="w-full flex items-center justify-between rounded-lg border border-white/10 bg-dark-900 py-2.5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition"
            >
              <span className="truncate">
                {selectedSessionIds.size === 0
                  ? 'Select sessions...'
                  : selectedSessionIds.size === activeSessions.length
                  ? 'All active sessions'
                  : `${selectedSessionIds.size} session(s) selected`}
              </span>
              <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${showSessionDropdown ? 'rotate-180' : ''}`} />
            </button>

            {showSessionDropdown && (
              <div className="absolute z-20 mt-1 w-full rounded-lg border border-white/10 bg-dark-900 shadow-xl max-h-48 overflow-y-auto">
                {/* Select All */}
                <label className="flex items-center gap-2 px-3 py-2 border-b border-white/5 cursor-pointer hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={selectedSessionIds.size === activeSessions.length && activeSessions.length > 0}
                    onChange={toggleAllSessions}
                    className="rounded border-white/20 bg-dark-800 text-primary-600 focus:ring-primary-500/50 focus:ring-offset-0"
                  />
                  <span className="text-sm text-white font-medium">Select All Active</span>
                </label>
                {activeSessions.map((session) => (
                  <label
                    key={session.id}
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/5 transition"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSessionIds.has(session.id)}
                      onChange={() => toggleSession(session.id)}
                      className="rounded border-white/20 bg-dark-800 text-primary-600 focus:ring-primary-500/50 focus:ring-offset-0"
                    />
                    <span className="text-sm text-gray-300 truncate">
                      {session.phone} {session.username ? `(@${session.username})` : ''}
                    </span>
                  </label>
                ))}
                {activeSessions.length === 0 && (
                  <p className="px-3 py-3 text-sm text-gray-500 text-center">
                    No active sessions available
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Delay Settings */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-300 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-gray-500" />
            Delay Between Messages (seconds)
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Min Delay</label>
              <input
                type="number"
                min={1}
                max={10}
                value={delayMin}
                onChange={(e) => {
                  const val = Math.min(10, Math.max(1, Number(e.target.value)));
                  setDelayMin(val);
                  if (val > delayMax) setDelayMax(val);
                }}
                className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Max Delay</label>
              <input
                type="number"
                min={1}
                max={10}
                value={delayMax}
                onChange={(e) => {
                  const val = Math.min(10, Math.max(1, Number(e.target.value)));
                  setDelayMax(val);
                  if (val < delayMin) setDelayMin(val);
                }}
                className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition"
              />
            </div>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            value={delayMin}
            onChange={(e) => {
              const val = Number(e.target.value);
              setDelayMin(val);
              if (val > delayMax) setDelayMax(val);
            }}
            className="w-full mt-2 accent-primary-500"
          />
          <input
            type="range"
            min={1}
            max={10}
            value={delayMax}
            onChange={(e) => {
              const val = Number(e.target.value);
              setDelayMax(val);
              if (val < delayMin) setDelayMin(val);
            }}
            className="w-full accent-primary-500"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>1s</span>
            <span>10s</span>
          </div>
        </div>

        {/* Messages Per Session */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-300">
            Messages Per Session Limit
          </label>
          <input
            type="number"
            min={1}
            value={msgsPerSession}
            onChange={(e) => setMsgsPerSession(Math.max(1, Number(e.target.value)))}
            placeholder="Unlimited"
            className="w-full rounded-lg border border-white/10 bg-dark-900 py-2.5 px-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition"
          />
          <p className="mt-1 text-xs text-gray-500">
            Leave empty for no limit. Each session will send at most this many messages.
          </p>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Distribution Visualization Sub-Component
// ============================================================

function DistributionVisualization({ selectedSessionIds, sessions, targetCount }) {
  if (selectedSessionIds.size === 0 || targetCount === 0) {
    return (
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
        <h3 className="mb-3 text-sm font-semibold text-white flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-primary-500" />
          Distribution Preview
        </h3>
        <div className="flex items-center justify-center py-8 text-gray-500">
          <p className="text-sm">Select sessions and targets to see distribution</p>
        </div>
      </div>
    );
  }

  const numSessions = selectedSessionIds.size;
  const perSession = Math.floor(targetCount / numSessions);
  const remainder = targetCount % numSessions;

  const selectedSessions = sessions.filter((s) => selectedSessionIds.has(s.id));

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
      <h3 className="mb-3 text-sm font-semibold text-white flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-primary-500" />
        Distribution Preview
      </h3>

      <p className="text-xs text-gray-400 mb-3">
        {formatNumber(targetCount)} targets split across {numSessions} session(s) &mdash; ~{formatNumber(perSession)} per session
      </p>

      {/* Stacked Bar */}
      <div className="w-full h-6 rounded-full overflow-hidden flex bg-dark-900 mb-4">
        {selectedSessions.map((session, index) => {
          const count = perSession + (index < remainder ? 1 : 0);
          const width = (count / targetCount) * 100;
          const colors = [
            'bg-blue-500', 'bg-emerald-500', 'bg-amber-500', 'bg-purple-500',
            'bg-pink-500', 'bg-cyan-500', 'bg-orange-500', 'bg-indigo-500',
            'bg-teal-500', 'bg-rose-500',
          ];
          const color = colors[index % colors.length];
          return (
            <div
              key={session.id}
              className={`${color} transition-all duration-300 relative group`}
              style={{ width: `${width}%` }}
              title={`${session.phone}: ${count} targets`}
            >
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="text-[10px] font-bold text-white drop-shadow">
                  {count}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {selectedSessions.map((session, index) => {
          const count = perSession + (index < remainder ? 1 : 0);
          const colors = [
            'bg-blue-500', 'bg-emerald-500', 'bg-amber-500', 'bg-purple-500',
            'bg-pink-500', 'bg-cyan-500', 'bg-orange-500', 'bg-indigo-500',
            'bg-teal-500', 'bg-rose-500',
          ];
          const color = colors[index % colors.length];
          return (
            <div key={session.id} className="flex items-center gap-1.5">
              <div className={`w-2.5 h-2.5 rounded-full ${color}`} />
              <span className="text-xs text-gray-400 truncate">
                {session.phone}
              </span>
              <span className="text-xs text-gray-500 ml-auto font-mono">
                {formatNumber(count)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Test Message Preview Modal
// ============================================================

function TestPreviewModal({ isOpen, onClose, message, format, mediaFile, sessions, onSendTest }) {
  const [sending, setSending] = useState(false);

  const handleSendTest = async () => {
    setSending(true);
    try {
      // Use the first active session for the test
      if (!sessions || sessions.length === 0) {
        throw new Error('No sessions available');
      }
      const sessionId = sessions[0].id;
      // You need to specify a target user ID for the test
      await onSendTest(sessionId);
      onClose();
    } catch (err) {
      // Error handled by caller
    } finally {
      setSending(false);
    }
  };

  const formatLabel = { text: 'Plain Text', html: 'HTML', markdown: 'Markdown' };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Test Message Preview" size="lg">
      <div className="space-y-4">
        <div className="rounded-lg border border-white/5 bg-dark-900 p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Format</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-primary-500/15 text-primary-400">
              {formatLabel[format] || format}
            </span>
          </div>
          <div className="rounded-lg bg-dark-800 p-3 text-sm text-white whitespace-pre-wrap min-h-[80px]">
            {message || <span className="text-gray-600">No message content</span>}
          </div>
          {mediaFile && (
            <div className="mt-3 flex items-center gap-2 text-xs text-gray-400">
              <Paperclip className="w-3 h-3" />
              Attachment: {mediaFile.name}
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-white/10 bg-dark-900 px-4 py-2.5 text-sm font-medium text-gray-300 hover:text-white hover:border-white/20 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSendTest}
            disabled={sending || !message.trim()}
            className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-500 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Send Test
              </>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================
// Active Jobs Panel
// ============================================================

function ActiveJobsPanel({ jobs, onCancel }) {
  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-white/5 bg-dark-800 p-6 flex flex-col items-center justify-center min-h-[160px]">
        <MessageSquare className="w-10 h-10 text-gray-600 mb-3" />
        <p className="text-gray-400 font-medium">No active messaging jobs</p>
        <p className="text-gray-500 text-sm mt-1">Start a bulk send to see progress here</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
      <h3 className="mb-4 text-sm font-semibold text-white flex items-center gap-2">
        <Send className="w-4 h-4 text-primary-500" />
        Active Jobs ({jobs.length})
      </h3>
      <div className="space-y-4">
        {jobs.map((job) => {
          const total = job.total_targets || 0;
          const sent = job.sent || 0;
          const failed = job.failed || 0;
          const skipped = job.skipped || 0;
          const progress = total > 0 ? ((sent + failed + skipped) / total) * 100 : 0;

          const sessionProgress = job.session_progress || [];

          return (
            <div
              key={job.id}
              className="rounded-lg border border-white/5 bg-dark-900 p-4 space-y-3"
            >
              {/* Job Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StatusBadge status={job.status || 'running'} size="sm" />
                  <span className="text-sm text-white font-mono">#{job.id}</span>
                </div>
                {(job.status === 'running' || job.status === 'queued' || job.status === 'pending') && (
                  <button
                    onClick={() => onCancel(job.id)}
                    className="flex items-center gap-1 rounded-lg bg-red-500/10 border border-red-500/20 px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-500/20 transition"
                  >
                    <StopCircle className="w-3 h-3" />
                    Cancel
                  </button>
                )}
              </div>

              {/* Overall Progress */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-gray-400">Overall Progress</span>
                  <span className="text-xs font-medium text-white">
                    {formatNumber(sent)} / {formatNumber(total)}
                  </span>
                </div>
                <div className="w-full bg-dark-800 rounded-full h-2 overflow-hidden">
                  <div
                    className="h-2 rounded-full bg-primary-600 transition-all duration-500 ease-out"
                    style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                  />
                </div>
              </div>

              {/* Stats Row */}
              <div className="flex items-center gap-4 text-xs text-gray-400">
                <span className="flex items-center gap-1 text-green-400">
                  <CheckCircle className="w-3 h-3" />
                  {formatNumber(sent)} sent
                </span>
                <span className="flex items-center gap-1 text-red-400">
                  <AlertTriangle className="w-3 h-3" />
                  {formatNumber(failed)} failed
                </span>
                <span className="flex items-center gap-1 text-gray-400">
                  <Clock className="w-3 h-3" />
                  {formatNumber(skipped)} skipped
                </span>
              </div>

              {/* Per-Session Progress Bars */}
              {sessionProgress.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">Per-Session</p>
                  {sessionProgress.map((sp) => {
                    const spTotal = sp.total || 0;
                    const spSent = sp.sent || 0;
                    const spProgress = spTotal > 0 ? (spSent / spTotal) * 100 : 0;
                    return (
                      <div key={sp.session_id} className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 w-20 truncate" title={sp.session_name}>
                          {sp.session_name || sp.session_id}
                        </span>
                        <div className="flex-1 bg-dark-800 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="h-1.5 rounded-full bg-emerald-500 transition-all duration-500"
                            style={{ width: `${Math.min(100, Math.max(0, spProgress))}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500 w-16 text-right">
                          {spSent}/{spTotal}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Main Messaging Page
// ============================================================

export default function Messaging() {
  const { success: showSuccess, error: showError } = useToast();
  const { connect, on, off, connected } = useWebSocket();

  const [activeTab, setActiveTab] = useState('users'); // 'users' or 'groups'

  // Composer state
  const [message, setMessage] = useState('');
  const [format, setFormat] = useState('text');
  const [mediaFile, setMediaFile] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Distribution state
  const [targetMode, setTargetMode] = useState('list');
  const [selectedList, setSelectedList] = useState('');
  const [targetIds, setTargetIds] = useState('');
  const [selectedSessionIds, setSelectedSessionIds] = useState(new Set());
  const [delayMin, setDelayMin] = useState(2);
  const [delayMax, setDelayMax] = useState(5);
  const [msgsPerSession, setMsgsPerSession] = useState('');

  // Data state
  const [sessions, setSessions] = useState([]);
  const [targetLists, setTargetLists] = useState([]);
  const [activeJobs, setActiveJobs] = useState([]);
  const [historyJobs, setHistoryJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submittingTest, setSubmittingTest] = useState(false);

  // Pagination & filters
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    try {
      const response = await listSessions({ limit: 100 });
      setSessions(response.data.data?.sessions || []);
    } catch (err) {
      console.warn('Failed to fetch sessions:', parseApiError(err));
    }
  }, []);

  // Fetch target lists
  const fetchLists = useCallback(async () => {
    try {
      const response = await listsAPI.list({ limit: 50 });
      setTargetLists(response.data.data?.lists || []);
    } catch (err) {
      console.warn('Failed to fetch lists:', parseApiError(err));
    }
  }, []);

  // Fetch active jobs
  const fetchActiveJobs = useCallback(async () => {
    try {
      const response = await getJobs({ status: 'running', limit: 20 });
      setActiveJobs(response.data.data?.jobs || []);
    } catch (err) {
      console.warn('Failed to fetch active jobs:', parseApiError(err));
    }
  }, []);

  // Fetch history - use jobs API for job-level history
  const fetchHistory = useCallback(async () => {
    try {
      const response = await getJobs({
        page: currentPage,
        limit: pageSize,
        status: statusFilter !== 'all' && statusFilter !== 'error' ? statusFilter : undefined,
      });
      setHistoryJobs(response.data.data?.jobs || []);
    } catch (err) {
      console.warn('Failed to fetch history:', parseApiError(err));
    } finally {
      setLoading(false);
    }
  }, [currentPage, searchTerm, statusFilter]);

  useEffect(() => {
    fetchSessions();
    fetchLists();
    fetchActiveJobs();
    fetchHistory();
  }, [fetchSessions, fetchLists, fetchActiveJobs, fetchHistory]);

  // WebSocket connection for live progress
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      connect(token);
    }
    // Note: Event listeners are registered in the next useEffect
    // Cleanup is handled there as well
  }, [connect]);

  // WebSocket event handlers
  useEffect(() => {
    const handleProgress = (data) => {
      setActiveJobs((prev) =>
        prev.map((job) =>
          job.id === data.job_id
            ? { ...job, ...data, status: data.status || job.status }
            : job
        )
      );
    };

    const handleCompleted = (data) => {
      setActiveJobs((prev) => prev.filter((job) => job.id !== data.job_id));
      showSuccess(`Messaging job ${data.job_id} completed. ${data.sent} sent, ${data.failed || 0} failed.`, 'Job Complete');
      fetchHistory();
    };

    const handleError = (data) => {
      setActiveJobs((prev) =>
        prev.map((job) =>
          job.id === data.job_id ? { ...job, status: 'error' } : job
        )
      );
      showError(`Messaging job ${data.job_id} failed: ${data.error || 'Unknown error'}`, 'Job Error');
    };

    const handleSessionProgress = (data) => {
      setActiveJobs((prev) =>
        prev.map((job) => {
          if (job.id === data.job_id) {
            const updated = { ...job };
            const sessionProgress = [...(updated.session_progress || [])];
            const idx = sessionProgress.findIndex((sp) => sp.session_id === data.session_id);
            if (idx >= 0) {
              sessionProgress[idx] = { ...sessionProgress[idx], ...data };
            } else {
              sessionProgress.push(data);
            }
            updated.session_progress = sessionProgress;
            return updated;
          }
          return job;
        })
      );
    };

    on('message_progress', handleProgress);
    on('message_completed', handleCompleted);
    on('message_error', handleError);
    on('session_progress', handleSessionProgress);

    return () => {
      off('message_progress', handleProgress);
      off('message_completed', handleCompleted);
      off('message_error', handleError);
      off('session_progress', handleSessionProgress);
    };
  }, [on, off, showSuccess, showError, fetchHistory]);

  // Compute target count for distribution visualization
  const getTargetCount = () => {
    if (targetMode === 'list' && selectedList) {
      const list = targetLists.find((l) => String(l.id) === String(selectedList));
      return list?.itemsCount || list?.count || 0;
    }
    if (targetMode === 'manual' && targetIds.trim()) {
      return targetIds.split(',').filter((id) => id.trim()).length;
    }
    return 0;
  };

  // --- Actions ---
  const handleBulkSend = async () => {
    // Validation
    if (!message.trim()) {
      showError('Please enter a message.', 'Validation Error');
      return;
    }
    if (message.length > 4096) {
      showError('Message exceeds maximum length.', 'Validation Error');
      return;
    }
    if (selectedSessionIds.size === 0) {
      showError('Please select at least one session.', 'Validation Error');
      return;
    }
    if (targetMode === 'list' && !selectedList) {
      showError('Please select a target list.', 'Validation Error');
      return;
    }
    if (targetMode === 'manual' && !targetIds.trim()) {
      showError('Please enter target user IDs.', 'Validation Error');
      return;
    }

    setSubmitting(true);
    const minLoadingTime = 3000;
    const startTime = Date.now();

    try {
      const payload = {
        message,
        messageType: format,
        sessionIds: Array.from(selectedSessionIds),
        delayMin,
        delayMax,
        async: false,
      };

      if (targetMode === 'list') {
        // Fetch the actual user list items to send as targetList
        const listResponse = await listsAPI.getItems(selectedList, { limit: 10000 });
        const users = (listResponse.data.data?.items || []).map((item) => ({
          telegram_id: item.telegram_id || item.telegramId,
          username: item.username,
          first_name: item.first_name || item.firstName,
          last_name: item.last_name || item.lastName,
          phone: item.phone,
        }));

        if (users.length === 0) {
          showError('The selected list has no users. Please import or scrape users first.', 'Empty List');
          return;
        }

        payload.targetList = users;
        payload.sourceType = 'list';
        payload.sourceId = parseInt(selectedList, 10);
      } else {
        // Manual user IDs - create simple target objects
        const userIds = targetIds
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        payload.targetList = userIds;
        payload.sourceType = 'manual';
      }

      if (msgsPerSession) {
        payload.messagesPerSession = Number(msgsPerSession);
      }

      if (mediaFile) {
        console.warn('Media attachment selected but not yet supported in bulk messaging');
      }

      const response = await sendBulk(payload);
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, minLoadingTime - elapsed);
      await new Promise(resolve => setTimeout(resolve, remaining));

      const result = response.data.data;
      const sent = result.results?.sent || 0;
      const failed = result.results?.failed || 0;
      const total = result.totalTargets || 0;

      if (failed === 0) {
        showSuccess(`All ${sent} message(s) sent successfully to ${total} target(s).`, 'Send Complete');
      } else if (sent > 0) {
        showSuccess(`${sent} sent, ${failed} failed out of ${total} target(s). Partial success.`, 'Partial Success');
      } else {
        showError(`All ${failed} message(s) failed. Check logs for details.`, 'Send Failed');
      }

      fetchActiveJobs();
      fetchHistory();

      // Reset form
      setMessage('');
      setMediaFile(null);
      setSelectedSessionIds(new Set());
      setSelectedList('');
      setTargetIds('');
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, minLoadingTime - elapsed);
      await new Promise(resolve => setTimeout(resolve, remaining));
      showError(parseApiError(err), 'Send Failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePreview = async () => {
    if (!message.trim()) {
      showError('Please enter a message to preview.', 'Validation Error');
      return;
    }
    if (sessions.length === 0) {
      showError('No sessions available for preview.', 'No Sessions');
      return;
    }
    setPreviewOpen(true);
  };

  const handleSendTest = async (sessionId) => {
    setSubmittingTest(true);
    try {
      // Use the first active session and a test target
      // The user should have their own account as a test target
      // We'll use the session owner's account ID if available
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) {
        showError('Session not found.', 'Error');
        return;
      }
      // Preview requires a targetId - use a default or ask user
      // For now, we'll skip actual send and just validate formatting
      await previewMessage({
        sessionId,
        targetId: session.phone || sessionId, // Use session phone as target or session ID
        message,
      });
      showSuccess('Test message sent successfully.', 'Preview');
    } catch (err) {
      showError(parseApiError(err), 'Preview Failed');
    } finally {
      setSubmittingTest(false);
    }
  };

  const handleCancelJob = async (jobId) => {
    try {
      await cancelJob(jobId);
      showSuccess(`Job ${jobId} cancelled.`, 'Cancelled');
      setActiveJobs((prev) => prev.filter((job) => job.id !== jobId));
    } catch (err) {
      showError(parseApiError(err), 'Cancel Failed');
    }
  };

  // Pagination for history
  const filteredHistory = historyJobs.filter((j) => {
    const matchesSearch =
      !searchTerm ||
      (j.id && String(j.id).toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesStatus =
      statusFilter === 'all' || j.status?.toLowerCase() === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const totalPages = Math.ceil(filteredHistory.length / pageSize);
  const paginatedHistory = filteredHistory.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    if (totalPages <= maxVisible + 2) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (currentPage > 3) pages.push('...');
      const start = Math.max(2, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (currentPage < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    return pages;
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Messaging</h1>
          <p className="mt-1 text-sm text-gray-400">
            {activeTab === 'users' 
              ? 'Compose and send messages to target users across multiple sessions'
              : 'Send messages to multiple groups/channels with rate limiting'}
          </p>
        </div>
        {connected && (
          <div className="flex items-center gap-1.5 text-xs text-green-400">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            Live updates connected
          </div>
        )}
      </div>

      {/* Tab Navigation */}
      <div className="rounded-xl border border-white/5 bg-dark-800 overflow-hidden">
        <div className="flex border-b border-white/5">
          <button
            onClick={() => setActiveTab('users')}
            className={`flex-1 px-5 py-3 text-sm font-medium transition flex items-center justify-center gap-2 ${
              activeTab === 'users'
                ? 'border-b-2 border-primary-500 text-primary-400 bg-primary-500/5'
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <Users className="w-4 h-4" />
            Users
          </button>
          <button
            onClick={() => setActiveTab('groups')}
            className={`flex-1 px-5 py-3 text-sm font-medium transition flex items-center justify-center gap-2 ${
              activeTab === 'groups'
                ? 'border-b-2 border-primary-500 text-primary-400 bg-primary-500/5'
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <Group className="w-4 h-4" />
            Groups
          </button>
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'users' ? (
        <>

      {/* Composer + Settings Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Left: Message Composer */}
        <MessageComposer
          message={message}
          format={format}
          sessions={sessions}
          setMessage={setMessage}
          setFormat={setFormat}
          mediaFile={mediaFile}
          setMediaFile={setMediaFile}
          onPreview={handlePreview}
        />

        {/* Right: Distribution Settings */}
        <DistributionSettings
          sessions={sessions}
          targetLists={targetLists}
          selectedList={selectedList}
          setSelectedList={setSelectedList}
          targetIds={targetIds}
          setTargetIds={setTargetIds}
          selectedSessionIds={selectedSessionIds}
          setSelectedSessionIds={setSelectedSessionIds}
          delayMin={delayMin}
          setDelayMin={setDelayMin}
          delayMax={delayMax}
          setDelayMax={setDelayMax}
          msgsPerSession={msgsPerSession}
          setMsgsPerSession={setMsgsPerSession}
          targetMode={targetMode}
          setTargetMode={setTargetMode}
        />
      </div>

      {/* Distribution Visualization + Send Button */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Distribution Bar */}
        <div className="lg:col-span-2">
          <DistributionVisualization
            selectedSessionIds={selectedSessionIds}
            sessions={sessions}
            targetCount={getTargetCount()}
          />
        </div>

        {/* Send Bulk Button */}
        <div className="rounded-xl border border-white/5 bg-dark-800 p-5 flex flex-col items-center justify-center">
          <div className="text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-primary-500/10 flex items-center justify-center mx-auto">
              <Send className="w-6 h-6 text-primary-500" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Ready to Send</p>
              <p className="text-xs text-gray-500 mt-1">
                {selectedSessionIds.size} session(s) &middot; {formatNumber(getTargetCount())} target(s)
              </p>
            </div>
            <button
              onClick={handleBulkSend}
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
                  Send Bulk Messages
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Active Jobs */}
      <ActiveJobsPanel jobs={activeJobs} onCancel={handleCancelJob} />

      {/* Message History */}
      <div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-4">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary-500" />
            Message History
          </h3>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(1);
                }}
                placeholder="Search by job ID..."
                className="w-full sm:w-64 pl-10 pr-4 py-2 bg-dark-900 border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition"
              />
            </div>
            <div className="flex items-center gap-2">
              {['all', 'running', 'completed', 'failed', 'cancelled'].map((status) => (
                <button
                  key={status}
                  onClick={() => {
                    setStatusFilter(status);
                    setCurrentPage(1);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                    statusFilter === status
                      ? 'bg-primary-500/15 border-primary-500/30 text-primary-400'
                      : 'bg-dark-900 border-white/10 text-gray-400 hover:text-white hover:border-white/20'
                  }`}
                >
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* History Table */}
        <div className="rounded-xl border border-white/5 bg-dark-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Job ID
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Message
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Source
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Targets
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Sent / Failed / Skipped
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Progress
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Date
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {loading ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-16">
                      <div className="flex flex-col items-center justify-center">
                        <Loader2 className="w-8 h-8 text-primary-500 animate-spin mb-3" />
                        <p className="text-gray-400 text-sm">Loading message history...</p>
                      </div>
                    </td>
                  </tr>
                ) : paginatedHistory.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-16">
                      <div className="flex flex-col items-center justify-center">
                        <div className="w-12 h-12 rounded-full bg-dark-900 flex items-center justify-center mb-3">
                          <MessageSquare className="w-5 h-5 text-gray-600" />
                        </div>
                        <p className="text-gray-400 font-medium">No messaging jobs found</p>
                        <p className="text-gray-500 text-sm mt-1">
                          Send a bulk message to see it here
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  paginatedHistory.map((job) => {
                    const total = job.totalCount || 0;
                    const sent = job.sentCount || 0;
                    const failed = job.failedCount || 0;
                    const skipped = job.skippedCount || 0;
                    const progress = total > 0 ? ((sent + failed + skipped) / total) * 100 : 0;
                    const isActive =
                      job.status === 'running' ||
                      job.status === 'queued' ||
                      job.status === 'pending';

                    return (
                      <tr key={job.id} className="transition-colors hover:bg-white/[0.02]">
                        <td className="px-4 py-3">
                          <span className="text-sm font-mono text-gray-400">
                            #{job.id}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="max-w-48">
                            <p className="text-sm text-white truncate" title={job.messageContent || ''}>
                              {job.messageContent ? (job.messageContent.length > 50 ? job.messageContent.substring(0, 50) + '...' : job.messageContent) : '(media only)'}
                            </p>
                            <p className="text-xs text-gray-500">{job.messageType || 'text'}</p>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div>
                            {job.options?.sourceType === 'list' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-purple-500/10 text-purple-400 border border-purple-500/20">
                                <List className="w-3 h-3" />
                                List #{job.options?.sourceId || '?'}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                <Users className="w-3 h-3" />
                                Manual
                              </span>
                            )}
                            <p className="text-xs text-gray-500 mt-0.5">{formatNumber(total)} targets</p>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 text-sm">
                            <span className="text-green-400 font-medium">{formatNumber(sent)}</span>
                            <span className="text-gray-600">/</span>
                            <span className="text-red-400 font-medium">{formatNumber(failed)}</span>
                            <span className="text-gray-600">/</span>
                            <span className="text-gray-400">{formatNumber(skipped)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={job.status || 'pending'} size="sm" />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 min-w-[120px]">
                            <div className="flex-1 bg-dark-900 rounded-full h-1.5 overflow-hidden">
                              <div
                                className={`h-1.5 rounded-full transition-all duration-500 ${
                                  job.status === 'error' || job.status === 'failed'
                                    ? 'bg-red-500'
                                    : job.status === 'completed'
                                    ? 'bg-green-500'
                                    : 'bg-primary-600'
                                }`}
                                style={{
                                  width: `${Math.min(100, Math.max(0, progress))}%`,
                                }}
                              />
                            </div>
                            <span className="text-xs text-gray-400 w-10 text-right">
                              {Math.round(progress)}%
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-sm text-gray-400">
                            {job.created_at ? formatDateTime(job.created_at) : 'N/A'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              className="p-1.5 rounded-lg text-gray-400 hover:text-primary-400 hover:bg-primary-500/10 transition"
                              title="View Details"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            {isActive && (
                              <button
                                onClick={() => handleCancelJob(job.id)}
                                className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition"
                                title="Cancel"
                              >
                                <StopCircle className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer */}
          {!loading && totalPages > 1 && (
            <div className="px-4 py-3 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-3">
              <p className="text-sm text-gray-400">
                Showing{' '}
                <span className="text-gray-200 font-medium">
                  {(currentPage - 1) * pageSize + 1}
                </span>{' '}
                to{' '}
                <span className="text-gray-200 font-medium">
                  {Math.min(currentPage * pageSize, filteredHistory.length)}
                </span>{' '}
                of{' '}
                <span className="text-gray-200 font-medium">
                  {filteredHistory.length}
                </span>{' '}
                results
              </p>
              <nav className="flex items-center gap-1" aria-label="Pagination">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                {getPageNumbers().map((page, i) =>
                  typeof page === 'number' ? (
                    <button
                      key={i}
                      onClick={() => setCurrentPage(page)}
                      className={`min-w-[2rem] h-8 rounded-lg text-sm font-medium transition ${
                        page === currentPage
                          ? 'bg-primary-600 text-white'
                          : 'text-gray-400 hover:text-white hover:bg-white/5'
                      }`}
                      aria-current={page === currentPage ? 'page' : undefined}
                    >
                      {page}
                    </button>
                  ) : (
                    <span key={i} className="px-1 text-gray-500 text-sm">
                      ...
                    </span>
                  )
                )}
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition"
                  aria-label="Next page"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </nav>
            </div>
          )}
        </div>
      </div>

      {/* Test Preview Modal */}
      <TestPreviewModal
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        message={message}
        format={format}
        mediaFile={mediaFile}
        sessions={sessions}
        onSendTest={handleSendTest}
      />
        </>
      ) : (
        <MessageGroupsTab />
      )}
    </div>
  );
}
