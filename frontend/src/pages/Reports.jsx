import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart3,
  Users,
  MessageSquare,
  Layers,
  Calendar,
  Download,
  Eye,
  Trash2,
  Plus,
  Loader2,
  Search,
  X,
  FileText,
  FileJson,
  AlertTriangle,
  Target,
  ChevronLeft,
  ChevronRight,
  Activity,
  UserCheck,
  Send,
  TrendingUp,
  RefreshCw,
  Database,
  Group as GroupIcon,
  ListChecks,
  History as HistoryIcon,
  Filter,
} from 'lucide-react';
import { Modal } from '../components/common/Modal';
import { useToast } from '../components/common/Toast';
import { reportsAPI } from '@/api';
import {
  parseApiError,
  formatNumber,
  formatDate,
  formatDateTime,
  formatRelativeTime,
} from '@/utils/formatters';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

// ============================================================================
// Constants & shared bits
// ============================================================================

const PERIODS = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range…' },
];

const TABS = [
  { value: 'overview',  label: 'Overview',  icon: BarChart3 },
  { value: 'sessions',  label: 'Sessions',  icon: Layers },
  { value: 'messaging', label: 'Messaging', icon: MessageSquare },
  { value: 'scraping',  label: 'Scraping',  icon: Database },
  { value: 'groupOps',  label: 'Group Ops', icon: GroupIcon },
  { value: 'lists',     label: 'Lists',     icon: ListChecks },
  { value: 'activity',  label: 'Activity',  icon: HistoryIcon },
  { value: 'saved',     label: 'Saved',     icon: FileText },
];

const REPORT_TYPES = [
  { value: 'channel', label: 'Channel', icon: Send,      color: '#6366f1' },
  { value: 'group',   label: 'Group',   icon: Users,     color: '#8b5cf6' },
  { value: 'user',    label: 'User',    icon: UserCheck, color: '#22c55e' },
  { value: 'session', label: 'Session', icon: Layers,    color: '#f97316' },
];

const PIE_COLORS = ['#6366f1', '#8b5cf6', '#22c55e', '#f97316', '#ef4444', '#06b6d4', '#f43f5e', '#14b8a6'];

const chartTooltipStyle = {
  backgroundColor: '#1e293b',
  border: '1px solid #334155',
  borderRadius: '8px',
  padding: '8px 12px',
  color: '#f8fafc',
  fontSize: '13px',
};

// ----------------------------------------------------------------------------
// Tiny status-badge helpers
// ----------------------------------------------------------------------------

const STATUS_TONES = {
  completed: 'bg-emerald-500/15 text-emerald-400',
  active:    'bg-emerald-500/15 text-emerald-400',
  running:   'bg-blue-500/15 text-blue-400',
  pending:   'bg-amber-500/15 text-amber-400',
  paused:    'bg-amber-500/15 text-amber-400',
  failed:    'bg-red-500/15 text-red-400',
  error:     'bg-red-500/15 text-red-400',
  cancelled: 'bg-gray-500/15 text-gray-300',
  inactive:  'bg-gray-500/15 text-gray-400',
  uploaded:  'bg-indigo-500/15 text-indigo-400',
  revoked:   'bg-orange-500/15 text-orange-400',
  expired:   'bg-orange-500/15 text-orange-400',
};

function StatusBadge({ status }) {
  if (!status) return <span className="text-gray-500">—</span>;
  const tone = STATUS_TONES[status] || 'bg-gray-500/15 text-gray-300';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${tone}`}>
      {String(status).replace(/_/g, ' ')}
    </span>
  );
}

function TypeBadge({ type }) {
  const config = {
    channel:    { bg: 'bg-indigo-500/15',  text: 'text-indigo-400',  label: 'Channel' },
    group:      { bg: 'bg-purple-500/15',  text: 'text-purple-400',  label: 'Group' },
    user:       { bg: 'bg-emerald-500/15', text: 'text-emerald-400', label: 'User' },
    session:    { bg: 'bg-orange-500/15',  text: 'text-orange-400',  label: 'Session' },
    overview:   { bg: 'bg-blue-500/15',    text: 'text-blue-400',    label: 'Overview' },
    dashboard:  { bg: 'bg-blue-500/15',    text: 'text-blue-400',    label: 'Dashboard' },
    messaging:  { bg: 'bg-pink-500/15',    text: 'text-pink-400',    label: 'Messaging' },
    scrape:     { bg: 'bg-cyan-500/15',    text: 'text-cyan-400',    label: 'Scrape' },
  };
  const c = config[type] || { bg: 'bg-gray-500/15', text: 'text-gray-300', label: type || 'Report' };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${c.bg} ${c.text}`}>
      {c.label}
    </span>
  );
}

function ConfirmDialog({ isOpen, onClose, onConfirm, title, message, confirmLabel = 'Confirm' }) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl border border-white/10 bg-dark-800 p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0" />
          <h3 className="text-lg font-semibold text-white">{title}</h3>
        </div>
        <p className="text-sm text-gray-300 mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { onConfirm(); onClose(); }}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// KPI card + section header
// ----------------------------------------------------------------------------

