import { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { listSessions } from '../api/sessions';
import {
  scrapeGroup,
  scrapeChannel,
  listScrapeJobs,
  getScrapeProgress,
  cancelScrapeJob,
  exportScrapeJob,
  deleteScrapeJob,
  getScrapeStats,
  previewScrapeTargets,
  createMonitorJob,
  listMonitorJobs,
  pauseMonitorJob,
  resumeMonitorJob,
  stopMonitorJob,
  cancelAllMonitorJobs,
  exportMonitorJob,
} from '../api/scrape';
import { listsAPI } from '../api/lists';
import { parseApiError, formatNumber } from '../utils/formatters';
import { useToast } from '../components/common/Toast';
import { Modal } from '../components/common/Modal';
import StatusBadge from '../components/common/StatusBadge';
import {
  Users, Link, Settings, Radio, Download, Check, AlertTriangle,
  Search, ChevronLeft, ChevronRight, ChevronDown, Trash2, CheckSquare, Square,
  Plus, X, Clock, TrendingUp, BarChart3, XCircle, Loader2, Play,
  StopCircle, ListFilter, FileDown, Eye, List, Pause, RefreshCw, Activity, ShieldAlert,
} from 'lucide-react';

// ----------------------------------------------------------------------------
// Helpers for the period-bounded MONITOR feature
// ----------------------------------------------------------------------------
const PERIOD_PRESETS = [
  { label: '5 min',  seconds: 5 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '6 hours', seconds: 6 * 60 * 60 },
  { label: '1 day',  seconds: 24 * 60 * 60 },
  { label: '2 days', seconds: 2 * 24 * 60 * 60 },
  { label: '7 days', seconds: 7 * 24 * 60 * 60 },
];

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '0s';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function remainingSeconds(job) {
  if (!job) return 0;
  if (job.status === 'paused') return job.remainingSeconds || 0;
  if (job.status !== 'running') return 0;
  if (!job.expiresAt) return 0;
  return Math.max(0, Math.floor((new Date(job.expiresAt).getTime() - Date.now()) / 1000));
}

// ============================================================================
// MAIN SCRAPE PAGE
// ============================================================================

export default function Scrape() {
  const [sessions, setSessions] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('scrape'); // 'scrape' | 'history' | 'stats'
  
  // Scrape form state
  const [selectedSessions, setSelectedSessions] = useState([]);
  const [targets, setTargets] = useState('');
  const [scrapeType, setScrapeType] = useState('group');
  const [limit, setLimit] = useState(1000);
  const [showBotFilters, setShowBotFilters] = useState(false);
  const [botFilterOptions, setBotFilterOptions] = useState({
    enabled: true,
    threshold: 0.6,
    requireUsername: false,
    requirePhone: false,
    requirePhoto: false,
    minAccountAge: 0,
  });
  const [saveToList, setSaveToList] = useState(false);
  const [listName, setListName] = useState('');
  
  // History state
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPagination, setHistoryPagination] = useState({ total: 0, pages: 0 });
  const [historyFilter, setHistoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [exportModal, setExportModal] = useState(null);
  const [createListModal, setCreateListModal] = useState(null);
  const [createListName, setCreateListName] = useState('');
  const [creatingList, setCreatingList] = useState(false);

  // Monitor (period-bounded) jobs
  const [monitorJobs, setMonitorJobs] = useState([]);
  const [monitorPagination, setMonitorPagination] = useState({ total: 0, pages: 0 });
  const [periodPrompt, setPeriodPrompt] = useState(null); // { adminTargets: [...], scrapableTargets: [...] }
  const [periodSeconds, setPeriodSeconds] = useState(2 * 24 * 60 * 60); // default 2 days
  // v8: explicit "are members hidden?" toggle. When ON, we skip the
  // preview probe entirely and route the submission straight into
  // monitor-mode using `periodSeconds` as the window. The previous
  // auto-detect path is kept as a safety net for users who don't know
  // whether their target is admin-only.
  const [hiddenMembers, setHiddenMembers] = useState(false);
  // v9: per-job toggles for the live monitor.
  //   * monitorDedupEnabled — when ON, repeat sightings of the same user
  //     merge into one row and bump message_count. When OFF, every chat
  //     event inserts a new row so a chatty user can appear N times.
  //   * monitorBotFilterEnabled — when ON, is_bot=TRUE senders are
  //     dropped at insert time and never enter the captured set.
  const [monitorDedupEnabled, setMonitorDedupEnabled] = useState(true);
  const [monitorBotFilterEnabled, setMonitorBotFilterEnabled] = useState(false);
  const [creatingMonitors, setCreatingMonitors] = useState(false);
  const [, forceTickRender] = useState(0);

  const { showSuccess, showError } = useToast();
  const ws = useWebSocket();

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    try {
      const response = await listSessions({ page: 1, limit: 100 });
      setSessions(response.data.data?.sessions || []);
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
    }
  }, []);

  // Fetch jobs
  const fetchJobs = useCallback(async () => {
    try {
      const params = {
        page: historyPage,
        limit: 20,
        sort: 'created_at',
        order: 'DESC',
      };
      if (historyFilter) params.filter = historyFilter;
      if (statusFilter !== 'all') params.status = statusFilter;
      
      const response = await listScrapeJobs(params);
      setJobs(response.data.data?.jobs || []);
      setHistoryPagination(response.data.data?.pagination || { total: 0, pages: 0 });
    } catch (err) {
      console.error('Failed to fetch jobs:', err);
    } finally {
      setLoading(false);
    }
  }, [historyPage, historyFilter, statusFilter]);

  // Fetch stats
  const fetchStats = useCallback(async () => {
    try {
      const response = await getScrapeStats();
      setStats(response.data.data);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  }, []);

  // Fetch monitor (period-bounded) jobs
  const fetchMonitors = useCallback(async () => {
    try {
      const params = {
        page: 1,
        limit: 50,
      };
      if (historyFilter) params.search = historyFilter;
      const response = await listMonitorJobs(params);
      setMonitorJobs(response.data.data?.jobs || []);
      setMonitorPagination(response.data.data?.pagination || { total: 0, pages: 0 });
    } catch (err) {
      console.error('Failed to fetch monitor jobs:', err);
    }
  }, [historyFilter]);

  useEffect(() => {
    fetchSessions();
    fetchJobs();
    fetchStats();
    fetchMonitors();
  }, [fetchSessions, fetchJobs, fetchStats, fetchMonitors]);

  // Re-render once a second so the live "remaining" countdown ticks down.
  useEffect(() => {
    const id = setInterval(() => forceTickRender((n) => (n + 1) % 1000), 1000);
    return () => clearInterval(id);
  }, []);

  // WebSocket for progress updates (regular scrape + period monitor)
  useEffect(() => {
    if (!ws) return;

    const onScrapeProgress = (data) => {
      setJobs(prev => {
        const jobIndex = prev.findIndex(job => job.id === data.jobId);
        if (jobIndex === -1) return prev;
        const updatedJobs = [...prev];
        updatedJobs[jobIndex] = { ...updatedJobs[jobIndex], ...data };
        return updatedJobs;
      });
    };
    ws.on('scrape_progress', onScrapeProgress);

    const monitorEvents = [
      'monitor:created', 'monitor:started', 'monitor:paused',
      'monitor:stopped', 'monitor:completed', 'monitor:failed',
      'monitor:cancel-all',
    ];
    const monitorRefresh = () => fetchMonitors();
    for (const ev of monitorEvents) ws.on(ev, monitorRefresh);

    const onMonitorProgress = (data) => {
      setMonitorJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === data.jobId);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], scrapedCount: data.scrapedCount };
        return next;
      });
    };
    ws.on('monitor:progress', onMonitorProgress);

    // v8: lightweight tick (scrapedCount + remainingSeconds + rate)
    // emitted every TICK_INTERVAL_MS by the backend so quiet chats
    // still update the UI countdown.
    const onMonitorTick = (data) => {
      setMonitorJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === data.jobId);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          scrapedCount: data.scrapedCount ?? next[idx].scrapedCount,
          remainingSeconds: data.remainingSeconds ?? next[idx].remainingSeconds,
          ratePerMinute: data.ratePerMinute ?? next[idx].ratePerMinute,
        };
        return next;
      });
    };
    ws.on('monitor:tick', onMonitorTick);

    return () => {
      try { ws.off?.('scrape_progress', onScrapeProgress); } catch { /* ignore */ }
      try { ws.off?.('monitor:progress', onMonitorProgress); } catch { /* ignore */ }
      try { ws.off?.('monitor:tick', onMonitorTick); } catch { /* ignore */ }
      try { for (const ev of monitorEvents) ws.off?.(ev, monitorRefresh); } catch { /* ignore */ }
    };
  }, [ws, fetchMonitors]);

  // Handle session multi-select
  const toggleSession = (sessionId) => {
    setSelectedSessions(prev => 
      prev.includes(sessionId)
        ? prev.filter(id => id !== sessionId)
        : [...prev, sessionId]
    );
  };

  const selectAllSessions = () => {
    const activeIds = sessions.filter(s => s.status === 'active').map(s => s.id);
    setSelectedSessions(activeIds);
  };

  // Handle scrape submission
  const handleScrape = async (e) => {
    e.preventDefault();

    if (selectedSessions.length === 0) {
      showError('Please select at least one session', 'Validation Error');
      return;
    }

    const targetList = targets.split('\n')
      .map(t => t.trim())
      .filter(t => t.length > 0);

    if (targetList.length === 0) {
      showError('Please enter at least one group/channel ID or link', 'Validation Error');
      return;
    }

    setSubmitting(true);

    // Show loading for at least 1.5 seconds.
    const minLoadingTime = 1500;
    const startTime = Date.now();

    try {
      // v8: explicit hidden-members toggle short-circuits the preview
      // probe entirely. The user already told us "this chat hides its
      // member list", so we go straight to monitor mode for every
      // entered target — no API call to verify, no duplicate work.
      if (hiddenMembers) {
        const adminTargets = targetList.map((t) => ({
          target: t,
          targetType: scrapeType,
          reason: 'user_marked_hidden',
          info: { title: null },
        }));
        setPeriodPrompt({ adminTargets, scrapableTargets: [] });
        return;
      }

      // Preview every target with the first selected session so we can
      // detect admin-only chats up front and offer the period-monitor
      // path instead of failing the scrape.
      let preview = null;
      try {
        const previewRes = await previewScrapeTargets({
          sessionId: selectedSessions[0],
          targetType: scrapeType,
          targets: targetList,
        });
        preview = previewRes.data?.data?.results || [];
      } catch (err) {
        console.warn('preview failed, falling back to direct scrape', err);
      }

      const adminTargets = preview ? preview.filter((r) => r.isAdminOnly) : [];
      const scrapableTargets = preview
        ? preview.filter((r) => !r.isAdminOnly).map((r) => r.target)
        : targetList;

      // If every target is admin-only, surface the period prompt and stop.
      if (preview && adminTargets.length === targetList.length) {
        setPeriodPrompt({ adminTargets, scrapableTargets: [] });
        return;
      }

      // Otherwise launch the regular scrape on whatever IS scrapable.
      const apiCall = scrapeType === 'group' ? scrapeGroup : scrapeChannel;
      const response = await apiCall({
        sessionIds: selectedSessions,
        targetIds: scrapableTargets,
        limit,
        filterBots: botFilterOptions.enabled,
        botFilterOptions: botFilterOptions.enabled ? botFilterOptions : undefined,
        saveToList,
        listName: saveToList ? listName.trim() : undefined,
        async: true,
      });

      const jobId = response.data.data?.jobId;
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, minLoadingTime - elapsed);
      await new Promise(resolve => setTimeout(resolve, remaining));

      showSuccess(
        `Scrape job started: ${scrapableTargets.length} target(s), ${selectedSessions.length} session(s). Job #${jobId}`,
        'Scrape Started'
      );

      // If some targets were admin-only, prompt the user to start a
      // monitor job for those without losing their session selection.
      if (adminTargets.length > 0) {
        setPeriodPrompt({ adminTargets, scrapableTargets });
      } else {
        setTargets('');
        setSelectedSessions([]);
      }
      setHistoryPage(1);
      await fetchJobs();
      await fetchStats();
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, minLoadingTime - elapsed);
      await new Promise(resolve => setTimeout(resolve, remaining));
      showError(parseApiError(err), 'Scrape Error');
    } finally {
      setSubmitting(false);
    }
  };

  // Launch period-bounded monitor jobs for the prompted admin-only targets.
  const handleStartMonitors = async () => {
    if (!periodPrompt || !periodPrompt.adminTargets?.length) return;
    if (!selectedSessions.length) {
      showError('Sessions selection is empty', 'Validation Error');
      return;
    }
    setCreatingMonitors(true);
    let started = 0;
    let failed = 0;
    for (const t of periodPrompt.adminTargets) {
      try {
        await createMonitorJob({
          sessionIds: selectedSessions,
          targetId: t.target,
          targetType: t.targetType || scrapeType,
          targetTitle: t.info?.title || null,
          durationSeconds: periodSeconds,
          reason: t.reason || 'admin_only',
          autoStart: true,
          // v9: per-job dedup + bot-filter toggles.
          dedupEnabled: monitorDedupEnabled,
          botFilterEnabled: monitorBotFilterEnabled,
        });
        started++;
      } catch (err) {
        console.error('failed to create monitor', err);
        failed++;
      }
    }
    setCreatingMonitors(false);
    setPeriodPrompt(null);
    if (started > 0) showSuccess(`${started} monitor job(s) started`, 'Monitor');
    if (failed > 0) showError(`${failed} monitor(s) failed`, 'Monitor Error');
    setActiveTab('history');
    await fetchMonitors();
  };

  // Monitor controls
  const handleMonitorPause = async (id) => {
    try {
      await pauseMonitorJob(id);
      showSuccess('Monitor paused', 'Paused');
      fetchMonitors();
    } catch (err) {
      showError(parseApiError(err), 'Pause Error');
    }
  };
  const handleMonitorResume = async (id) => {
    try {
      await resumeMonitorJob(id);
      showSuccess('Monitor resumed', 'Resumed');
      fetchMonitors();
    } catch (err) {
      showError(parseApiError(err), 'Resume Error');
    }
  };
  const handleMonitorStop = async (id) => {
    if (!confirm('Stop this monitor and finalize it?')) return;
    try {
      await stopMonitorJob(id);
      showSuccess('Monitor stopped', 'Stopped');
      fetchMonitors();
    } catch (err) {
      showError(parseApiError(err), 'Stop Error');
    }
  };
  const handleCancelAllMonitors = async () => {
    if (!confirm('Cancel ALL of your active monitor jobs? This cannot be undone.')) return;
    try {
      const res = await cancelAllMonitorJobs();
      showSuccess(`Cancelled ${res.data?.data?.cancelled || 0} monitor(s)`, 'Cancelled');
      fetchMonitors();
    } catch (err) {
      showError(parseApiError(err), 'Cancel-all Error');
    }
  };
  const handleMonitorExport = async (id, format = 'csv') => {
    try {
      const response = await exportMonitorJob(id, { format });
      const blob = new Blob([response.data], {
        type: format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/plain',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `monitor_${id}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      showSuccess('Export downloaded', 'Export');
    } catch (err) {
      showError(parseApiError(err), 'Export Error');
    }
  };

  // Cancel job
  const handleCancel = async (jobId) => {
    try {
      await cancelScrapeJob(jobId);
      showSuccess('Job cancelled', 'Cancelled');
      fetchJobs();
    } catch (err) {
      showError(parseApiError(err), 'Cancel Error');
    }
  };

  // Delete job
  const handleDelete = async (jobId) => {
    if (!confirm('Delete this scrape job and all its data?')) return;
    try {
      await deleteScrapeJob(jobId);
      showSuccess('Job deleted', 'Deleted');
      
      // Update history dynamically without refresh
      setJobs(prev => prev.filter(job => job.id !== jobId));
      await fetchStats();
    } catch (err) {
      showError(parseApiError(err), 'Delete Error');
    }
  };

  // Export job
  const handleExport = async (jobId, format = 'csv', filters = {}) => {
    try {
      const response = await exportScrapeJob(jobId, { format, ...filters });
      const blob = new Blob([response.data], {
        type: format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/plain',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `scrape_${jobId}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      showSuccess('Export downloaded', 'Export');
    } catch (err) {
      showError(parseApiError(err), 'Export Error');
    }
  };

  // Create list from scrape job
  const handleCreateList = async () => {
    if (!createListName.trim()) {
      showError('Please enter a list name', 'Validation Error');
      return;
    }
    setCreatingList(true);
    try {
      await listsAPI.createFromScrape({
        scrapeJobId: createListModal.id,
        listName: createListName.trim(),
      });
      showSuccess(`List "${createListName.trim()}" created with ${createListModal.total_found || 0} users`, 'List Created');
      setCreateListModal(null);
      setCreateListName('');
    } catch (err) {
      showError(parseApiError(err), 'Create List Error');
    } finally {
      setCreatingList(false);
    }
  };

  // UI Styles
  const cardClass = 'rounded-xl border border-white/5 bg-dark-900/50 p-5 backdrop-blur-sm';
  const inputBase = 'w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition';
  const btnPrimary = 'rounded-lg bg-gradient-to-r from-primary-600 to-primary-700 px-4 py-2 text-sm font-medium text-white shadow-lg hover:shadow-primary-500/20 hover:from-primary-500 hover:to-primary-600 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2';
  const btnSecondary = 'rounded-lg border border-white/10 bg-dark-800 px-3 py-2 text-sm font-medium text-gray-300 hover:bg-dark-700 hover:border-white/20 transition flex items-center justify-center gap-2';
  const labelClass = 'block text-sm font-medium text-gray-300 mb-2';

  const activeSessions = sessions.filter(s => s.status === 'active');

  // Helper to render per-target results
  const renderTargetResults = (job) => {
    const targetResults = job.stats?.targetResults || job.targetResults;
    if (!targetResults || targetResults.length === 0) return null;
    
    const successCount = targetResults.filter(r => r.status === 'success').length;
    const failCount = targetResults.filter(r => r.status === 'failed').length;
    
    return (
      <div className="mt-2 space-y-1">
        <div className="flex items-center gap-2 text-xs">
          <Check className="w-3 h-3 text-green-400" />
          <span className="text-green-400">{successCount} succeeded</span>
          {failCount > 0 && (
            <>
              <XCircle className="w-3 h-3 text-red-400" />
              <span className="text-red-400">{failCount} failed</span>
            </>
          )}
        </div>
        {targetResults.map((result, idx) => (
          <div key={idx} className="flex items-center gap-2 text-xs">
            {result.status === 'success' ? (
              <Check className="w-3 h-3 text-green-400 flex-shrink-0" />
            ) : (
              <XCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
            )}
            <span className="text-gray-300 truncate max-w-32">{result.target}</span>
            <span className="text-gray-500">
              {result.status === 'success' 
                ? `${result.usersFound || 0} users` 
                : result.error?.substring(0, 30) + '...'}
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Scrape Users</h1>
        <p className="text-gray-400 text-sm mt-1">
          Extract users from Telegram groups and channels with advanced bot filtering
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-dark-900/50 p-1 rounded-lg w-fit">
        {[
          { id: 'scrape', label: 'Scrape', icon: Radio },
          { id: 'history', label: 'History', icon: Clock },
          { id: 'stats', label: 'Statistics', icon: BarChart3 },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
              activeTab === tab.id
                ? 'bg-primary-600 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* SCRAPE TAB */}
      {activeTab === 'scrape' && (
        <form onSubmit={handleScrape} className="space-y-6">
          {/* Session Selection */}
          <div className={cardClass}>
            <div className="flex justify-between items-center mb-3">
              <label className={labelClass}>
                <Users className="w-4 h-4 inline mr-2" />
                Sessions ({selectedSessions.length} selected)
              </label>
              <button
                type="button"
                onClick={selectAllSessions}
                className="text-xs text-primary-400 hover:text-primary-300"
              >
                Select All Active
              </button>
            </div>
            
            {activeSessions.length === 0 ? (
              <div className="p-8 text-center text-gray-500 border border-dashed border-white/10 rounded-lg">
                <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">No active sessions available</p>
                <p className="text-xs mt-1">Login a session first to use scraping</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 max-h-60 overflow-y-auto">
                {activeSessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => toggleSession(session.id)}
                    className={`flex items-center gap-2 p-2 rounded-lg border transition ${
                      selectedSessions.includes(session.id)
                        ? 'border-primary-500 bg-primary-500/10'
                        : 'border-white/5 hover:border-white/10'
                    }`}
                  >
                    {selectedSessions.includes(session.id) ? (
                      <CheckSquare className="w-4 h-4 text-primary-400" />
                    ) : (
                      <Square className="w-4 h-4 text-gray-600" />
                    )}
                    <div className="flex-1 text-left">
                      <p className="text-sm text-white truncate">
                        {session.phone || session.username || `Session ${session.id}`}
                      </p>
                      <p className="text-xs text-gray-500">
                        ID: {session.id}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Target Input */}
          <div className={cardClass}>
            <label className={labelClass}>
              <Link className="w-4 h-4 inline mr-2" />
              Target Groups/Channels (one per line)
            </label>
            <textarea
              value={targets}
              onChange={e => setTargets(e.target.value)}
              placeholder={`Enter group/channel usernames or IDs:\n@mygroup\nhttps://t.me/mychannel\n-1001234567890`}
              className={`${inputBase} h-32 resize-y font-mono text-xs`}
            />
            <p className="text-xs text-gray-500 mt-1">
              Enter one target per line. Supports: usernames, links, or numeric IDs
            </p>
          </div>

          {/* v8: explicit hidden-members toggle. When ON we route the
              entire submit straight to monitor mode and surface the
              "this is allowed via period monitoring" copy below. */}
          <div className={cardClass}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-200 flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-warning-400" />
                  Are this group / channel's members hidden?
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  Turn this on if the chat is configured so that only admins can see the participant list. We'll switch this submission to <strong>period monitor mode</strong>.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHiddenMembers((v) => !v)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${hiddenMembers ? 'bg-warning-500' : 'bg-white/10'}`}
                role="switch"
                aria-checked={hiddenMembers}
              >
                <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${hiddenMembers ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>
            {hiddenMembers && (
              <div className="mt-3 rounded-lg border border-warning-500/30 bg-warning-500/10 p-3 text-xs text-warning-200 space-y-1.5">
                <p>
                  <strong>Heads up:</strong> Telegram does not allow scraping users instantly from groups or channels with hidden members.
                </p>
                <p>
                  However, the panel can <strong>monitor that group / channel</strong> for the period of time you specify. During that window we passively listen for every distinct user that interacts (sends, replies, joins, posts) and dedupe them in real time. The job runs entirely on our backend and survives reloads, restarts and pauses — you can come back later and export the captured users.
                </p>
                <p>
                  After you click <em>Start Scrape</em> we'll ask you to pick the monitoring window. You'll see live progress (count, rate, time remaining) on the History tab and can stop or pause anytime.
                </p>
              </div>
            )}
          </div>

          {/* Settings Row */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className={cardClass}>
              <label className={labelClass}>
                <Radio className="w-4 h-4 inline mr-2" />
                Target Type
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setScrapeType('group')}
                  className={`flex-1 py-2 px-3 rounded-lg text-sm transition ${
                    scrapeType === 'group'
                      ? 'bg-primary-600 text-white'
                      : 'bg-dark-800 text-gray-400 hover:bg-dark-700'
                  }`}
                >
                  Groups
                </button>
                <button
                  type="button"
                  onClick={() => setScrapeType('channel')}
                  className={`flex-1 py-2 px-3 rounded-lg text-sm transition ${
                    scrapeType === 'channel'
                      ? 'bg-primary-600 text-white'
                      : 'bg-dark-800 text-gray-400 hover:bg-dark-700'
                  }`}
                >
                  Channels
                </button>
              </div>
            </div>

            <div className={cardClass}>
              <label className={labelClass}>
                <TrendingUp className="w-4 h-4 inline mr-2" />
                Limit per Target
              </label>
              <input
                type="number"
                value={limit}
                onChange={e => setLimit(parseInt(e.target.value) || 1000)}
                min="1"
                max="100000"
                className={inputBase}
              />
            </div>

            <div className={cardClass}>
              <label className={labelClass}>
                <Download className="w-4 h-4 inline mr-2" />
                Save to List
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={saveToList}
                  onChange={e => setSaveToList(e.target.checked)}
                  className="rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500"
                />
                {saveToList && (
                  <input
                    type="text"
                    value={listName}
                    onChange={e => setListName(e.target.value)}
                    placeholder="List name..."
                    className={`${inputBase} flex-1`}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Bot Filter Toggle */}
          <div className={cardClass}>
            <button
              type="button"
              onClick={() => setShowBotFilters(!showBotFilters)}
              className="flex justify-between items-center w-full"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-gray-300">
                <ListFilter className="w-4 h-4" />
                Bot Filtering
                <span className={`px-2 py-0.5 rounded text-xs ${
                  botFilterOptions.enabled
                    ? 'bg-green-500/20 text-green-400'
                    : 'bg-gray-700 text-gray-400'
                }`}>
                  {botFilterOptions.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </span>
              <ChevronDown className={`w-4 h-4 text-gray-500 transition ${showBotFilters ? 'rotate-180' : ''}`} />
            </button>

            {showBotFilters && (
              <div className="mt-4 space-y-4 border-t border-white/5 pt-4">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={botFilterOptions.enabled}
                    onChange={e => setBotFilterOptions(prev => ({ ...prev, enabled: e.target.checked }))}
                    className="rounded border-white/20 bg-dark-900 text-primary-600"
                  />
                  <span className="text-sm text-gray-300">Enable bot filtering</span>
                </div>

                {botFilterOptions.enabled && (
                  <>
                    <div>
                      <label className={labelClass}>
                        Detection Threshold: {Math.round(botFilterOptions.threshold * 100)}%
                      </label>
                      <input
                        type="range"
                        min="0.3"
                        max="0.9"
                        step="0.05"
                        value={botFilterOptions.threshold}
                        onChange={e => setBotFilterOptions(prev => ({ ...prev, threshold: parseFloat(e.target.value) }))}
                        className="w-full"
                      />
                      <div className="flex justify-between text-xs text-gray-500">
                        <span>Lenient</span>
                        <span>Strict</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {[
                        { key: 'requireUsername', label: 'Require Username' },
                        { key: 'requirePhone', label: 'Require Phone' },
                        { key: 'requirePhoto', label: 'Require Photo' },
                      ].map(opt => (
                        <div key={opt.key} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={botFilterOptions[opt.key]}
                            onChange={e => setBotFilterOptions(prev => ({ ...prev, [opt.key]: e.target.checked }))}
                            className="rounded border-white/20 bg-dark-900 text-primary-600"
                          />
                          <span className="text-sm text-gray-400">{opt.label}</span>
                        </div>
                      ))}
                    </div>

                    <div>
                      <label className={labelClass}>Minimum Account Age (days)</label>
                      <input
                        type="number"
                        value={botFilterOptions.minAccountAge}
                        onChange={e => setBotFilterOptions(prev => ({ ...prev, minAccountAge: parseInt(e.target.value) || 0 }))}
                        min="0"
                        max="3650"
                        className={inputBase}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={submitting || selectedSessions.length === 0 || !targets.trim()}
            className={`${btnPrimary} w-full py-3 text-base`}
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Starting Scrape...
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                Start Scraping ({selectedSessions.length} sessions, {targets.split('\n').filter(t => t.trim()).length} targets)
              </>
            )}
          </button>
        </form>
      )}

      {/* HISTORY TAB */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex gap-3 flex-wrap">
            <div className="relative flex-1 min-w-64">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
              <input
                type="text"
                value={historyFilter}
                onChange={e => { setHistoryFilter(e.target.value); setHistoryPage(1); }}
                placeholder="Search jobs..."
                className={`${inputBase} pl-9`}
              />
            </div>
            <div className="flex gap-1 bg-dark-900/50 p-1 rounded-lg">
              {['all', 'running', 'completed', 'failed', 'cancelled'].map(status => (
                <button
                  key={status}
                  onClick={() => { setStatusFilter(status); setHistoryPage(1); }}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition ${
                    statusFilter === status
                      ? 'bg-primary-600 text-white'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Period-monitor jobs (admin-only chats) */}
          <div className={cardClass}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Activity className="w-4 h-4 text-primary-400" />
                  Period Monitor Jobs
                  <span className="text-xs text-gray-500 font-normal">
                    ({monitorJobs.filter(j => ['running','paused','pending'].includes(j.status)).length} active / {monitorJobs.length} total)
                  </span>
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Live listeners on admin-only groups/channels. Captures every distinct user that interacts during the window.
                </p>
              </div>
              {monitorJobs.some(j => ['running', 'paused', 'pending'].includes(j.status)) && (
                <button
                  onClick={handleCancelAllMonitors}
                  className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/20 flex items-center gap-1.5"
                >
                  <StopCircle className="w-3.5 h-3.5" />
                  Cancel all
                </button>
              )}
            </div>
            {monitorJobs.length === 0 ? (
              <div className="p-6 text-center text-gray-500 text-xs border border-dashed border-white/10 rounded-lg">
                No monitor jobs yet. Try scraping an admin-only chat — you will be offered the option to monitor it for a period instead.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/5">
                      <th className="text-left py-2 px-3 text-gray-400">ID</th>
                      <th className="text-left py-2 px-3 text-gray-400">Target</th>
                      <th className="text-left py-2 px-3 text-gray-400">Sessions</th>
                      <th className="text-left py-2 px-3 text-gray-400">Status</th>
                      <th className="text-left py-2 px-3 text-gray-400">Scraped</th>
                      <th className="text-left py-2 px-3 text-gray-400">Window</th>
                      <th className="text-left py-2 px-3 text-gray-400">Remaining</th>
                      <th className="text-right py-2 px-3 text-gray-400">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monitorJobs.map((m) => {
                      const remain = remainingSeconds(m);
                      const total = m.durationSeconds || 1;
                      const progressPct = Math.max(0, Math.min(100,
                        Math.floor(((total - (remain || 0)) / total) * 100)
                      ));
                      return (
                        <tr key={m.id} className="border-b border-white/5 hover:bg-white/5">
                          <td className="py-2 px-3 text-gray-300">#{m.id}</td>
                          <td className="py-2 px-3">
                            <p className="text-white truncate max-w-40" title={m.targetId}>
                              {m.targetTitle || m.targetId}
                            </p>
                            <p className="text-gray-500">{m.targetType}</p>
                            {/* v9: show the per-job toggle state. Defaults
                                are dedup ON / bot filter OFF, so we only
                                surface a badge when the value differs from
                                the default to keep the row visually quiet
                                for users who never touched the toggles. */}
                            <div className="flex flex-wrap gap-1 mt-1">
                              {m.dedupEnabled === false && (
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30"
                                  title="Duplicates allowed — every observed message is its own row."
                                >
                                  dups: on
                                </span>
                              )}
                              {m.botFilterEnabled === true && (
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                                  title="Bot filter on — is_bot=true senders are dropped before insert."
                                >
                                  bots: filtered
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-gray-300">{m.sessionIds?.length || 0}</td>
                          <td className="py-2 px-3">
                            <StatusBadge status={m.status === 'paused' ? 'pending' : m.status} />
                            {m.status === 'paused' && (
                              <span className="text-xs text-amber-400 ml-1">(paused)</span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-white font-medium">
                            {formatNumber(m.scrapedCount || 0)}
                          </td>
                          <td className="py-2 px-3 text-gray-400">
                            <div>{formatDuration(m.durationSeconds)}</div>
                            <div className="w-20 bg-dark-800 rounded-full h-1 mt-1">
                              <div
                                className="bg-primary-500 h-1 rounded-full transition-all"
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                          </td>
                          <td className="py-2 px-3 text-gray-300">
                            {['running', 'paused'].includes(m.status) ? formatDuration(remain) : '—'}
                          </td>
                          <td className="py-2 px-3 text-right">
                            <div className="flex justify-end gap-1">
                              {m.status === 'running' && (
                                <button
                                  onClick={() => handleMonitorPause(m.id)}
                                  className="p-1.5 rounded hover:bg-amber-500/20 text-amber-300"
                                  title="Pause"
                                >
                                  <Pause className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {m.status === 'paused' && (
                                <button
                                  onClick={() => handleMonitorResume(m.id)}
                                  className="p-1.5 rounded hover:bg-emerald-500/20 text-emerald-300"
                                  title="Resume"
                                >
                                  <Play className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {['running', 'paused', 'pending'].includes(m.status) && (
                                <button
                                  onClick={() => handleMonitorStop(m.id)}
                                  className="p-1.5 rounded hover:bg-red-500/20 text-red-400"
                                  title="Stop"
                                >
                                  <StopCircle className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {(m.scrapedCount || 0) > 0 && (
                                <button
                                  onClick={() => handleMonitorExport(m.id, 'csv')}
                                  className="p-1.5 rounded hover:bg-green-500/20 text-green-400"
                                  title="Export CSV"
                                >
                                  <FileDown className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Jobs Table */}
          <div className={cardClass}>
            {loading ? (
              <div className="p-8 text-center">
                <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary-500" />
              </div>
            ) : jobs.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                <Clock className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>No scrape jobs found</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/5">
                      <th className="text-left py-3 px-3 text-xs font-medium text-gray-400">ID</th>
                      <th className="text-left py-3 px-3 text-xs font-medium text-gray-400">Target</th>
                      <th className="text-left py-3 px-3 text-xs font-medium text-gray-400">Sessions</th>
                      <th className="text-left py-3 px-3 text-xs font-medium text-gray-400">Status</th>
                      <th className="text-left py-3 px-3 text-xs font-medium text-gray-400">Progress</th>
                      <th className="text-left py-3 px-3 text-xs font-medium text-gray-400">Users</th>
                      <th className="text-left py-3 px-3 text-xs font-medium text-gray-400">Created</th>
                      <th className="text-right py-3 px-3 text-xs font-medium text-gray-400">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map(job => (
                      <tr key={job.id} className="border-b border-white/5 hover:bg-white/5">
                        <td className="py-3 px-3 text-gray-300">#{job.id}</td>
                        <td className="py-3 px-3">
                          <p className="text-white truncate max-w-40" title={job.target_id}>
                            {job.target_id}
                          </p>
                          <p className="text-xs text-gray-500">{job.target_type}</p>
                          {renderTargetResults(job)}
                        </td>
                        <td className="py-3 px-3 text-gray-300">
                          {job.job_mode === 'single' ? '1' : `${job.session_ids?.length || 1}`}
                        </td>
                        <td className="py-3 px-3">
                          <StatusBadge 
                            status={job.status === 'completed_with_errors' ? 'completed' : job.status} 
                          />
                          {job.status === 'completed_with_errors' && (
                            <span className="text-xs text-yellow-400 ml-1">(partial)</span>
                          )}
                        </td>
                        <td className="py-3 px-3">
                          <div className="w-24 bg-dark-800 rounded-full h-1.5">
                            <div
                              className="bg-primary-500 h-1.5 rounded-full transition-all"
                              style={{ width: `${job.progress || 0}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-500 mt-1">{job.progress || 0}%</span>
                        </td>
                        <td className="py-3 px-3 text-gray-300">
                          {formatNumber(job.total_found || 0)}
                        </td>
                        <td className="py-3 px-3 text-gray-400 text-xs">
                          {new Date(job.created_at).toLocaleString()}
                        </td>
                        <td className="py-3 px-3 text-right">
                          <div className="flex justify-end gap-1">
                            {job.status === 'running' && (
                              <button
                                onClick={() => handleCancel(job.id)}
                                className="p-1.5 rounded hover:bg-red-500/20 text-red-400"
                                title="Cancel"
                              >
                                <StopCircle className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {job.status === 'completed' && (
                              <button
                                onClick={() => setExportModal(job)}
                                className="p-1.5 rounded hover:bg-green-500/20 text-green-400"
                                title="Export"
                              >
                                <FileDown className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {(job.status === 'completed' || job.status === 'completed_with_errors') && (
                              <button
                                onClick={() => {
                                  setCreateListModal(job);
                                  setCreateListName(`Scraped from ${job.target_id || 'job #'}${job.id}`);
                                }}
                                className="p-1.5 rounded hover:bg-blue-500/20 text-blue-400"
                                title="Create List for Messaging"
                              >
                                <List className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => handleDelete(job.id)}
                              className="p-1.5 rounded hover:bg-red-500/20 text-red-400"
                              title="Delete"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination */}
            {historyPagination.pages > 1 && (
              <div className="flex justify-between items-center pt-4 border-t border-white/5">
                <p className="text-xs text-gray-500">
                  Showing {((historyPage - 1) * 20) + 1}-{Math.min(historyPage * 20, historyPagination.total)} of {historyPagination.total}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setHistoryPage(p => Math.max(1, p - 1))}
                    disabled={historyPage === 1}
                    className={btnSecondary}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setHistoryPage(p => Math.min(historyPagination.pages, p + 1))}
                    disabled={historyPage === historyPagination.pages}
                    className={btnSecondary}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* STATS TAB */}
      {activeTab === 'stats' && stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: 'Total Jobs', value: stats.total_jobs, icon: Clock, color: 'blue' },
            { label: 'Completed', value: stats.completed, icon: Check, color: 'green' },
            { label: 'Running', value: stats.running, icon: Play, color: 'yellow' },
            { label: 'Failed', value: stats.failed, icon: XCircle, color: 'red' },
            { label: 'Total Users Scraped', value: formatNumber(stats.total_users_scraped), icon: Users, color: 'purple' },
            { label: 'Bots Filtered', value: formatNumber(stats.total_bots_filtered), icon: ListFilter, color: 'orange' },
          ].map(stat => (
            <div key={stat.label} className={`${cardClass} flex items-center gap-4`}>
              <div className={`p-3 rounded-lg bg-${stat.color}-500/20`}>
                <stat.icon className={`w-6 h-6 text-${stat.color}-400`} />
              </div>
              <div>
                <p className="text-2xl font-bold text-white">{stat.value}</p>
                <p className="text-xs text-gray-500">{stat.label}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Export Modal */}
      {exportModal && (
        <Modal isOpen={true} onClose={() => setExportModal(null)} title="Export Scraped Users">
          <div className="space-y-4">
            <p className="text-sm text-gray-400">
              Export {formatNumber(exportModal.total_found || 0)} users from job #{exportModal.id}
            </p>
            <div className="flex gap-2">
              {['csv', 'json', 'txt'].map(format => (
                <button
                  key={format}
                  onClick={() => {
                    handleExport(exportModal.id, format, { excludeBots: true });
                    setExportModal(null);
                  }}
                  className={btnPrimary}
                >
                  <Download className="w-4 h-4" />
                  {format.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {/* Create List Modal */}
      {createListModal && (
        <Modal isOpen={true} onClose={() => { setCreateListModal(null); setCreateListName(''); }} title="Create List for Messaging">
          <div className="space-y-4">
            <p className="text-sm text-gray-400">
              Create a contact list with {formatNumber(createListModal.total_found || 0)} users from job #{createListModal.id}.
              This list will be available in the Messaging tab for bulk sending.
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">List Name</label>
              <input
                type="text"
                value={createListName}
                onChange={(e) => setCreateListName(e.target.value)}
                placeholder="Enter list name..."
                className={inputBase}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateList();
                }}
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setCreateListModal(null); setCreateListName(''); }}
                className={btnSecondary}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateList}
                disabled={creatingList || !createListName.trim()}
                className={btnPrimary}
              >
                {creatingList ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <List className="w-4 h-4" />
                    Create List
                  </>
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Period prompt modal — shown when one or more targets are admin-only */}
      {periodPrompt && (
        <Modal
          isOpen={true}
          onClose={() => setPeriodPrompt(null)}
          title="Admin-only chats detected"
        >
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <ShieldAlert className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-amber-200">
                <p className="font-medium">
                  {periodPrompt.adminTargets.length} chat{periodPrompt.adminTargets.length === 1 ? '' : 's'} hide{periodPrompt.adminTargets.length === 1 ? 's' : ''} the participant list from non-admins.
                </p>
                <p className="text-xs text-amber-200/80 mt-1">
                  We can monitor these chats for the period you choose and capture every user who interacts with them. Use the capture options below to control whether the same user is allowed to appear more than once and whether Telegram bots are filtered out. Your sessions stay attached the entire window through the anti-detect proxy system.
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-white/5 bg-dark-900/50 p-3 max-h-40 overflow-y-auto">
              <p className="text-xs text-gray-400 mb-2">Targets that will be monitored:</p>
              <ul className="space-y-1">
                {periodPrompt.adminTargets.map((t) => (
                  <li key={t.target} className="text-xs text-gray-300 flex items-center gap-2">
                    <ShieldAlert className="w-3 h-3 text-amber-400 flex-shrink-0" />
                    <span className="truncate">{t.info?.title || t.target}</span>
                    {t.info?.title && (
                      <span className="text-gray-500 truncate">({t.target})</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <label className={labelClass}>Monitor period</label>
              <div className="flex flex-wrap gap-2 mb-2">
                {PERIOD_PRESETS.map((p) => (
                  <button
                    key={p.seconds}
                    type="button"
                    onClick={() => setPeriodSeconds(p.seconds)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                      periodSeconds === p.seconds
                        ? 'border-primary-500 bg-primary-500/20 text-primary-200'
                        : 'border-white/10 bg-dark-800 text-gray-300 hover:bg-dark-700'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'Days', divisor: 86400 },
                  { label: 'Hours', divisor: 3600 },
                  { label: 'Minutes', divisor: 60 },
                ].map((u) => {
                  const total = periodSeconds || 0;
                  const days = Math.floor(total / 86400);
                  const hours = Math.floor((total % 86400) / 3600);
                  const minutes = Math.floor((total % 3600) / 60);
                  const valueByLabel = { Days: days, Hours: hours, Minutes: minutes };
                  return (
                    <div key={u.label}>
                      <label className="block text-xs text-gray-500 mb-1">{u.label}</label>
                      <input
                        type="number"
                        min="0"
                        value={valueByLabel[u.label]}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10) || 0;
                          const others = { Days: days, Hours: hours, Minutes: minutes };
                          others[u.label] = v;
                          setPeriodSeconds(
                            others.Days * 86400 + others.Hours * 3600 + others.Minutes * 60
                          );
                        }}
                        className={inputBase}
                      />
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Total: {formatDuration(periodSeconds)} • Sessions attached: {selectedSessions.length || 0}
              </p>
            </div>

            {/* v9: capture options — dedup + bot filter toggles. */}
            <div className="rounded-lg border border-white/10 bg-dark-900/40 p-3 space-y-3">
              <p className="text-xs font-medium text-gray-300">Capture options</p>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={monitorDedupEnabled}
                  onChange={(e) => setMonitorDedupEnabled(e.target.checked)}
                  className="mt-0.5 rounded border-white/20 bg-dark-900 text-primary-600"
                />
                <span className="text-sm text-gray-200 select-none">
                  Avoid duplicates
                  <span className="block text-xs text-gray-500 mt-0.5">
                    {monitorDedupEnabled
                      ? 'On — each user appears once; repeat messages bump their message count.'
                      : 'Off — every observed message is a separate row, so a chatty user appears multiple times. Use this when no user must be missed, even at the cost of duplicates.'}
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={monitorBotFilterEnabled}
                  onChange={(e) => setMonitorBotFilterEnabled(e.target.checked)}
                  className="mt-0.5 rounded border-white/20 bg-dark-900 text-primary-600"
                />
                <span className="text-sm text-gray-200 select-none">
                  Filter out bots
                  <span className="block text-xs text-gray-500 mt-0.5">
                    {monitorBotFilterEnabled
                      ? 'On — Telegram bots (is_bot=true) are dropped before they ever land in the list.'
                      : 'Off — bots are recorded with an is_bot flag; you can filter them visually later.'}
                  </span>
                </span>
              </label>
            </div>

            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => setPeriodPrompt(null)}
                className={btnSecondary}
              >
                Cancel
              </button>
              <button
                onClick={handleStartMonitors}
                disabled={creatingMonitors || periodSeconds < 60 || selectedSessions.length === 0}
                className={btnPrimary}
              >
                {creatingMonitors ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Starting…
                  </>
                ) : (
                  <>
                    <Radio className="w-4 h-4" />
                    Start monitor for {periodPrompt.adminTargets.length} chat{periodPrompt.adminTargets.length === 1 ? '' : 's'}
                  </>
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
