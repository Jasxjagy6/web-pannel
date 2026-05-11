import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { listSessions } from '../api/sessions';
import { groupsAPI } from '../api/groups';
import { listsAPI } from '../api/lists';
import { parseApiError, formatNumber, formatRelativeTime, formatDateTime } from '../utils/formatters';
import { useToast } from '../components/common/Toast';
import { Modal } from '../components/common/Modal';
import StatusBadge from '../components/common/StatusBadge';
import SessionListSwitcher from '../components/common/SessionListSwitcher';
import DistributionControls from '../components/common/DistributionControls';
import DistributionPreview from '../components/common/DistributionPreview';
import {
  Loader2,
  X,
  Eye,
  StopCircle,
  Users,
  Settings,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  CheckCircle,
  Clock,
  UserPlus,
  Search,
  Link,
  Hash,
  ListFilter,
  AlertCircle,
  Info,
  Group,
  Radio,
  Check,
  LogIn,
  LogOut,
  Edit3,
} from 'lucide-react';
import {
  UserGroupIcon,
  PaperClipIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';

// ============================================================
// Join/Leave Form Sub-Component
// ============================================================

function JoinLeaveForm({ sessions, onSubmit, submitting }) {
  const [mode, setMode] = useState('join'); // 'join' or 'leave'
  const [targetIds, setTargetIds] = useState('');
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
  const [sessionPickMode, setSessionPickMode] = useState('sessions');
  const [selectedSessionListId, setSelectedSessionListId] = useState('');
  const [errors, setErrors] = useState({});
  const [showAllSessions, setShowAllSessions] = useState(false);

  const validate = () => {
    const newErrors = {};
    if (!targetIds.trim()) newErrors.targetIds = 'Please enter at least one group/channel.';
    if (sessionPickMode === 'list') {
      if (!selectedSessionListId) newErrors.session = 'Please pick a session list.';
    } else if (selectedSessionIds.length === 0) {
      newErrors.session = 'Please select at least one session (or pick a session list).';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;

    const targets = targetIds
      .split('\n')
      .map(t => t.trim())
      .filter(t => t.length > 0);

    const payload = { mode, targetIds: targets };
    if (sessionPickMode === 'list' && selectedSessionListId) {
      payload.sessionListId = Number(selectedSessionListId);
    } else {
      payload.sessionIds = selectedSessionIds;
    }
    onSubmit(payload);

    // Reset
    setTargetIds('');
    setSelectedSessionIds([]);
    setSelectedSessionListId('');
    setErrors({});
  };

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

  const inputBase = 'w-full rounded-lg border bg-dark-900 py-2.5 px-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition';
  const inputError = 'border-red-500/50';
  const inputNormal = 'border-white/10';
  const labelClass = 'mb-1.5 block text-sm font-medium text-gray-300';

  const activeSessions = sessions.filter((s) => s.status?.toLowerCase() === 'active' || s.is_logged_in);
  const displayedSessions = showAllSessions ? sessions : activeSessions;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Mode Toggle */}
      <div>
        <label className={labelClass}>
          <span className="flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5 text-gray-500" />
            Action
          </span>
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode('join')}
            className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition flex items-center justify-center gap-2 ${
              mode === 'join'
                ? 'border-green-500/50 bg-green-500/10 text-green-400'
                : 'border-white/10 bg-dark-900 text-gray-400 hover:text-white'
            }`}
          >
            <LogIn className="w-4 h-4" />
            Join
          </button>
          <button
            type="button"
            onClick={() => setMode('leave')}
            className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition flex items-center justify-center gap-2 ${
              mode === 'leave'
                ? 'border-red-500/50 bg-red-500/10 text-red-400'
                : 'border-white/10 bg-dark-900 text-gray-400 hover:text-white'
            }`}
          >
            <LogOut className="w-4 h-4" />
            Leave
          </button>
        </div>
      </div>

      {/* Target IDs */}
      <div>
        <label className={labelClass}>
          <span className="flex items-center gap-1.5">
            <Link className="w-3.5 h-3.5 text-gray-500" />
            Groups/Channels (one per line)
          </span>
        </label>
        <textarea
          value={targetIds}
          onChange={(e) => setTargetIds(e.target.value)}
          placeholder="https://t.me/example_group
or @example_channel
or -1001234567890
(one per line, multiple supported)"
          rows={4}
          className={`${inputBase} ${errors.targetIds ? inputError : inputNormal} resize-none`}
        />
        {errors.targetIds && <p className="mt-1 text-xs text-red-400">{errors.targetIds}</p>}
        <p className="mt-1 text-xs text-gray-500">
          Enter one group/channel link or ID per line. You can join/leave multiple at once.
        </p>
      </div>

      {/* Session source: pick sessions OR pick a saved session list */}
      <SessionListSwitcher
        mode={sessionPickMode}
        onModeChange={setSessionPickMode}
        selectedSessionListId={selectedSessionListId}
        onSelectedSessionListIdChange={setSelectedSessionListId}
      />

      {/* Session Selection (Multi-Select), hidden in list mode */}
      <div className={sessionPickMode === 'list' ? 'hidden' : ''}>
        <label className={labelClass}>
          <span className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5 text-gray-500" />
            Sessions ({selectedSessionIds.length} selected)
          </span>
        </label>

        <div className="flex gap-2 mb-2">
          <button type="button" onClick={selectAllSessions} className="text-xs text-primary-400 hover:text-primary-300">
            Select All Active
          </button>
          <span className="text-xs text-gray-600">|</span>
          <button type="button" onClick={deselectAllSessions} className="text-xs text-gray-400 hover:text-gray-300">
            Deselect All
          </button>
        </div>

        <div className="max-h-36 overflow-y-auto rounded-lg border border-white/10 bg-dark-900 p-2 space-y-1">
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
        {errors.session && <p className="mt-1 text-xs text-red-400">{errors.session}</p>}
        {activeSessions.length === 0 && (
          <p className="mt-1 text-xs text-amber-400">No active sessions. Please login first.</p>
        )}
      </div>
      {errors.session && sessionPickMode === 'list' && (
        <p className="mt-1 text-xs text-red-400">{errors.session}</p>
      )}

      {/* Submit Button */}
      <button
        type="submit"
        disabled={submitting}
        className={`w-full flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-dark-800 disabled:cursor-not-allowed disabled:opacity-60 ${
          mode === 'join'
            ? 'bg-gradient-to-r from-green-600 to-emerald-600 shadow-green-600/25 hover:from-green-500 hover:to-emerald-500 hover:shadow-green-500/30 focus:ring-green-500'
            : 'bg-gradient-to-r from-red-600 to-rose-600 shadow-red-600/25 hover:from-red-500 hover:to-rose-500 hover:shadow-red-500/30 focus:ring-red-500'
        }`}
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Processing...
          </>
        ) : (
          <>
            {mode === 'join' ? <LogIn className="h-4 w-4" /> : <LogOut className="h-4 w-4" />}
            {mode === 'join' ? 'Join All' : 'Leave All'}
          </>
        )}
      </button>
    </form>
  );
}