function KpiCard({ icon: Icon, label, value, sublabel, tone = 'indigo' }) {
  const toneClasses = {
    indigo:   'bg-indigo-500/10 text-indigo-300',
    emerald:  'bg-emerald-500/10 text-emerald-300',
    rose:     'bg-rose-500/10 text-rose-300',
    amber:    'bg-amber-500/10 text-amber-300',
    cyan:     'bg-cyan-500/10 text-cyan-300',
    purple:   'bg-purple-500/10 text-purple-300',
  }[tone] || 'bg-indigo-500/10 text-indigo-300';

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800 p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-wider font-semibold text-gray-400">{label}</p>
        {Icon && (
          <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${toneClasses}`}>
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <p className="mt-3 text-2xl font-semibold text-white tabular-nums">
        {typeof value === 'number' ? formatNumber(value) : (value ?? '—')}
      </p>
      {sublabel && <p className="mt-1 text-xs text-gray-500">{sublabel}</p>}
    </div>
  );
}

function SectionHeader({ title, subtitle, action }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 px-4 py-3">
      <div>
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Helper: download a Blob as a file
// ----------------------------------------------------------------------------

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ----------------------------------------------------------------------------
// Pagination control
// ----------------------------------------------------------------------------

function PaginationBar({ pagination, onPageChange }) {
  if (!pagination || pagination.totalPages <= 1) return null;
  const { currentPage, totalPages, total, pageSize } = pagination;
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, total);
  return (
    <div className="px-4 py-3 border-t border-white/5 flex items-center justify-between">
      <p className="text-sm text-gray-400">
        Showing {start}–{end} of {formatNumber(total)}
      </p>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={!pagination.hasPrev}
          className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="px-2 text-sm text-gray-400">{currentPage} / {totalPages}</span>
        <button
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          disabled={!pagination.hasNext}
          className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Overview tab
// ============================================================================

function OverviewTab({ period, customRange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { period };
      if (period === 'custom' && customRange?.start && customRange?.end) {
        params.periodStart = customRange.start;
        params.periodEnd = customRange.end;
      }
      const response = await reportsAPI.overview(params);
      setData(response.data?.data || null);
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setLoading(false);
    }
  }, [period, customRange]);

  useEffect(() => { fetch(); }, [fetch]);

  if (loading) {
    return (
      <div className="rounded-xl border border-white/5 bg-dark-800 p-12 text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary-500" />
        <p className="mt-3 text-sm text-gray-400">Loading overview…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-sm text-red-300">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const all = data.allTime;
  const p   = data.periodTotals;

  return (
    <div className="space-y-6">
      {/* All-time KPI cards */}
      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-xs uppercase tracking-wider font-semibold text-gray-400">All-time totals</h3>
          <span className="text-xs text-gray-500">
            generated {formatRelativeTime(data.generatedAt)}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiCard icon={Layers} tone="indigo" label="Sessions" value={all.sessions.total}
                   sublabel={`${all.sessions.active} active · ${all.sessions.loggedIn} logged in`} />
          <KpiCard icon={Send} tone="emerald" label="Messages sent" value={all.messaging.totalSent}
                   sublabel={`${all.messaging.totalJobs} jobs · ${all.messaging.successRate}% success`} />
          <KpiCard icon={Database} tone="cyan" label="Users scraped" value={all.scraping.totalUsersFound}
                   sublabel={`${all.scraping.uniqueScrapedUsers} unique · ${all.scraping.totalJobs} jobs`} />
          <KpiCard icon={GroupIcon} tone="purple" label="Group ops" value={all.groupOperations.totalOperations}
                   sublabel={`${all.groupOperations.totalSuccess} success · ${all.groupOperations.successRate}%`} />
          <KpiCard icon={ListChecks} tone="amber" label="Lists" value={all.lists.totalLists}
                   sublabel={`${formatNumber(all.lists.totalItems)} items`} />
          <KpiCard icon={TrendingUp} tone="rose" label="Failed sends" value={all.messaging.totalFailed}
                   sublabel={`${all.messaging.totalSkipped} skipped`} />
        </div>
      </div>

      {/* Period KPI cards */}
      <div>
        <div className="mb-3">
          <h3 className="text-xs uppercase tracking-wider font-semibold text-gray-400">
            Period totals · {data.period.key}{' '}
            <span className="text-gray-600">
              ({formatDate(data.period.start)} – {formatDate(data.period.end)})
            </span>
          </h3>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiCard icon={Send}      tone="emerald" label="Sent"        value={p.messaging.sent}     sublabel={`${p.messaging.successRate}% success`} />
          <KpiCard icon={X}         tone="rose"    label="Failed"      value={p.messaging.failed}   sublabel={`${p.messaging.skipped} skipped`} />
          <KpiCard icon={MessageSquare} tone="indigo" label="Msg jobs" value={p.messaging.jobs}     sublabel={`${formatNumber(p.messaging.attempted)} attempted`} />
          <KpiCard icon={Database}  tone="cyan"    label="Scraped"     value={p.scraping.found}     sublabel={`${p.scraping.jobs} jobs · ${p.scraping.successRate}%`} />
          <KpiCard icon={GroupIcon} tone="purple"  label="Group adds"  value={p.groupOperations.success}
                   sublabel={`${p.groupOperations.failed} failed · ${p.groupOperations.successRate}%`} />
          <KpiCard icon={Activity}  tone="amber"   label="Operations"  value={p.groupOperations.ops + p.messaging.jobs + p.scraping.jobs}
                   sublabel="msg + scrape + group" />
        </div>
      </div>

      {/* Time-series charts */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="rounded-xl border border-white/5 bg-dark-800">
          <SectionHeader title="Messages over time" subtitle="Sent vs failed per day" />
          <div className="p-4 h-72">
            {data.timeSeries.length === 0 ? (
              <p className="flex h-full items-center justify-center text-sm text-gray-500">No activity in this period.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} allowDecimals={false} />
                  <RechartsTooltip contentStyle={chartTooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="sent" stroke="#22c55e" name="Sent" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="failed" stroke="#ef4444" name="Failed" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-white/5 bg-dark-800">
          <SectionHeader title="Scraping over time" subtitle="Users found per day" />
          <div className="p-4 h-72">
            {data.timeSeries.length === 0 ? (
              <p className="flex h-full items-center justify-center text-sm text-gray-500">No activity in this period.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} allowDecimals={false} />
                  <RechartsTooltip contentStyle={chartTooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="scraped" name="Users found" fill="#06b6d4" />
                  <Bar dataKey="scrapeJobs" name="Jobs" fill="#6366f1" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-white/5 bg-dark-800">
          <SectionHeader title="Group operations over time" subtitle="Adds succeeded vs failed per day" />
          <div className="p-4 h-72">
            {data.timeSeries.length === 0 ? (
              <p className="flex h-full items-center justify-center text-sm text-gray-500">No activity in this period.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} allowDecimals={false} />
                  <RechartsTooltip contentStyle={chartTooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="groupSuccess" name="Success" stackId="g" fill="#22c55e" />
                  <Bar dataKey="groupFailed"  name="Failed"  stackId="g" fill="#ef4444" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-white/5 bg-dark-800">
          <SectionHeader title="Sessions by status" subtitle="All-time" />
          <div className="p-4 h-72">
            {data.distributions.sessionsByStatus.length === 0 ? (
              <p className="flex h-full items-center justify-center text-sm text-gray-500">No sessions yet.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.distributions.sessionsByStatus}
                    dataKey="count"
                    nameKey="status"
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    label={(e) => `${e.status}: ${e.count}`}
                  >
                    {data.distributions.sessionsByStatus.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip contentStyle={chartTooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Distributions: messaging-by-type / scraping-by-type / group-ops-by-operation */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <DistributionCard title="Messaging by job type" rows={data.distributions.messagingByType}
                          columns={[
                            { key: 'jobType', label: 'Type' },
                            { key: 'jobs',    label: 'Jobs', isNumber: true },
                            { key: 'sent',    label: 'Sent', isNumber: true },
                            { key: 'failed',  label: 'Failed', isNumber: true },
                          ]} />
        <DistributionCard title="Scraping by target type" rows={data.distributions.scrapingByType}
                          columns={[
                            { key: 'targetType', label: 'Type' },
                            { key: 'jobs',       label: 'Jobs',  isNumber: true },
                            { key: 'found',      label: 'Found', isNumber: true },
                          ]} />
        <DistributionCard title="Group ops by operation" rows={data.distributions.groupOpsByOperation}
                          columns={[
                            { key: 'operation', label: 'Operation' },
                            { key: 'ops',       label: 'Ops',     isNumber: true },
                            { key: 'success',   label: 'Success', isNumber: true },
                            { key: 'failed',    label: 'Failed',  isNumber: true },
                          ]} />
      </div>

      {/* Top sessions and recent activity side by side */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="rounded-xl border border-white/5 bg-dark-800">
          <SectionHeader title="Top sessions" subtitle="Ranked by total messages sent (all-time)" />
          {data.topSessions.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-500">No data yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5 text-xs uppercase tracking-wider text-gray-400">
                  <th className="px-4 py-2 text-left">Phone</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-right">Sent</th>
                  <th className="px-4 py-2 text-right">Failed</th>
                  <th className="px-4 py-2 text-right">Scraped</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {data.topSessions.map((s) => (
                  <tr key={s.sessionId} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-2 font-medium text-white">{s.phone || `#${s.sessionId}`}</td>
                    <td className="px-4 py-2"><StatusBadge status={s.status} /></td>
                    <td className="px-4 py-2 text-right tabular-nums text-emerald-400">{formatNumber(s.totalSent)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-rose-400">{formatNumber(s.totalFailed)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-cyan-400">{formatNumber(s.totalScraped)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="rounded-xl border border-white/5 bg-dark-800">
          <SectionHeader title="Recent activity" subtitle="Last 10 events on this account" />
          {data.recentActivity.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-500">No activity recorded yet.</p>
          ) : (
            <ul className="divide-y divide-white/5">
              {data.recentActivity.map((a, i) => (
                <li key={i} className="flex items-start gap-3 px-4 py-3 text-sm">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-white">
                      <span className="font-medium">{a.action.replace(/_/g, ' ')}</span>
                      {a.entityType && <span className="text-gray-500"> · {a.entityType}</span>}
                      {a.entityId && <span className="text-gray-500"> #{a.entityId}</span>}
                    </p>
                    <p className="text-xs text-gray-500">{formatRelativeTime(a.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function DistributionCard({ title, rows, columns }) {
  return (
    <div className="rounded-xl border border-white/5 bg-dark-800">
      <SectionHeader title={title} />
      {(!rows || rows.length === 0) ? (
        <p className="p-6 text-center text-sm text-gray-500">No data in this period.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5 text-xs uppercase tracking-wider text-gray-400">
              {columns.map((c) => (
                <th key={c.key} className={`px-4 py-2 ${c.isNumber ? 'text-right' : 'text-left'}`}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map((r, i) => (
              <tr key={i} className="hover:bg-white/[0.02]">
                {columns.map((c) => (
                  <td key={c.key} className={`px-4 py-2 ${c.isNumber ? 'text-right tabular-nums text-gray-200' : 'text-white'}`}>
                    {c.isNumber ? formatNumber(r[c.key] ?? 0) : (r[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ============================================================================
// Sessions tab
// ============================================================================

function SessionsTab() {
  const [data, setData] = useState({ sessions: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState('sent');
  const limit = 20;

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await reportsAPI.sessionsSummary({ page, limit, sortBy, sortDir: 'desc' });
      setData(r.data?.data || { sessions: [], pagination: null });
    } catch {
      setData({ sessions: [], pagination: null });
    } finally {
      setLoading(false);
    }
  }, [page, sortBy]);
  useEffect(() => { fetch(); }, [fetch]);

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800">
      <SectionHeader
        title="Sessions performance"
        subtitle="All-time sends, scrapes, and group operations per session"
        action={
          <select
            value={sortBy}
            onChange={(e) => { setSortBy(e.target.value); setPage(1); }}
            className="rounded-lg border border-white/10 bg-dark-900 px-3 py-1.5 text-xs text-gray-200"
          >
            <option value="sent">Sort: Most sent</option>
            <option value="failed">Sort: Most failed</option>
            <option value="scraped">Sort: Most scraped</option>
            <option value="jobs">Sort: Most jobs</option>
            <option value="created_at">Sort: Newest</option>
          </select>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5 text-xs uppercase tracking-wider text-gray-400">
              <th className="px-4 py-2 text-left">Session</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-right">Msg jobs</th>
              <th className="px-4 py-2 text-right">Sent</th>
              <th className="px-4 py-2 text-right">Failed</th>
              <th className="px-4 py-2 text-right">Scrape jobs</th>
              <th className="px-4 py-2 text-right">Scraped</th>
              <th className="px-4 py-2 text-right">Group ops</th>
              <th className="px-4 py-2 text-right">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading ? (
              <tr><td colSpan={9} className="py-12 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-primary-500" /></td></tr>
            ) : data.sessions.length === 0 ? (
              <tr><td colSpan={9} className="py-12 text-center text-sm text-gray-500">No sessions yet.</td></tr>
            ) : data.sessions.map((s) => (
              <tr key={s.id} className="hover:bg-white/[0.02]">
                <td className="px-4 py-2 font-medium text-white">{s.phone || `#${s.id}`}</td>
                <td className="px-4 py-2"><StatusBadge status={s.status} /></td>
                <td className="px-4 py-2 text-right tabular-nums">{formatNumber(s.totalJobs)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-emerald-400">{formatNumber(s.totalSent)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-rose-400">{formatNumber(s.totalFailed)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatNumber(s.totalScrapeJobs)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-cyan-400">{formatNumber(s.totalScraped)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatNumber(s.totalGroupOps)}</td>
                <td className="px-4 py-2 text-right text-xs text-gray-500">{formatRelativeTime(s.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PaginationBar pagination={data.pagination} onPageChange={setPage} />
    </div>
  );
}

// ============================================================================
// Messaging / Scraping / GroupOps / Lists / Activity tabs
// ============================================================================

function MessagingTab({ period, customRange }) {
  const [data, setData] = useState({ jobs: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [jobType, setJobType] = useState('');
  const [status, setStatus] = useState('');
  const limit = 20;

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit };
      if (jobType) params.jobType = jobType;
      if (status)  params.status  = status;
      // Apply same period boundary the overview tab uses, when a period is given.
      if (period && period !== 'all') {
        const periodStart = customRange?.start ||
          new Date(Date.now() - {'24h':1,'7d':7,'30d':30,'90d':90,'custom':7}[period] * 24 * 3600 * 1000).toISOString();
        params.periodStart = periodStart;
        if (customRange?.end) params.periodEnd = customRange.end;
      }
      const r = await reportsAPI.messagingSummary(params);
      setData(r.data?.data || { jobs: [], pagination: null });
    } catch {
      setData({ jobs: [], pagination: null });
    } finally {
      setLoading(false);
    }
  }, [page, jobType, status, period, customRange]);
  useEffect(() => { fetch(); }, [fetch]);

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800">
      <SectionHeader
        title="Messaging jobs"
        subtitle="All bulk and single-user mass-DM jobs across your panel"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <select value={jobType} onChange={(e) => { setJobType(e.target.value); setPage(1); }}
                    className="rounded-lg border border-white/10 bg-dark-900 px-3 py-1.5 text-xs text-gray-200">
              <option value="">All types</option>
              <option value="bulk">Bulk users</option>
              <option value="single_user_mass_dm">Single-user mass DM</option>
              <option value="group">Group</option>
              <option value="schedule">Scheduled</option>
            </select>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}
                    className="rounded-lg border border-white/10 bg-dark-900 px-3 py-1.5 text-xs text-gray-200">
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="running">Running</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5 text-xs uppercase tracking-wider text-gray-400">
              <th className="px-4 py-2 text-left">#</th>
              <th className="px-4 py-2 text-left">Type</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Session</th>
              <th className="px-4 py-2 text-right">Targets</th>
              <th className="px-4 py-2 text-right">Sent</th>
              <th className="px-4 py-2 text-right">Failed</th>
              <th className="px-4 py-2 text-right">Skipped</th>
              <th className="px-4 py-2 text-right">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading ? (
              <tr><td colSpan={9} className="py-12 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-primary-500" /></td></tr>
            ) : data.jobs.length === 0 ? (
              <tr><td colSpan={9} className="py-12 text-center text-sm text-gray-500">No messaging jobs match these filters.</td></tr>
            ) : data.jobs.map((j) => (
              <tr key={j.id} className="hover:bg-white/[0.02]">
                <td className="px-4 py-2 text-gray-400 tabular-nums">#{j.id}</td>
                <td className="px-4 py-2 text-white">{j.jobType?.replace(/_/g, ' ') || '—'}</td>
                <td className="px-4 py-2"><StatusBadge status={j.status} /></td>
                <td className="px-4 py-2 text-gray-300">{j.sessionPhone || `#${j.sessionId}`}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatNumber(j.targetCount || j.totalCount || 0)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-emerald-400">{formatNumber(j.sentCount || 0)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-rose-400">{formatNumber(j.failedCount || 0)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-amber-400">{formatNumber(j.skippedCount || 0)}</td>
                <td className="px-4 py-2 text-right text-xs text-gray-500">{formatRelativeTime(j.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PaginationBar pagination={data.pagination} onPageChange={setPage} />
    </div>
  );
}

function ScrapingTab({ period, customRange }) {
  const [data, setData] = useState({ jobs: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [targetType, setTargetType] = useState('');
  const limit = 20;

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit };
      if (status) params.status = status;
      if (targetType) params.targetType = targetType;
      if (period && period !== 'all' && customRange?.start) params.periodStart = customRange.start;
      if (customRange?.end) params.periodEnd = customRange.end;
      const r = await reportsAPI.scrapingSummary(params);
      setData(r.data?.data || { jobs: [], pagination: null });
    } catch {
      setData({ jobs: [], pagination: null });
    } finally {
      setLoading(false);
    }
  }, [page, status, targetType, period, customRange]);
  useEffect(() => { fetch(); }, [fetch]);

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800">
      <SectionHeader
        title="Scraping jobs"
        subtitle="All scrape jobs run from this panel"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <select value={targetType} onChange={(e) => { setTargetType(e.target.value); setPage(1); }}
                    className="rounded-lg border border-white/10 bg-dark-900 px-3 py-1.5 text-xs text-gray-200">
              <option value="">All targets</option>
              <option value="group">Group</option>
              <option value="channel">Channel</option>
              <option value="contacts">Contacts</option>
            </select>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}
                    className="rounded-lg border border-white/10 bg-dark-900 px-3 py-1.5 text-xs text-gray-200">
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="running">Running</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5 text-xs uppercase tracking-wider text-gray-400">
              <th className="px-4 py-2 text-left">#</th>
              <th className="px-4 py-2 text-left">Target</th>
              <th className="px-4 py-2 text-left">Type</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Session</th>
              <th className="px-4 py-2 text-right">Found</th>
              <th className="px-4 py-2 text-right">Progress</th>
              <th className="px-4 py-2 text-right">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading ? (
              <tr><td colSpan={8} className="py-12 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-primary-500" /></td></tr>
            ) : data.jobs.length === 0 ? (
              <tr><td colSpan={8} className="py-12 text-center text-sm text-gray-500">No scrape jobs match these filters.</td></tr>
            ) : data.jobs.map((j) => (
              <tr key={j.id} className="hover:bg-white/[0.02]">
                <td className="px-4 py-2 text-gray-400 tabular-nums">#{j.id}</td>
                <td className="px-4 py-2 text-white">{j.targetTitle || j.targetId || '—'}</td>
                <td className="px-4 py-2 text-gray-300 capitalize">{j.targetType || '—'}</td>
                <td className="px-4 py-2"><StatusBadge status={j.status} /></td>
                <td className="px-4 py-2 text-gray-300">{j.sessionPhone || `#${j.sessionId}`}</td>
                <td className="px-4 py-2 text-right tabular-nums text-cyan-400">{formatNumber(j.totalFound || 0)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{j.progress ? `${j.progress}%` : '—'}</td>
                <td className="px-4 py-2 text-right text-xs text-gray-500">{formatRelativeTime(j.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PaginationBar pagination={data.pagination} onPageChange={setPage} />
    </div>
  );
}

function GroupOpsTab({ period, customRange }) {
  const [data, setData] = useState({ operations: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [operation, setOperation] = useState('');
  const limit = 20;

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit };
      if (status) params.status = status;
      if (operation) params.operation = operation;
      if (period && period !== 'all' && customRange?.start) params.periodStart = customRange.start;
      if (customRange?.end) params.periodEnd = customRange.end;
      const r = await reportsAPI.groupOpsSummary(params);
      setData(r.data?.data || { operations: [], pagination: null });
    } catch {
      setData({ operations: [], pagination: null });
    } finally {
      setLoading(false);
    }
  }, [page, status, operation, period, customRange]);
  useEffect(() => { fetch(); }, [fetch]);

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800">
      <SectionHeader
        title="Group operations"
        subtitle="Adds, joins, and other multi-user actions on Telegram groups"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <select value={operation} onChange={(e) => { setOperation(e.target.value); setPage(1); }}
                    className="rounded-lg border border-white/10 bg-dark-900 px-3 py-1.5 text-xs text-gray-200">
              <option value="">All operations</option>
              <option value="add">Add</option>
              <option value="kick">Kick</option>
              <option value="invite">Invite</option>
            </select>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}
                    className="rounded-lg border border-white/10 bg-dark-900 px-3 py-1.5 text-xs text-gray-200">
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="running">Running</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5 text-xs uppercase tracking-wider text-gray-400">
              <th className="px-4 py-2 text-left">#</th>
              <th className="px-4 py-2 text-left">Group</th>
              <th className="px-4 py-2 text-left">Operation</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Session</th>
              <th className="px-4 py-2 text-right">Total</th>
              <th className="px-4 py-2 text-right">Success</th>
              <th className="px-4 py-2 text-right">Failed</th>
              <th className="px-4 py-2 text-right">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading ? (
              <tr><td colSpan={9} className="py-12 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-primary-500" /></td></tr>
            ) : data.operations.length === 0 ? (
              <tr><td colSpan={9} className="py-12 text-center text-sm text-gray-500">No group operations match these filters.</td></tr>
            ) : data.operations.map((o) => (
              <tr key={o.id} className="hover:bg-white/[0.02]">
                <td className="px-4 py-2 text-gray-400 tabular-nums">#{o.id}</td>
                <td className="px-4 py-2 text-white">{o.targetGroupId || '—'}</td>
                <td className="px-4 py-2 text-gray-300 capitalize">{o.operation || o.operationType || '—'}</td>
                <td className="px-4 py-2"><StatusBadge status={o.status} /></td>
                <td className="px-4 py-2 text-gray-300">{o.sessionPhone || (o.sessionId ? `#${o.sessionId}` : '—')}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatNumber(o.totalCount || o.totalUsers || 0)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-emerald-400">{formatNumber(o.successCount || 0)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-rose-400">{formatNumber(o.failedCount || 0)}</td>
                <td className="px-4 py-2 text-right text-xs text-gray-500">{formatRelativeTime(o.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PaginationBar pagination={data.pagination} onPageChange={setPage} />
    </div>
  );
}

function ListsTab() {
  const [data, setData] = useState({ lists: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const limit = 20;

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit };
      if (type) params.type = type;
      const r = await reportsAPI.listsSummary(params);
      setData(r.data?.data || { lists: [], pagination: null });
    } catch {
      setData({ lists: [], pagination: null });
    } finally {
      setLoading(false);
    }
  }, [page, type]);
  useEffect(() => { fetch(); }, [fetch]);

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800">
      <SectionHeader
        title="Lists"
        subtitle="Saved target lists used by messaging and group operations"
        action={
          <select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}
                  className="rounded-lg border border-white/10 bg-dark-900 px-3 py-1.5 text-xs text-gray-200">
            <option value="">All types</option>
            <option value="users">Users</option>
            <option value="groups">Groups</option>
            <option value="sessions">Sessions</option>
          </select>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5 text-xs uppercase tracking-wider text-gray-400">
              <th className="px-4 py-2 text-left">#</th>
              <th className="px-4 py-2 text-left">Name</th>
              <th className="px-4 py-2 text-left">Type</th>
              <th className="px-4 py-2 text-left">Source</th>
              <th className="px-4 py-2 text-right">Items</th>
              <th className="px-4 py-2 text-right">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading ? (
              <tr><td colSpan={6} className="py-12 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-primary-500" /></td></tr>
            ) : data.lists.length === 0 ? (
              <tr><td colSpan={6} className="py-12 text-center text-sm text-gray-500">No lists yet.</td></tr>
            ) : data.lists.map((l) => (
              <tr key={l.id} className="hover:bg-white/[0.02]">
                <td className="px-4 py-2 text-gray-400 tabular-nums">#{l.id}</td>
                <td className="px-4 py-2 text-white">{l.name || '—'}</td>
                <td className="px-4 py-2 text-gray-300 capitalize">{l.type || '—'}</td>
                <td className="px-4 py-2 text-gray-300">{l.source || '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatNumber(l.itemsCount || 0)}</td>
                <td className="px-4 py-2 text-right text-xs text-gray-500">{formatRelativeTime(l.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PaginationBar pagination={data.pagination} onPageChange={setPage} />
    </div>
  );
}

function ActivityTab() {
  const [data, setData] = useState({ activities: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const limit = 25;

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit };
      if (action) params.action = action;
      if (entityType) params.entityType = entityType;
      const r = await reportsAPI.activity(params);
      setData(r.data?.data || { activities: [], pagination: null });
    } catch {
      setData({ activities: [], pagination: null });
    } finally {
      setLoading(false);
    }
  }, [page, action, entityType]);
  useEffect(() => { fetch(); }, [fetch]);

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800">
      <SectionHeader
        title="Activity log"
        subtitle="Audit trail of every action taken from this panel"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <select value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1); }}
                    className="rounded-lg border border-white/10 bg-dark-900 px-3 py-1.5 text-xs text-gray-200">
              <option value="">All entities</option>
              <option value="session">Session</option>
              <option value="messaging_job">Messaging job</option>
              <option value="scrape_job">Scrape job</option>
              <option value="group">Group</option>
              <option value="list">List</option>
              <option value="report">Report</option>
            </select>
            <input value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}
                   placeholder="Filter action…"
                   className="rounded-lg border border-white/10 bg-dark-900 px-3 py-1.5 text-xs text-gray-200 placeholder-gray-500" />
          </div>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5 text-xs uppercase tracking-wider text-gray-400">
              <th className="px-4 py-2 text-left">When</th>
              <th className="px-4 py-2 text-left">Action</th>
              <th className="px-4 py-2 text-left">Entity</th>
              <th className="px-4 py-2 text-left">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading ? (
              <tr><td colSpan={4} className="py-12 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-primary-500" /></td></tr>
            ) : data.activities.length === 0 ? (
              <tr><td colSpan={4} className="py-12 text-center text-sm text-gray-500">No activity recorded yet.</td></tr>
            ) : data.activities.map((a) => (
              <tr key={a.id} className="hover:bg-white/[0.02]">
                <td className="px-4 py-2 text-gray-400 whitespace-nowrap">{formatDateTime(a.createdAt)}</td>
                <td className="px-4 py-2 text-white">{a.action.replace(/_/g, ' ')}</td>
                <td className="px-4 py-2 text-gray-300">
                  {a.entityType ? `${a.entityType}${a.entityId ? ` #${a.entityId}` : ''}` : '—'}
                </td>
                <td className="px-4 py-2 text-xs text-gray-400 max-w-xl truncate">
                  {a.details && Object.keys(a.details).length > 0
                    ? JSON.stringify(a.details)
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PaginationBar pagination={data.pagination} onPageChange={setPage} />
    </div>
  );
}

// ============================================================================
// Saved Reports tab (preserves the legacy per-target generator)
// ============================================================================

function SavedReportsTab() {
  const { error: showError, success: showSuccess } = useToast();

  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [genType, setGenType] = useState('channel');
  const [genTargetId, setGenTargetId] = useState('');
  const [genDateFrom, setGenDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [genDateTo, setGenDateTo] = useState(() => new Date().toISOString().split('T')[0]);
  const [generating, setGenerating] = useState(false);

  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsSearch, setReportsSearch] = useState('');
  const [reportsPage, setReportsPage] = useState(1);
  const reportsPageSize = 8;

  const [viewReport, setViewReport] = useState(null);
  const [exportTarget, setExportTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const fetchReports = async () => {
    setReportsLoading(true);
    try {
      const response = await reportsAPI.saved();
      setReports(response.data.data?.reports || []);
    } catch {
      setReports([]);
    } finally {
      setReportsLoading(false);
    }
  };
  useEffect(() => { fetchReports(); }, []);

  const filteredReports = reports.filter((r) => {
    const target = r?.target || '';
    const type = r?.type || '';
    return target.toLowerCase().includes(reportsSearch.toLowerCase()) ||
           type.toLowerCase().includes(reportsSearch.toLowerCase());
  });
  const totalReportPages = Math.ceil(filteredReports.length / reportsPageSize);
  const pagedReports = filteredReports.slice(
    (reportsPage - 1) * reportsPageSize,
    reportsPage * reportsPageSize
  );

  const handleGenerate = async () => {
    if (!genTargetId.trim()) {
      showError('Please enter a target ID.', 'Validation Error');
      return;
    }
    setGenerating(true);
    try {
      const apiFn = reportsAPI[genType];
      if (apiFn) {
        const params = {};
        if (genDateFrom && genDateTo) {
          params.period = 'custom';
          params.periodStart = genDateFrom;
          params.periodEnd = genDateTo;
        }
        const response = await apiFn(genTargetId.trim(), params);
        if (response.data.data) {
          try {
            const reportData = response.data.data;
            await reportsAPI.save({
              reportType: genType,
              targetId: genTargetId.trim(),
              targetTitle: genTargetId.trim(),
              periodStart: params.periodStart || reportData.period?.start,
              periodEnd:   params.periodEnd   || reportData.period?.end,
              data: reportData,
            });
          } catch (saveErr) {
            console.warn('Failed to save report:', saveErr);
          }
        }
        showSuccess(`Report generated for "${genTargetId}".`, 'Report Ready');
        setShowGenerateModal(false);
        setGenTargetId('');
        fetchReports();
      } else {
        showError('Unknown report type.');
      }
    } catch (err) {
      showError(parseApiError(err), 'Failed to generate report');
    } finally {
      setGenerating(false);
    }
  };

  const handleExport = async (report, format) => {
    try {
      const response = await reportsAPI.exportReport(report.id, format);
      const mimeType = format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/plain';
      const blob = new Blob([response.data], { type: mimeType });
      downloadBlob(blob, `report_${report.target_id || report.id}.${format}`);
      showSuccess(`Exported as ${format.toUpperCase()}.`, 'Export Complete');
    } catch (err) {
      showError(parseApiError(err), 'Export failed');
    }
    setExportTarget(null);
  };

  const handleDelete = async (report) => {
    try {
      await reportsAPI.deleteSaved(report.id);
      showSuccess('Report deleted.', 'Deleted');
      fetchReports();
    } catch (err) {
      showError(parseApiError(err), 'Delete failed');
    }
  };

  const selectedTypeConfig = REPORT_TYPES.find((t) => t.value === genType);

  return (
    <>
      <div className="rounded-xl border border-white/5 bg-dark-800 shadow-sm">
        <SectionHeader
          title="Saved reports"
          subtitle="Per-target reports (channel, group, user, session) generated and stored for later"
          action={
            <button
              onClick={() => setShowGenerateModal(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700"
            >
              <Plus className="h-4 w-4" />
              Generate report
            </button>
          }
        />

        <div className="border-b border-white/5 p-3">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <input
              type="text"
              value={reportsSearch}
              onChange={(e) => { setReportsSearch(e.target.value); setReportsPage(1); }}
              placeholder="Search saved reports…"
              className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 pl-10 pr-4 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5 text-xs uppercase tracking-wider text-gray-400">
                <th className="px-4 py-3 text-left">Type</th>
                <th className="px-4 py-3 text-left">Target</th>
                <th className="px-4 py-3 text-left hidden md:table-cell">Period</th>
                <th className="px-4 py-3 text-left hidden lg:table-cell">Generated</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {reportsLoading ? (
                <tr><td colSpan={5} className="py-16 text-center"><Loader2 className="mx-auto h-8 w-8 animate-spin text-primary-500" /></td></tr>
              ) : pagedReports.length === 0 ? (
                <tr><td colSpan={5} className="py-16 text-center">
                  <FileText className="mx-auto mb-3 h-10 w-10 text-gray-600" />
                  <p className="text-sm text-gray-400">No saved reports yet</p>
                  <p className="mt-1 text-xs text-gray-500">Use “Generate report” above to create one</p>
                </td></tr>
              ) : pagedReports.map((report) => (
                <tr key={report.id} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3"><TypeBadge type={report.type || 'session'} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Target className="h-3.5 w-3.5 text-gray-500 shrink-0" />
                      <span className="text-sm font-medium text-white">{report.target || 'Unknown'}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400 hidden md:table-cell">
                    {report.period ? `${formatDate(report.period.from)} — ${formatDate(report.period.to)}` : 'N/A'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400 hidden lg:table-cell">
                    {report.generatedAt ? formatRelativeTime(report.generatedAt) : 'N/A'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button onClick={() => setViewReport(report)} className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-blue-400" title="View">
                        <Eye className="h-4 w-4" />
                      </button>
                      <div className="relative">
                        <button onClick={() => setExportTarget(exportTarget?.id === report.id ? null : report)}
                                className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-green-400" title="Export">
                          <Download className="h-4 w-4" />
                        </button>
                        {exportTarget?.id === report.id && (
                          <div className="absolute right-0 top-full mt-1 z-20 w-36 rounded-lg border border-white/10 bg-dark-800 p-1 shadow-xl">
                            {['csv', 'json'].map((fmt) => (
                              <button key={fmt} onClick={() => handleExport(report, fmt)}
                                      className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-white/5">
                                {fmt === 'csv' ? <FileText className="h-3.5 w-3.5" /> : <FileJson className="h-3.5 w-3.5" />}
                                .{fmt.toUpperCase()}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <button onClick={() => setDeleteTarget(report)} className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-red-400" title="Delete">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalReportPages > 1 && (
          <PaginationBar
            pagination={{
              currentPage: reportsPage,
              totalPages: totalReportPages,
              total: filteredReports.length,
              pageSize: reportsPageSize,
              hasPrev: reportsPage > 1,
              hasNext: reportsPage < totalReportPages,
            }}
            onPageChange={setReportsPage}
          />
        )}
      </div>

      <Modal
        isOpen={showGenerateModal}
        onClose={() => setShowGenerateModal(false)}
        title="Generate Report"
        size="md"
        footer={
          <div className="flex justify-end gap-3">
            <button onClick={() => setShowGenerateModal(false)}
                    className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5">
              Cancel
            </button>
            <button onClick={handleGenerate}
                    disabled={generating || !genTargetId.trim()}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed">
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}
              {generating ? 'Generating…' : 'Generate'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-300">Report Type</label>
            <div className="grid grid-cols-2 gap-2">
              {REPORT_TYPES.map((type) => {
                const Icon = type.icon;
                const selected = genType === type.value;
                return (
                  <button key={type.value} onClick={() => setGenType(type.value)}
                          className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium transition-all ${
                            selected
                              ? 'border-primary-500 bg-primary-600/10 text-white'
                              : 'border-white/10 bg-dark-900 text-gray-400 hover:bg-white/5 hover:text-white'
                          }`}>
                    <Icon className="h-4 w-4" />
                    {type.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">Target ID</label>
            <input type="text" value={genTargetId} onChange={(e) => setGenTargetId(e.target.value)}
                   placeholder={
                     genType === 'user' ? 'e.g., @username or user ID' :
                     genType === 'session' ? 'e.g., session-7' :
                     'e.g., -1001234567890'
                   }
                   className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500" />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-300">Date Range</label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-gray-500">From</label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                  <input type="date" value={genDateFrom} onChange={(e) => setGenDateFrom(e.target.value)}
                         className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 pl-10 pr-3 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500" />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">To</label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                  <input type="date" value={genDateTo} onChange={(e) => setGenDateTo(e.target.value)}
                         className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 pl-10 pr-3 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!viewReport} onClose={() => setViewReport(null)}
             title={viewReport ? `Report: ${viewReport.target || 'Unknown'}` : 'Report Details'} size="xl">
        {viewReport && (
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-dark-900 p-4 text-xs text-gray-300">
            {JSON.stringify(viewReport.data || viewReport, null, 2)}
          </pre>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => handleDelete(deleteTarget)}
        title="Delete report?"
        message={deleteTarget ? `This will permanently delete the saved report for "${deleteTarget.target || deleteTarget.id}".` : ''}
        confirmLabel="Delete"
      />
    </>
  );
}

// ============================================================================
// Page wrapper
// ============================================================================

export default function Reports() {
  const { success: showSuccess, error: showError } = useToast();

  // Global period filter (drives Overview + per-tab range hints).
  const [period, setPeriod] = useState('7d');
  const [customRange, setCustomRange] = useState(() => {
    const d = new Date();
    const end = d.toISOString().split('T')[0];
    d.setDate(d.getDate() - 7);
    const start = d.toISOString().split('T')[0];
    return { start, end };
  });

  const [activeTab, setActiveTab] = useState('overview');
  const [refreshKey, setRefreshKey] = useState(0);
  const [exporting, setExporting] = useState(false);

  const handleExportOverview = async (format) => {
    setExporting(true);
    try {
      const params = { period, format };
      if (period === 'custom' && customRange?.start && customRange?.end) {
        params.periodStart = customRange.start;
        params.periodEnd = customRange.end;
      }
      const response = await reportsAPI.exportOverview(params);
      const mimeType = format === 'json' ? 'application/json' : 'text/csv';
      const blob = new Blob([response.data], { type: mimeType });
      const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      downloadBlob(blob, `panel_overview_${period}_${stamp}.${format}`);
      showSuccess(`Overview exported as ${format.toUpperCase()}.`, 'Export complete');
    } catch (err) {
      showError(parseApiError(err), 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const tabPropKey = `${period}-${customRange?.start}-${customRange?.end}-${refreshKey}`;

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Reports</h1>
          <p className="mt-1 text-sm text-gray-400">
            Panel-wide analytics, audit trail, and per-target reports.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-gray-500" />
            <select value={period} onChange={(e) => setPeriod(e.target.value)}
                    className="rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-200">
              {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          {period === 'custom' && (
            <div className="flex items-center gap-2">
              <input type="date" value={customRange.start}
                     onChange={(e) => setCustomRange((r) => ({ ...r, start: e.target.value }))}
                     className="rounded-lg border border-white/10 bg-dark-900 px-2 py-2 text-sm text-gray-200" />
              <span className="text-xs text-gray-500">→</span>
              <input type="date" value={customRange.end}
                     onChange={(e) => setCustomRange((r) => ({ ...r, end: e.target.value }))}
                     className="rounded-lg border border-white/10 bg-dark-900 px-2 py-2 text-sm text-gray-200" />
            </div>
          )}
          <button onClick={() => setRefreshKey((k) => k + 1)}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <div className="relative">
            <button onClick={() => handleExportOverview('csv')} disabled={exporting}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Export CSV
            </button>
          </div>
          <button onClick={() => handleExportOverview('json')} disabled={exporting}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5 disabled:opacity-50">
            <FileJson className="h-4 w-4" />
            JSON
          </button>
        </div>
      </div>

      {/* Tabs (horizontally scrollable on small screens) */}
      <div className="rounded-xl border border-white/5 bg-dark-800 overflow-hidden">
        <div
          className="flex flex-nowrap overflow-x-auto md:overflow-visible border-b border-white/5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10"
          role="tablist"
          aria-label="Reports sections"
        >
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.value;
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(t.value)}
                className={`shrink-0 md:flex-1 whitespace-nowrap px-4 sm:px-5 py-3 text-sm font-medium transition flex items-center justify-center gap-2 ${
                  active
                    ? 'border-b-2 border-primary-500 text-primary-400 bg-primary-500/5'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <Icon className="w-4 h-4" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview'  && <OverviewTab    key={tabPropKey} period={period} customRange={customRange} />}
      {activeTab === 'sessions'  && <SessionsTab    key={tabPropKey} />}
      {activeTab === 'messaging' && <MessagingTab   key={tabPropKey} period={period} customRange={customRange} />}
      {activeTab === 'scraping'  && <ScrapingTab    key={tabPropKey} period={period} customRange={customRange} />}
      {activeTab === 'groupOps'  && <GroupOpsTab    key={tabPropKey} period={period} customRange={customRange} />}
      {activeTab === 'lists'     && <ListsTab       key={tabPropKey} />}
      {activeTab === 'activity'  && <ActivityTab    key={tabPropKey} />}
      {activeTab === 'saved'     && <SavedReportsTab key={tabPropKey} />}
    </div>
  );
}