// ============================================================
// Add Members Form Sub-Component
// ============================================================

function AddMembersForm({ sessions, targetLists, onSubmit, submitting }) {
  // Two ways to feed the worker:
  //   - 'list':   pull items from a saved Lists row (existing flow)
  //   - 'manual': operator pastes user IDs / @usernames directly. Mixed
  //               input is supported; the frontend coerces every line
  //               into `{ telegram_id, username }` before submitting so
  //               the worker uses the same fallback path it already has
  //               for list-sourced rows (id → username; numeric-only
  //               username strings are skipped locally before any
  //               session request goes out, so the run can't burn into
  //               peer-flood for an unreachable handle).
  const [sourceMode, setSourceMode] = useState('list');
  const [sourceList, setSourceList] = useState('');
  const [manualUsers, setManualUsers] = useState('');
  const [targetType, setTargetType] = useState('group'); // 'group' or 'channel'
  const [targetIds, setTargetIds] = useState('');
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
  const [sessionPickMode, setSessionPickMode] = useState('sessions');
  const [selectedSessionListId, setSelectedSessionListId] = useState('');
  const [delayMin, setDelayMin] = useState(30);
  const [delayMax, setDelayMax] = useState(60);
  const [batchSize, setBatchSize] = useState(5);
  const [errors, setErrors] = useState({});
  const [showAllSessions, setShowAllSessions] = useState(false);
  // Distribution-engine state (rotation/cooldown). The shape mirrors
  // the backend distributionPlanner.plan() inputs.
  const [distribution, setDistribution] = useState({ mode: 'auto' });
  const [previewPlan, setPreviewPlan] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const previewSeq = useRef(0);

  // Manual entries: parse on the fly so validation / preview can
  // count what will actually be sent. One token per line; commas
  // inside a line are also accepted so an operator can paste a
  // single CSV row without re-typing it. Each token resolves to:
  //   - `{ telegram_id: <digits> }` when the token is purely numeric
  //   - `{ username: <handle> }`   for everything else (the leading
  //     `@`, if any, is stripped). Numeric-only usernames are NEVER
  //     produced by this parser, which is the same rule the backend
  //     parser uses to skip resolving `@<digits>` (would always fail
  //     and cost session capacity).
  const parsedManualUsers = useMemo(() => {
    if (!manualUsers || !manualUsers.trim()) return [];
    const tokens = manualUsers
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const tok of tokens) {
      const stripped = tok.replace(/^@+/, '').trim();
      if (!stripped) continue;
      if (/^\d+$/.test(stripped)) {
        // Numeric → telegram_id
        if (seen.has(`id:${stripped}`)) continue;
        seen.add(`id:${stripped}`);
        out.push({ telegram_id: stripped, username: null });
      } else {
        // Non-numeric → username. Telegram handles are letters,
        // digits and underscores only; we don't enforce that here
        // because the worker already validates and the operator
        // may want a more permissive paste.
        const lower = stripped.toLowerCase();
        if (seen.has(`u:${lower}`)) continue;
        seen.add(`u:${lower}`);
        out.push({ telegram_id: null, username: stripped });
      }
    }
    return out;
  }, [manualUsers]);

  // Resolve the source-list size so the preview can show realistic
  // per-session burst counts. We re-use whatever the user already
  // selected — no extra API hits unless the size isn't known yet.
  const targetUserCount = useMemo(() => {
    if (sourceMode === 'manual') return parsedManualUsers.length;
    const sel = targetLists.find((l) => String(l.id) === String(sourceList));
    if (!sel) return 0;
    return Number(sel.user_count || sel.userCount || sel.member_count || 0);
  }, [sourceMode, parsedManualUsers, targetLists, sourceList]);

  // Multiplied by however many target groups the operator pasted in.
  const targetCount = useMemo(() => {
    const tg = (targetIds || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean).length;
    return targetUserCount * Math.max(1, tg);
  }, [targetUserCount, targetIds]);

  const previewSessionIds = useMemo(() => {
    if (sessionPickMode === 'list' && selectedSessionListId) {
      // Session-list mode: the backend resolves the list to a session
      // set via `sessionListId`. We pass an empty array here and let
      // the effect below send `sessionListId` instead.
      return [];
    }
    return selectedSessionIds.map((id) => String(id));
  }, [sessionPickMode, selectedSessionListId, selectedSessionIds]);

  const previewSessionListId = useMemo(
    () =>
      sessionPickMode === 'list' && selectedSessionListId
        ? Number(selectedSessionListId)
        : null,
    [sessionPickMode, selectedSessionListId]
  );

  // Debounced dry-run against the preview endpoint whenever the
  // operator changes any input that affects the plan.
  useEffect(() => {
    const seq = ++previewSeq.current;
    // Either explicit session IDs OR a session-list ID must be set;
    // otherwise there's nothing to preview.
    const haveSessionSource =
      previewSessionIds.length > 0 || previewSessionListId != null;
    if (targetCount <= 0 || !haveSessionSource) {
      setPreviewPlan(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    const handle = setTimeout(async () => {
      try {
        const body = {
          targetCount,
          mode: distribution.mode || 'auto',
        };
        if (previewSessionListId != null) {
          body.sessionListId = previewSessionListId;
        } else {
          body.sessionIds = previewSessionIds;
        }
        if (distribution.mode === 'manual') {
          if (distribution.perSessionBurst != null) body.perSessionBurst = distribution.perSessionBurst;
          if (distribution.cooldownSecMin != null) body.cooldownSecMin = distribution.cooldownSecMin;
          if (distribution.cooldownSecMax != null) body.cooldownSecMax = distribution.cooldownSecMax;
          if (distribution.itemDelayMsMin != null) body.itemDelayMsMin = distribution.itemDelayMsMin;
          if (distribution.itemDelayMsMax != null) body.itemDelayMsMax = distribution.itemDelayMsMax;
        }
        const res = await groupsAPI.previewAddMembers(body);
        if (previewSeq.current !== seq) return;
        setPreviewPlan(res?.data?.data?.plan || null);
      } catch (err) {
        if (previewSeq.current !== seq) return;
        setPreviewError(parseApiError(err));
        setPreviewPlan(null);
      } finally {
        if (previewSeq.current === seq) setPreviewLoading(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [targetCount, previewSessionIds, previewSessionListId, distribution]);

  const validate = () => {
    const newErrors = {};
    if (sourceMode === 'list') {
      if (!sourceList) newErrors.sourceList = 'Please select a source list.';
    } else {
      if (parsedManualUsers.length === 0) {
        newErrors.manualUsers = 'Paste at least one user ID or @username.';
      }
    }
    if (!targetIds.trim()) newErrors.targetIds = 'Please enter at least one target.';
    if (sessionPickMode === 'list') {
      if (!selectedSessionListId) newErrors.session = 'Please pick a session list.';
    } else if (selectedSessionIds.length === 0) {
      newErrors.session = 'Please select at least one session (or pick a session list).';
    }
    if (delayMin < 1 || delayMin > 600) newErrors.delayMin = 'Min delay must be between 1 and 600.';
    if (delayMax < 1 || delayMax > 600) newErrors.delayMax = 'Max delay must be between 1 and 600.';
    if (delayMin > delayMax) newErrors.delayMin = 'Min delay cannot exceed max delay.';
    if (batchSize < 1 || batchSize > 100) newErrors.batchSize = 'Batch size must be between 1 and 100.';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;

    const targets = targetIds
      .split('\n')
      .map(t => t.trim())
      .filter(t => t.length > 0);

    const submitPayload = {
      sourceMode,
      sourceList: sourceMode === 'list' ? sourceList : '',
      manualUsers: sourceMode === 'manual' ? parsedManualUsers : null,
      targetIds: targets,
      targetType,
      delayMin: Number(delayMin),
      delayMax: Number(delayMax),
      batchSize: Number(batchSize),
      distribution,
    };
    if (sessionPickMode === 'list' && selectedSessionListId) {
      submitPayload.sessionListId = Number(selectedSessionListId);
    } else {
      submitPayload.sessionIds = selectedSessionIds;
    }
    onSubmit(submitPayload);

    // Reset
    setSourceList('');
    setManualUsers('');
    setTargetIds('');
    setSelectedSessionIds([]);
    setSelectedSessionListId('');
    setDelayMin(30);
    setDelayMax(60);
    setBatchSize(5);
    setDistribution({ mode: 'auto' });
    setErrors({});
  };

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

  const inputBase = 'w-full rounded-lg border bg-dark-900 py-2.5 px-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition';
  const inputError = 'border-red-500/50';
  const inputNormal = 'border-white/10';
  const labelClass = 'mb-1.5 block text-sm font-medium text-gray-300';

  const activeSessions = sessions.filter((s) => s.status?.toLowerCase() === 'active' || s.is_logged_in);
  const displayedSessions = showAllSessions ? sessions : activeSessions;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Source mode picker — choose between a saved list or a
          paste-in-IDs/@usernames input. */}
      <div>
        <label className={labelClass}>
          <span className="flex items-center gap-1.5">
            <ListFilter className="w-3.5 h-3.5 text-gray-500" />
            Source
          </span>
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setSourceMode('list')}
            className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition flex items-center justify-center gap-2 ${
              sourceMode === 'list'
                ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
                : 'border-white/10 bg-dark-900 text-gray-400 hover:text-white'
            }`}
          >
            <ListFilter className="w-4 h-4" />
            From list
          </button>
          <button
            type="button"
            onClick={() => setSourceMode('manual')}
            className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition flex items-center justify-center gap-2 ${
              sourceMode === 'manual'
                ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
                : 'border-white/10 bg-dark-900 text-gray-400 hover:text-white'
            }`}
          >
            <Edit3 className="w-4 h-4" />
            Manual input
          </button>
        </div>
      </div>

      {sourceMode === 'list' ? (
        <div>
          <label className={labelClass}>
            <span className="flex items-center gap-1.5">
              <ListFilter className="w-3.5 h-3.5 text-gray-500" />
              Source List
            </span>
          </label>
          <select
            value={sourceList}
            onChange={(e) => setSourceList(e.target.value)}
            className={`${inputBase} ${errors.sourceList ? inputError : inputNormal}`}
          >
            <option value="">Select a source list...</option>
            {targetLists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name} ({formatNumber(list.itemsCount || list.count || 0)} users)
              </option>
            ))}
          </select>
          {errors.sourceList && <p className="mt-1 text-xs text-red-400">{errors.sourceList}</p>}
          {targetLists.length === 0 && (
            <p className="mt-1 text-xs text-amber-400">No lists available. Import or scrape users first.</p>
          )}
        </div>
      ) : (
        <div>
          <label className={labelClass}>
            <span className="flex items-center gap-1.5">
              <Edit3 className="w-3.5 h-3.5 text-gray-500" />
              Users (one per line; mix IDs and @usernames)
            </span>
          </label>
          <textarea
            value={manualUsers}
            onChange={(e) => setManualUsers(e.target.value)}
            placeholder={"6434893178\n@example_user\n@another_handle\n7000000000"}
            rows={6}
            className={`${inputBase} font-mono text-xs ${errors.manualUsers ? inputError : inputNormal}`}
          />
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-gray-500">
              {parsedManualUsers.length > 0
                ? `${formatNumber(parsedManualUsers.length)} unique user${parsedManualUsers.length === 1 ? '' : 's'} parsed`
                : 'Numeric tokens become user IDs; everything else becomes a @username.'}
            </span>
            {errors.manualUsers && <span className="text-red-400">{errors.manualUsers}</span>}
          </div>
        </div>
      )}

      {/* Target Type */}
      <div>
        <label className={labelClass}>
          <span className="flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5 text-gray-500" />
            Target Type
          </span>
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setTargetType('group')}
            className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition flex items-center justify-center gap-2 ${
              targetType === 'group'
                ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
                : 'border-white/10 bg-dark-900 text-gray-400 hover:text-white'
            }`}
          >
            <Group className="w-4 h-4" />
            Group(s)
          </button>
          <button
            type="button"
            onClick={() => setTargetType('channel')}
            className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition flex items-center justify-center gap-2 ${
              targetType === 'channel'
                ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
                : 'border-white/10 bg-dark-900 text-gray-400 hover:text-white'
            }`}
          >
            <Hash className="w-4 h-4" />
            Channel(s)
          </button>
        </div>
      </div>

      {/* Target IDs */}
      <div>
        <label className={labelClass}>
          <span className="flex items-center gap-1.5">
            <Link className="w-3.5 h-3.5 text-gray-500" />
            Target {targetType === 'group' ? 'Groups' : 'Channels'} (one per line)
          </span>
        </label>
        <textarea
          value={targetIds}
          onChange={(e) => setTargetIds(e.target.value)}
          placeholder={`https://t.me/example_${targetType}\nor -1001234567890\n(one per line, multiple supported)`}
          rows={3}
          className={`${inputBase} ${errors.targetIds ? inputError : inputNormal} resize-none`}
        />
        {errors.targetIds && <p className="mt-1 text-xs text-red-400">{errors.targetIds}</p>}
        <p className="mt-1 text-xs text-gray-500">
          Enter one {targetType} link or ID per line. You can add to multiple {targetType}s at once.
        </p>
      </div>

      {/* Session source: pick sessions OR pick a saved session list */}
      <SessionListSwitcher
        mode={sessionPickMode}
        onModeChange={setSessionPickMode}
        selectedSessionListId={selectedSessionListId}
        onSelectedSessionListIdChange={setSelectedSessionListId}
      />

      {/* Session Selection (Multi-Select), hidden in list mode */}
      <div className={sessionPickMode === 'list' ? 'hidden' : ''}>
        <label className={labelClass}>
          <span className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5 text-gray-500" />
            Sessions ({selectedSessionIds.length} selected)
          </span>
        </label>

        <div className="flex gap-2 mb-2">
          <button type="button" onClick={selectAllSessions} className="text-xs text-primary-400 hover:text-primary-300">
            Select All Active
          </button>
          <span className="text-xs text-gray-600">|</span>
          <button type="button" onClick={deselectAllSessions} className="text-xs text-gray-400 hover:text-gray-300">
            Deselect All
          </button>
        </div>

        <div className="max-h-36 overflow-y-auto rounded-lg border border-white/10 bg-dark-900 p-2 space-y-1">
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
        {errors.session && <p className="mt-1 text-xs text-red-400">{errors.session}</p>}
        {activeSessions.length === 0 && (
          <p className="mt-1 text-xs text-amber-400">No active sessions. Please login first.</p>
        )}
      </div>
      {errors.session && sessionPickMode === 'list' && (
        <p className="mt-1 text-xs text-red-400">{errors.session}</p>
      )}

      {/* Options */}
      <div>
        <label className={labelClass}>
          <span className="flex items-center gap-1.5">
            <Settings className="w-3.5 h-3.5 text-gray-500" />
            Options
          </span>
        </label>
        <div className="space-y-4 rounded-lg border border-white/5 bg-dark-900 p-4">
          {/* Delays */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Min Delay (seconds)</label>
              <input
                type="number"
                min={1}
                max={600}
                value={delayMin}
                onChange={(e) => {
                  const val = Math.min(600, Math.max(1, Number(e.target.value)));
                  setDelayMin(val);
                  if (val > delayMax) setDelayMax(val);
                }}
                className={`${inputBase} ${errors.delayMin ? inputError : inputNormal}`}
              />
              {errors.delayMin && <p className="mt-1 text-xs text-red-400">{errors.delayMin}</p>}
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Max Delay (seconds)</label>
              <input
                type="number"
                min={1}
                max={600}
                value={delayMax}
                onChange={(e) => {
                  const val = Math.min(600, Math.max(1, Number(e.target.value)));
                  setDelayMax(val);
                  if (val < delayMin) setDelayMin(val);
                }}
                className={`${inputBase} ${errors.delayMax ? inputError : inputNormal}`}
              />
              {errors.delayMax && <p className="mt-1 text-xs text-red-400">{errors.delayMax}</p>}
            </div>
          </div>

          {/* Batch Size */}
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Users per Session per Batch</label>
            <input
              type="number"
              min={1}
              max={100}
              value={batchSize}
              onChange={(e) => setBatchSize(Math.min(100, Math.max(1, Number(e.target.value))))}
              className={`${inputBase} ${errors.batchSize ? inputError : inputNormal}`}
            />
            {errors.batchSize && <p className="mt-1 text-xs text-red-400">{errors.batchSize}</p>}
            <p className="mt-1 text-xs text-gray-500">
              Users added per session before waiting for the delay. Lower = safer from bans.
            </p>
          </div>
        </div>
      </div>

      {/* Distribution engine — auto/manual rotation+cooldown */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DistributionControls
          value={distribution}
          onChange={setDistribution}
          workType="group_add"
        />
        <DistributionPreview
          plan={previewPlan}
          loading={previewLoading}
          error={previewError}
          emptyHint="Pick a source list and at least one session to see how the work will rotate across sessions."
        />
      </div>

      {/* Submit Button */}
      <button
        type="submit"
        disabled={submitting}
        className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary-600 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-600/25 transition-all duration-200 hover:from-primary-500 hover:to-blue-500 hover:shadow-primary-500/30 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:ring-offset-2 focus:ring-offset-dark-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Starting...
          </>
        ) : (
          <>
            <UserPlus className="h-4 w-4" />
            Start Adding
          </>
        )}
      </button>
    </form>
  );
}

// ============================================================
// Active Operations Panel
// ============================================================

function ActiveOperationsPanel({ operations, onCancel }) {
  if (operations.length === 0) {
    return (
      <div className="rounded-xl border border-white/5 bg-dark-800 p-6 flex flex-col items-center justify-center min-h-[200px]">
        <UserPlus className="w-10 h-10 text-gray-600 mb-3" />
        <p className="text-gray-400 font-medium">No active operations</p>
        <p className="text-gray-500 text-sm mt-1">Start an add operation to see progress here</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
      <h3 className="mb-4 text-sm font-semibold text-white flex items-center gap-2">
        <UserPlus className="w-4 h-4 text-primary-500" />
        Active Operations ({operations.length})
      </h3>
      <div className="space-y-4">
        {operations.map((op) => {
          const total = op.totalUsers || op.total_count || 0;
          const added = op.successCount || 0;
          const failed = op.failedCount || 0;
          const progress = total > 0 ? ((added + failed) / total) * 100 : 0;

          // Status that the worker emits while the pre-flight is
          // running. Treat them like 'running' for cancel UI purposes
          // and surface a human description so the operator knows
          // exactly what the worker is doing right now.
          const PHASE_LABELS = {
            queued: 'Queued — waiting for a worker',
            // Legacy phase label retained so jobs queued by an older
            // backend before the filter removal still render a label
            // until they finish. The current backend never emits this
            // phase.
            filtering: 'Preparing job',
            validating: 'Validating sessions (skipping cooldown rows)',
            running: 'Running',
            cooldown: 'Cooldown — pausing between rotations',
            pending: 'Pending',
          };
          const isInFlight = ['running', 'queued', 'pending', 'filtering', 'validating', 'cooldown'].includes(op.status);
          const phaseLabel = PHASE_LABELS[op.status];
          const opError = op?.options?.error || op?.error || null;

          return (
            <div key={op.id} className="rounded-lg border border-white/5 bg-dark-900 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StatusBadge status={op.status || 'running'} size="sm" />
                  <span className="text-sm text-white font-mono">#{op.id}</span>
                </div>
                {isInFlight && (
                  <button
                    onClick={() => onCancel(op.id)}
                    className="flex items-center gap-1 rounded-lg bg-red-500/10 border border-red-500/20 px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-500/20 transition"
                  >
                    <StopCircle className="w-3 h-3" />
                    Cancel
                  </button>
                )}
              </div>

              {phaseLabel && isInFlight && (
                <p className="text-xs text-gray-400">{phaseLabel}</p>
              )}

              {op.status === 'failed' && opError && (
                <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  <span className="font-medium">Error:</span> {opError}
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-gray-400">Progress</span>
                  <span className="text-xs font-medium text-white">{formatNumber(added)} / {formatNumber(total)}</span>
                </div>
                <div className="w-full bg-dark-800 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ${
                      op.status === 'failed' ? 'bg-red-500' : op.status === 'completed' ? 'bg-green-500' : 'bg-primary-600'
                    }`}
                    style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                  />
                </div>
              </div>

              <div className="flex items-center gap-4 text-xs text-gray-400">
                <span className="flex items-center gap-1 text-green-400">
                  <CheckCircle className="w-3 h-3" />
                  {formatNumber(added)} added
                </span>
                <span className="flex items-center gap-1 text-red-400">
                  <AlertTriangle className="w-3 h-3" />
                  {formatNumber(failed)} failed
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Main Groups Page
// ============================================================

export default function Groups() {
  const { showSuccess, showError } = useToast();
  const { connect, on, off, connected } = useWebSocket();

  const [activeTab, setActiveTab] = useState('add-members'); // 'add-members' or 'join-leave'
  const [submitting, setSubmitting] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [targetLists, setTargetLists] = useState([]);
  const [operations, setOperations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedOpErrors, setSelectedOpErrors] = useState(null);
  const [selectedOpId, setSelectedOpId] = useState(null);

  const pageSize = 10;

  const fetchSessions = useCallback(async () => {
    try {
      const response = await listSessions({ limit: 100 });
      setSessions(response.data.data?.sessions || []);
    } catch (err) {
      console.warn('Failed to fetch sessions:', parseApiError(err));
    }
  }, []);

  const fetchLists = useCallback(async () => {
    try {
      const response = await listsAPI.list({ limit: 50 });
      setTargetLists(response.data.data?.lists || []);
    } catch (err) {
      console.warn('Failed to fetch lists:', parseApiError(err));
    }
  }, []);

  const fetchOperations = useCallback(async () => {
    try {
      const response = await groupsAPI.listOperations({ limit: 50 });
      const data = response.data.data?.operations || [];
      setOperations(data);
    } catch (err) {
      console.warn('Failed to fetch operations:', parseApiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    fetchLists();
    fetchOperations();
  }, [fetchSessions, fetchLists, fetchOperations]);

  // Poll the operation history every 10s as a fallback for missed
  // websocket events. Without this, jobs that finish while the user
  // is on another tab (or after a transient socket drop) leave the
  // Operations panel showing stale `running`/`queued` rows. Mirrors
  // the polling cadence used on the Sessions page.
  useEffect(() => {
    const interval = setInterval(() => {
      fetchOperations();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchOperations]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) connect(token);
  }, [connect]);

  // WebSocket event handlers.
  //
  // The backend emits three event names from `groupQueue.js` and
  // `groupService.js` for every queued add-members run:
  //   - `group:progress` { jobId, opId, progress: { status, total, ... } }
  //   - `group:completed` { jobId, opId, result }
  //   - `group:failed` { jobId, opId, error }
  //
  // Older builds were listening for `add_progress` / `add_completed` /
  // `add_error`, which the backend never emitted — so the Operations
  // panel only updated via the 10s poll. Pull the operation id from
  // both `opId` and the legacy `operation_id` shape so this stays
  // compatible with anything still emitting the old payload.
  useEffect(() => {
    const opIdOf = (data) => {
      if (!data) return null;
      return data.opId ?? data.operation_id ?? data.jobId ?? null;
    };

    const handleProgress = (data) => {
      const id = opIdOf(data);
      if (id == null) return;
      const progress = data.progress || data;
      setOperations((prev) =>
        prev.map((op) =>
          op.id === id
            ? {
                ...op,
                ...progress,
                status: progress.status || op.status,
              }
            : op
        )
      );
    };

    const handleCompleted = (data) => {
      const id = opIdOf(data);
      if (id == null) return;
      const result = data.result || data;
      setOperations((prev) =>
        prev.map((op) =>
          op.id === id ? { ...op, ...result, status: 'completed' } : op
        )
      );
      showSuccess(
        `Add operation ${id} completed. ${result.added || result.addedCount || 0} added, ${result.failed || 0} failed, ${result.skipped || 0} skipped.`,
        'Operation Complete'
      );
      fetchOperations();
    };

    const handleError = (data) => {
      const id = opIdOf(data);
      if (id == null) return;
      setOperations((prev) =>
        prev.map((op) => (op.id === id ? { ...op, status: 'failed' } : op))
      );
      showError(
        `Add operation ${id} failed: ${data.error || 'Unknown error'}`,
        'Operation Error'
      );
      fetchOperations();
    };

    on('group:progress', handleProgress);
    on('group:completed', handleCompleted);
    on('group:failed', handleError);
    // Legacy aliases — keep listening so older deployments don't break.
    on('add_progress', handleProgress);
    on('add_completed', handleCompleted);
    on('add_error', handleError);

    return () => {
      off('group:progress', handleProgress);
      off('group:completed', handleCompleted);
      off('group:failed', handleError);
      off('add_progress', handleProgress);
      off('add_completed', handleCompleted);
      off('add_error', handleError);
    };
  }, [on, off, showSuccess, showError, fetchOperations]);

  const handleStartAdding = async (data) => {
    setSubmitting(true);
    const minLoadingTime = 3000;
    const startTime = Date.now();

    try {
      let users;
      if (data.sourceMode === 'manual') {
        // Manual input: the form already coerced every line into the
        // canonical shape, so no API hit is needed. The backend's
        // resolver chain handles `{ telegram_id }` → `@username`
        // fallback the same way it does for list-sourced rows; numeric
        // usernames are produced by neither path so peer-flood is not
        // triggered for unreachable handles.
        users = (data.manualUsers || []).map((u) => ({
          telegram_id: u.telegram_id || null,
          username: u.username || null,
          first_name: null,
          last_name: null,
          phone: null,
          access_hash: null,
        }));

        if (users.length === 0) {
          showError('Paste at least one user ID or @username.', 'Empty Input');
          return;
        }
      } else {
        // Fetch items from selected list. Forward `access_hash` alongside
        // the canonical fields so the backend can build an `InputUser`
        // directly when the list row was scraped — without it the worker
        // can only resolve users by @handle, which is unreliable for
        // numeric-id-only rows (Telegram says "Could not find the input
        // entity" for any stranger user without a cached hash).
        const listResponse = await listsAPI.getItems(data.sourceList, { limit: 10000 });
        users = (listResponse.data.data?.items || []).map((item) => ({
          telegram_id: item.telegram_id || item.telegramId,
          username: item.username,
          first_name: item.first_name || item.firstName,
          last_name: item.last_name || item.lastName,
          phone: item.phone,
          access_hash:
            item.access_hash !== undefined && item.access_hash !== null
              ? item.access_hash
              : item.accessHash !== undefined && item.accessHash !== null
                ? item.accessHash
                : null,
        }));

        if (users.length === 0) {
          showError('The selected list has no users. Please import or scrape users first.', 'Empty List');
          return;
        }
      }

      const addMembersPayload = {
        targetIds: data.targetIds,
        targetType: data.targetType,
        userList: users,
        delayMin: data.delayMin,
        delayMax: data.delayMax,
        batchSize: data.batchSize,
        // Use the async/queued path so the request returns 202 with an
        // opId immediately. The Operation History panel + WebSocket
        // progress events drive the rest of the UI; this keeps the
        // submit button from blocking on a long-running multi-session
        // run and stops the spinner from being stuck after the worker
        // finishes (the inline path used to swallow the completion
        // event because the response only landed after the websocket
        // fan-out).
        async: true,
      };
      // Forward the source list id so the backend can attribute the
      // job to the originating list (used by history / dedup).
      if (data.sourceList) {
        const listIdNum = parseInt(data.sourceList, 10);
        if (Number.isFinite(listIdNum)) {
          addMembersPayload.listId = listIdNum;
        }
      }
      // Distribution-engine knobs (new). Auto mode passes only `mode`;
      // manual mode forwards every operator-supplied value so the
      // backend planner clamps them and uses them directly.
      if (data.distribution) {
        const d = data.distribution;
        addMembersPayload.mode = d.mode || 'auto';
        if (d.mode === 'manual') {
          if (d.perSessionBurst != null) addMembersPayload.perSessionBurst = d.perSessionBurst;
          if (d.cooldownSecMin != null) addMembersPayload.cooldownSecMin = d.cooldownSecMin;
          if (d.cooldownSecMax != null) addMembersPayload.cooldownSecMax = d.cooldownSecMax;
          if (d.itemDelayMsMin != null) addMembersPayload.itemDelayMsMin = d.itemDelayMsMin;
          if (d.itemDelayMsMax != null) addMembersPayload.itemDelayMsMax = d.itemDelayMsMax;
        }
      }
      if (data.sessionListId) {
        addMembersPayload.sessionListId = Number(data.sessionListId);
      } else {
        addMembersPayload.sessionIds = (data.sessionIds || []).map(id => parseInt(id));
      }
      const response = await groupsAPI.addMembers(addMembersPayload);

      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, minLoadingTime - elapsed);
      await new Promise(resolve => setTimeout(resolve, remaining));

      const result = response.data.data || {};

      if (result.opId && (result.status === 'queued' || response.status === 202)) {
        // Async path: backend returned 202 + opId. The Operation History
        // panel will surface progress + completion via the websocket
        // listeners wired above (`add_progress`/`add_completed`).
        showSuccess(
          `Add operation queued for ${result.totalUsers || users.length} user(s) across ${data.targetIds.length} target(s). Tracking progress in Operation History.`,
          'Add Members Queued',
        );
      } else {
        const added = result.added || 0;
        const failed = result.failed || 0;
        const skipped = result.skipped || 0;
        const total = result.total || 0;

        if (failed === 0 && skipped === 0) {
          showSuccess(`All ${added} user(s) added successfully to ${data.targetIds.length} target(s).`, 'Complete');
        } else if (added > 0) {
          showSuccess(`${added} added, ${failed} failed, ${skipped} skipped out of ${total} user(s).`, 'Partial Success');
        } else {
          showError(`All ${failed} user(s) failed. Check logs for details.`, 'Failed');
        }
      }

      fetchOperations();
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, minLoadingTime - elapsed);
      await new Promise(resolve => setTimeout(resolve, remaining));
      showError(parseApiError(err), 'Start Failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoinLeave = async (data) => {
    // Join/Leave runs server-side as a BullMQ job: the controller
    // accepts the request and returns 202 with an opId immediately,
    // then we poll the operation row until it finishes. This keeps the
    // request well below the 30s axios cap even when many sessions are
    // selected (the inline implementation used to time out long before
    // the loop made any progress because each `_ensureConnected`
    // serially waited on a fresh proxy connect).
    setSubmitting(true);
    const startTime = Date.now();
    const minLoadingTime = 1500; // brief hold so the spinner is visible

    try {
      const apiCall = data.mode === 'join' ? groupsAPI.joinChannels : groupsAPI.leaveChannels;
      const actionWord = data.mode === 'join' ? 'joined' : 'left';

      const joinPayload = { targetIds: data.targetIds };
      if (data.sessionListId) {
        joinPayload.sessionListId = Number(data.sessionListId);
      } else {
        joinPayload.sessionIds = (data.sessionIds || []).map(id => parseInt(id));
      }

      const response = await apiCall(joinPayload);
      const queued = response?.data?.data || {};
      const opId = queued.opId;
      const total = queued.total || 0;

      if (!opId) {
        // Fallback for older deployments that still return inline 200.
        const inlineResult = queued;
        const inlineSuccess = data.mode === 'join' ? inlineResult.joined : inlineResult.left;
        if ((inlineResult.failed || 0) === 0 && (inlineResult.skipped || 0) === 0) {
          showSuccess(`All ${inlineSuccess} operation(s) ${actionWord} successfully.`, 'Complete');
        } else {
          showSuccess(
            `${inlineSuccess || 0} ${actionWord}, ${inlineResult.failed || 0} failed, ${inlineResult.skipped || 0} skipped.`,
            'Partial Success',
          );
        }
        fetchOperations();
        return;
      }

      showSuccess(
        `Queued ${total} ${data.mode} operation(s). Tracking progress in Operation History.`,
        data.mode === 'join' ? 'Join Queued' : 'Leave Queued',
      );
      fetchOperations();

      // Poll operation status. Backend writes Redis progress every
      // session/target pair so this is cheap. We bail after a generous
      // ceiling so a runaway job never holds the spinner forever — the
      // job continues server-side and is visible in Operation History.
      const POLL_INTERVAL_MS = 2500;
      const POLL_CEILING_MS = 10 * 60 * 1000; // 10 minutes
      const pollStarted = Date.now();
      let finalOp = null;
      while (Date.now() - pollStarted < POLL_CEILING_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        try {
          const opResp = await groupsAPI.getOperation(opId);
          const opData = opResp?.data?.data?.operation || opResp?.data?.data || {};
          if (['completed', 'failed', 'cancelled'].includes(opData.status)) {
            finalOp = opData;
            break;
          }
        } catch (pollErr) {
          // Transient — keep polling. If it persists, the timeout below fires.
        }
      }

      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, minLoadingTime - elapsed);
      await new Promise((resolve) => setTimeout(resolve, remaining));

      if (!finalOp) {
        showError(
          'Job is still running after the polling window expired. Check Operation History for live progress.',
          'Still Running',
        );
        return;
      }

      const success = finalOp.successCount || 0;
      const failed = finalOp.failedCount || 0;
      const skipped = Math.max(0, (finalOp.totalUsers || total) - success - failed);
      const totalRun = finalOp.totalUsers || total;

      if (finalOp.status === 'cancelled') {
        showError(`Operation cancelled. ${success} ${actionWord} so far, ${failed} failed.`, 'Cancelled');
      } else if (failed === 0 && skipped === 0) {
        showSuccess(`All ${success} session(s) ${actionWord} successfully.`, 'Complete');
      } else if (success > 0) {
        showSuccess(
          `${success} ${actionWord}, ${failed} failed, ${skipped} skipped out of ${totalRun}.`,
          'Partial Success',
        );
      } else {
        showError(`All ${failed} operation(s) failed. Open Operation History for details.`, 'Failed');
      }

      fetchOperations();
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, minLoadingTime - elapsed);
      await new Promise(resolve => setTimeout(resolve, remaining));
      showError(parseApiError(err), `${data.mode === 'join' ? 'Join' : 'Leave'} Failed`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelOperation = async (operationId) => {
    try {
      await groupsAPI.cancelOperation(operationId);
      showSuccess(`Operation ${operationId} cancelled.`, 'Cancelled');
      setOperations((prev) => prev.map((op) => (op.id === operationId ? { ...op, status: 'cancelled' } : op)));
    } catch (err) {
      showError(parseApiError(err), 'Cancel Failed');
    }
  };

  const handleViewErrors = async (operationId) => {
    try {
      const response = await groupsAPI.getOperation(operationId);
      const opData = response.data.data;
      const operation = opData?.operation || opData;
      setSelectedOpErrors(operation?.errors || operation?.failed_users || []);
      setSelectedOpId(operationId);
    } catch (err) {
      showError(parseApiError(err), 'Failed to load errors');
    }
  };

  // Treat the worker's intermediate phases ('filtering', 'validating',
  // 'cooldown') as active so the operator sees the row in the
  // top-of-page Active Operations panel for the entire pre-flight,
  // not just once the runner reaches 'running'.
  const activeOperations = operations.filter((op) =>
    ['running', 'queued', 'pending', 'filtering', 'validating', 'cooldown'].includes(op.status)
  );

  const totalPages = Math.ceil(operations.length / pageSize);
  const paginatedOperations = operations.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Groups & Channels</h1>
          <p className="mt-1 text-sm text-gray-400">
            Add members from scraped lists to groups or channels using multiple sessions
          </p>
        </div>
        {connected && (
          <div className="flex items-center gap-1.5 text-xs text-green-400">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            Live updates connected
          </div>
        )}
      </div>

      {/* Add Members Form + Active Operations */}
      <div className="rounded-xl border border-white/5 bg-dark-800 overflow-hidden">
        {/* Tab Navigation */}
        <div className="flex border-b border-white/5">
          <button
            onClick={() => setActiveTab('add-members')}
            className={`flex-1 px-5 py-3 text-sm font-medium transition flex items-center justify-center gap-2 ${
              activeTab === 'add-members'
                ? 'border-b-2 border-primary-500 text-primary-400 bg-primary-500/5'
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <UserPlus className="w-4 h-4" />
            Add Members
          </button>
          <button
            onClick={() => setActiveTab('join-leave')}
            className={`flex-1 px-5 py-3 text-sm font-medium transition flex items-center justify-center gap-2 ${
              activeTab === 'join-leave'
                ? 'border-b-2 border-primary-500 text-primary-400 bg-primary-500/5'
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <LogIn className="w-4 h-4" />
            Join/Leave
          </button>
        </div>

        {/* Tab Content */}
        <div className="p-5">
          {activeTab === 'add-members' ? (
            <AddMembersForm
              sessions={sessions}
              targetLists={targetLists}
              onSubmit={handleStartAdding}
              submitting={submitting}
            />
          ) : (
            <JoinLeaveForm
              sessions={sessions}
              onSubmit={handleJoinLeave}
              submitting={submitting}
            />
          )}
        </div>
      </div>

      {/* Active Operations Panel */}
      <div className="rounded-xl border border-white/5 bg-dark-800 p-5">
        <ActiveOperationsPanel operations={activeOperations} onCancel={handleCancelOperation} />
      </div>

      {/* Operations History */}
      <div className="rounded-xl border border-white/5 bg-dark-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/5">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Clock className="w-4 h-4 text-gray-400" />
            Operation History
          </h3>
        </div>

        {loading ? (
          <div className="p-8 text-center">
            <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary-500 mb-3" />
            <p className="text-gray-400 text-sm">Loading operations...</p>
          </div>
        ) : operations.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Clock className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>No operations yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-400">ID</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-400">Target</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-400">Status</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-400">Added / Failed / Total</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-400">Date</th>
                  <th className="text-right py-3 px-4 text-xs font-medium text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {paginatedOperations.map((op) => (
                  <tr key={op.id} className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-3 px-4 text-gray-300">#{op.id}</td>
                    <td className="py-3 px-4">
                      <p className="text-white truncate max-w-40" title={op.groupId || 'N/A'}>
                        {op.groupId || 'N/A'}
                      </p>
                      <p className="text-xs text-gray-500">{op.operationType || 'add_members'}</p>
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge status={op.status} />
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-green-400">{op.successCount || 0}</span>
                      <span className="text-gray-600 mx-1">/</span>
                      <span className="text-red-400">{op.failedCount || 0}</span>
                      <span className="text-gray-600 mx-1">/</span>
                      <span className="text-gray-400">{op.totalUsers || 0}</span>
                    </td>
                    <td className="py-3 px-4 text-gray-400 text-xs">
                      {op.createdAt ? formatDateTime(op.createdAt) : 'N/A'}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex justify-end gap-1">
                        {(op.failedCount > 0 || op.status === 'failed') && (
                          <button
                            onClick={() => handleViewErrors(op.id)}
                            className="p-1.5 rounded hover:bg-red-500/20 text-red-400"
                            title="View Errors"
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {['running', 'queued', 'pending', 'filtering', 'validating', 'cooldown'].includes(op.status) && (
                          <button
                            onClick={() => handleCancelOperation(op.id)}
                            className="p-1.5 rounded hover:bg-red-500/20 text-red-400"
                            title="Cancel"
                          >
                            <StopCircle className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-white/5 flex items-center justify-between">
            <p className="text-sm text-gray-400">
              Showing {(currentPage - 1) * pageSize + 1} to {Math.min(currentPage * pageSize, operations.length)} of {operations.length}
            </p>
            <div className="flex gap-1">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Error Detail Modal */}
      {selectedOpErrors && (
        <Modal
          isOpen={!!selectedOpErrors}
          onClose={() => { setSelectedOpErrors(null); setSelectedOpId(null); }}
          title={`Failed Users #${selectedOpId}`}
          size="xl"
        >
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-dark-800">
                <tr className="border-b border-white/5">
                  <th className="text-left py-2 px-3 text-xs font-medium text-gray-400">User ID</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-gray-400">Target</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-gray-400">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {selectedOpErrors.map((err, idx) => (
                  <tr key={idx} className="hover:bg-white/5">
                    <td className="py-2 px-3 text-gray-300 font-mono">{err.userId || err.user_id || 'N/A'}</td>
                    <td className="py-2 px-3 text-gray-400">{err.targetId || 'N/A'}</td>
                    <td className="py-2 px-3 text-red-400 text-xs">{err.error || 'Unknown error'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}
