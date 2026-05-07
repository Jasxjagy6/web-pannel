import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePolling } from '../hooks/usePolling';
import { dashboardAPI } from '@/api';
import { parseApiError, formatNumber, formatRelativeTime } from '@/utils/formatters';
import { useToast } from '../components/common/Toast';
import {
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  BarChart3,
  MessageSquare,
  Users,
  Send,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  ArrowRight,
  Upload,
  Search,
  Mail,
  Clock,
  UserPlus,
  FileText,
  Play,
  Pause,
  CheckCircle,
  AlertCircle,
  TrendingUp,
  Layers,
  ShieldCheck,
  Zap,
  Sparkles,
  Target,
  Database,
  AlertTriangle,
} from 'lucide-react';

/* ---------- Constants ---------- */

const PERIODS = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
];

const SESSION_PIE = {
  active: '#22c55e',
  loggedIn: '#3b82f6',
  uploaded: '#a855f7',
  inactive: '#94a3b8',
  error: '#ef4444',
};

const CHART_TOOLTIP_STYLE = {
  backgroundColor: 'rgba(2, 6, 23, 0.95)',
  border: '1px solid rgba(148, 163, 184, 0.2)',
  borderRadius: '10px',
  padding: '8px 12px',
  color: '#e2e8f0',
  fontSize: '12px',
  boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
};

/* ---------- Small primitives ---------- */

function Pill({ children, tone = 'neutral', className = '' }) {
  const tones = {
    neutral: 'bg-white/5 text-gray-300 border-white/10',
    success: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
    danger: 'bg-rose-500/10 text-rose-300 border-rose-500/20',
    warning: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
    info: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
    brand: 'bg-primary-500/10 text-primary-300 border-primary-500/20',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone] || tones.neutral} ${className}`}
    >
      {children}
    </span>
  );
}

function Panel({ title, icon: Icon, children, action, className = '', dense = false }) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-white/10 bg-dark-900/60 backdrop-blur-sm shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] ${className}`}
    >
      {(title || action) && (
        <div className={`flex items-center justify-between gap-3 ${dense ? 'px-4 pt-4 pb-2' : 'px-5 pt-5 pb-3'}`}>
          <div className="flex min-w-0 items-center gap-2">
            {Icon && (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/5 text-primary-300 ring-1 ring-white/10">
                <Icon className="h-4 w-4" />
              </div>
            )}
            <h2 className="truncate text-sm font-semibold tracking-wide text-gray-100">{title}</h2>
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className={dense ? 'px-4 pb-4' : 'px-5 pb-5'}>{children}</div>
    </div>
  );
}

function Sparkline({ data, color = '#60a5fa', height = 36, gradId = 'sl' }) {
  if (!data || data.length < 2) {
    return <div style={{ height }} />;
  }
  return (
    <div style={{ width: '100%', height }} className="-ml-1">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.45} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.75}
            fill={`url(#${gradId})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function TrendBadge({ value, suffix = '%' }) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const up = value > 0;
  const flat = value === 0;
  const tone = flat ? 'neutral' : up ? 'success' : 'danger';
  const Icon = flat ? ArrowRight : up ? ArrowUpRight : ArrowDownRight;
  const display = flat ? '0' : `${up ? '+' : ''}${value.toFixed(1)}`;
  return (
    <Pill tone={tone}>
      <Icon className="h-3 w-3" />
      {display}
      {suffix}
    </Pill>
  );
}

/* ---------- KPI Tile ---------- */

function StatTile({
  icon: Icon,
  label,
  value,
  loading,
  trend,
  meta,
  spark,
  sparkColor,
  sparkId,
  gradient = 'from-primary-500/30 via-primary-500/0 to-primary-500/0',
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-white/10 bg-dark-900/60 p-4 backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-white/20 hover:bg-dark-900/80">
      <div
        aria-hidden
        className={`pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-gradient-to-br ${gradient} blur-2xl opacity-70 transition-opacity duration-300 group-hover:opacity-100`}
      />
      <div className="relative flex items-start justify-between gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/5 text-primary-200 ring-1 ring-white/10">
          <Icon className="h-4 w-4" />
        </div>
        {trend}
      </div>
      <div className="relative mt-4">
        {loading ? (
          <div className="h-8 w-24 animate-pulse rounded bg-white/10" />
        ) : (
          <p className="font-mono text-3xl font-semibold tracking-tight text-white tabular-nums">
            {typeof value === 'string' ? value : formatNumber(value ?? 0)}
          </p>
        )}
        <p className="mt-1 text-xs uppercase tracking-wider text-gray-400">{label}</p>
        {meta && <p className="mt-1.5 text-[11px] text-gray-500">{meta}</p>}
      </div>
      {spark && spark.length > 1 && (
        <div className="relative mt-3">
          <Sparkline data={spark} color={sparkColor || '#60a5fa'} gradId={sparkId || 'spark-default'} />
        </div>
      )}
    </div>
  );
}

/* ---------- Activity / Quick Actions ---------- */

const ACTIVITY_CONFIG = {
  session_login: { icon: Play, color: 'text-emerald-300', bg: 'bg-emerald-500/10', ring: 'ring-emerald-500/20' },
  session_logout: { icon: Pause, color: 'text-amber-300', bg: 'bg-amber-500/10', ring: 'ring-amber-500/20' },
  session_upload: { icon: Upload, color: 'text-sky-300', bg: 'bg-sky-500/10', ring: 'ring-sky-500/20' },
  session_delete: { icon: AlertCircle, color: 'text-rose-300', bg: 'bg-rose-500/10', ring: 'ring-rose-500/20' },
  scrape_start: { icon: Search, color: 'text-violet-300', bg: 'bg-violet-500/10', ring: 'ring-violet-500/20' },
  scrape_complete: { icon: CheckCircle, color: 'text-emerald-300', bg: 'bg-emerald-500/10', ring: 'ring-emerald-500/20' },
  scrape_cancel: { icon: AlertCircle, color: 'text-orange-300', bg: 'bg-orange-500/10', ring: 'ring-orange-500/20' },
  message_send: { icon: Send, color: 'text-indigo-300', bg: 'bg-indigo-500/10', ring: 'ring-indigo-500/20' },
  message_bulk: { icon: Mail, color: 'text-cyan-300', bg: 'bg-cyan-500/10', ring: 'ring-cyan-500/20' },
  group_add: { icon: UserPlus, color: 'text-fuchsia-300', bg: 'bg-fuchsia-500/10', ring: 'ring-fuchsia-500/20' },
  list_import: { icon: FileText, color: 'text-teal-300', bg: 'bg-teal-500/10', ring: 'ring-teal-500/20' },
  report_generate: { icon: BarChart3, color: 'text-sky-300', bg: 'bg-sky-500/10', ring: 'ring-sky-500/20' },
  tg_client_clear_all_chats: { icon: AlertCircle, color: 'text-rose-300', bg: 'bg-rose-500/10', ring: 'ring-rose-500/20' },
};

function getActivityVisual(activity) {
  return (
    ACTIVITY_CONFIG[activity.action] || {
      icon: Activity,
      color: 'text-gray-300',
      bg: 'bg-white/5',
      ring: 'ring-white/10',
    }
  );
}

function getActivityDescription(activity) {
  const action = activity.action || '';
  const details = activity.details || {};
  switch (action) {
    case 'session_login':
      return details.phone ? `Logged in session: ${details.phone}` : 'Session logged in successfully';
    case 'session_logout':
      return details.phone ? `Logged out session: ${details.phone}` : 'Session logged out';
    case 'session_upload':
      return details.count ? `Uploaded ${details.count} session file(s)` : 'Uploaded session file(s)';
    case 'session_delete':
      return `Session ${details.id || ''} deleted`;
    case 'scrape_start':
      return details.targetId ? `Started scraping: ${details.targetId}` : 'Scrape task started';
    case 'scrape_complete':
      return details.targetId ? `Scrape completed for: ${details.targetId}` : 'Scrape task completed';
    case 'scrape_cancel':
      return 'Scrape task cancelled';
    case 'message_send':
      return details.targetId ? `Message sent to: ${details.targetId}` : 'Message sent';
    case 'message_bulk':
      return `Bulk messaging: ${details.sent ?? '?'} sent, ${details.failed ?? 0} failed`;
    case 'group_add':
      return details.targetGroupId ? `Adding members to group: ${details.targetGroupId}` : 'Group add operation';
    case 'list_import':
      return details.listName ? `Imported list: ${details.listName}` : 'List imported';
    case 'report_generate':
      return details.reportType ? `Generated ${details.reportType} report` : 'Report generated';
    case 'tg_client_clear_all_chats':
      return `Cleared chats across ${details.sessionCount ?? '?'} session(s)`;
    default:
      return details.description || activity.action || 'Unknown activity';
  }
}

function ActivityRow({ activity, isLast }) {
  const { icon: Icon, color, bg, ring } = getActivityVisual(activity);
  return (
    <div className="relative flex gap-3 pb-4 last:pb-0">
      {!isLast && (
        <span
          aria-hidden
          className="absolute bottom-0 left-[15px] top-9 w-px bg-gradient-to-b from-white/10 to-transparent"
        />
      )}
      <div
        className={`relative z-[1] flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full ${bg} ring-1 ${ring}`}
      >
        <Icon className={`h-3.5 w-3.5 ${color}`} />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-sm leading-snug text-gray-200">{getActivityDescription(activity)}</p>
        <p className="mt-0.5 text-[11px] text-gray-500">{formatRelativeTime(activity.created_at)}</p>
      </div>
    </div>
  );
}

const QUICK_ACTION_ICON_MAP = {
  login: Play,
  scrape: Search,
  message: Mail,
  bulk_message: Send,
  group_message: Users,
  forward: ArrowUpRight,
  error: AlertCircle,
  running: Activity,
  pending: Clock,
  import: Upload,
  list_create: FileText,
  report: BarChart3,
};

function QuickActionCard({ action, Icon, urgent, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`group flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-all duration-150 ${
        urgent
          ? 'border-rose-500/30 bg-rose-500/10 hover:border-rose-500/50 hover:bg-rose-500/15'
          : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]'
      }`}
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ${
          urgent
            ? 'bg-rose-500/15 text-rose-200 ring-rose-500/30'
            : 'bg-primary-500/10 text-primary-200 ring-primary-500/20 group-hover:bg-primary-500/15'
        }`}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-gray-100">{action.label}</div>
        {action.description && (
          <div className="truncate text-[11px] text-gray-500">{action.description}</div>
        )}
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-gray-500 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-gray-300" />
    </button>
  );
}

/* ---------- Performance bars ---------- */

function HBar({ label, value, total, tone = 'brand' }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  const tones = {
    brand: 'from-primary-500 to-indigo-500',
    success: 'from-emerald-500 to-teal-500',
    warning: 'from-amber-500 to-orange-500',
    danger: 'from-rose-500 to-pink-500',
    info: 'from-sky-500 to-cyan-500',
    purple: 'from-violet-500 to-fuchsia-500',
    muted: 'from-slate-500 to-slate-600',
  };
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs text-gray-400">{label}</span>
        <span className="font-mono text-xs font-semibold text-gray-200 tabular-nums">{formatNumber(value || 0)}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${tones[tone] || tones.brand}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* ---------- Main page ---------- */

export default function Dashboard() {
  const navigate = useNavigate();
  const { error: showError } = useToast();

  const [period, setPeriod] = useState('7d');
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [activities, setActivities] = useState([]);
  const [quickActions, setQuickActions] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const response = await dashboardAPI.stats({ period });
      const data = response.data.data;
      setStats(data);
      setLastUpdated(new Date());
    } catch (err) {
      showError(parseApiError(err), 'Failed to load stats');
    } finally {
      setStatsLoading(false);
    }
  }, [period, showError]);

  const fetchActivities = useCallback(async () => {
    try {
      const response = await dashboardAPI.activity({ limit: 12 });
      const data = response.data.data;
      if (data?.activities?.length > 0) {
        setActivities(data.activities);
      } else {
        setActivities([]);
      }
    } catch (err) {
      console.warn('Failed to fetch activities:', parseApiError(err));
    }
  }, []);

  const fetchQuickActions = useCallback(async () => {
    try {
      const response = await dashboardAPI.quickActions();
      const data = response.data.data;
      if (data?.actions?.length > 0) {
        setQuickActions(data.actions);
      } else {
        setQuickActions([]);
      }
    } catch (err) {
      console.warn('Failed to fetch quick actions:', parseApiError(err));
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchActivities();
    fetchQuickActions();
  }, [fetchActivities, fetchQuickActions]);

  usePolling(fetchData, 30000, true);
  usePolling(fetchActivities, 60000, true);

  const handleQuickAction = (action) => {
    switch (action) {
      case 'login_session':
      case 'login_sessions':
      case 'check_errors':
        navigate('/sessions');
        break;
      case 'scrape_group':
      case 'scrape_channel':
      case 'view_running_scrapes':
      case 'view_pending_scrapes':
        navigate('/scrape');
        break;
      case 'send_message':
      case 'bulk_message':
      case 'send_to_group':
      case 'forward_message':
      case 'view_running_messages':
        navigate('/messaging');
        break;
      case 'import_list':
      case 'create_list_from_scrape':
        navigate('/lists');
        break;
      case 'generate_report':
        navigate('/reports');
        break;
      default:
        break;
    }
  };

  /* ---------- Derived values ---------- */

  const ss = stats?.sessionStats || {};
  const overview = stats?.overview || {};
  const messaging = overview.messaging || {};
  const scraping = overview.scraping || {};
  const messagingStats = stats?.messagingStats || {};
  const scrapeStats = stats?.scrapeStats || {};

  const totalSessions = ss.total ?? 0;
  const loggedInSessions = ss.loggedIn ?? 0;
  const activeSessions = ss.active ?? 0;
  const errorSessions = ss.error ?? 0;

  const messagesToday = messaging.today ?? 0;
  const messagesWeek = messaging.thisWeek ?? 0;

  const scrapeRunning = scrapeStats.runningJobs ?? 0;
  const scrapePending = scrapeStats.pendingJobs ?? 0;
  const scrapeCompleted = scrapeStats.completedJobs ?? 0;
  const scrapeFailed = scrapeStats.failedJobs ?? 0;
  const totalScraped = scraping.totalUsersFound ?? scrapeStats.totalUsersScraped ?? 0;

  const msgSuccessRate = Number(messaging.successRate ?? messagingStats.successRate ?? 0);
  const scrapeSuccessRate = Number(scraping.successRate ?? scrapeStats.successRate ?? 0);

  const dailyStats = useMemo(() => messagingStats.dailyStats || [], [messagingStats.dailyStats]);

  const messages7d = useMemo(() => {
    const slice = dailyStats.slice(-7);
    return slice.map((d) => ({
      date: d.date,
      day: new Date(d.date).toLocaleDateString('en', { weekday: 'short' }),
      messages: d.sent || 0,
      failed: d.failed || 0,
    }));
  }, [dailyStats]);

  const messagesSpark = useMemo(
    () => messages7d.map((d) => ({ x: d.day, value: d.messages })),
    [messages7d]
  );

  const messages7dTotal = useMemo(
    () => messages7d.reduce((acc, d) => acc + (d.messages || 0), 0),
    [messages7d]
  );

  const messagesPriorWeekTotal = useMemo(() => {
    const slice = dailyStats.slice(-14, -7);
    return slice.reduce((acc, d) => acc + (d.sent || 0), 0);
  }, [dailyStats]);

  const messagesWeekTrend = useMemo(() => {
    if (messagesPriorWeekTotal <= 0) return null;
    return ((messages7dTotal - messagesPriorWeekTotal) / messagesPriorWeekTotal) * 100;
  }, [messages7dTotal, messagesPriorWeekTotal]);

  const sessionStatusData = useMemo(() => {
    return [
      { name: 'Logged in', value: loggedInSessions, color: SESSION_PIE.loggedIn },
      { name: 'Active', value: Math.max(0, (ss.active || 0) - loggedInSessions), color: SESSION_PIE.active },
      { name: 'Uploaded', value: ss.uploaded || 0, color: SESSION_PIE.uploaded },
      { name: 'Error', value: ss.error || 0, color: SESSION_PIE.error },
      { name: 'Inactive', value: ss.inactive || 0, color: SESSION_PIE.inactive },
    ].filter((d) => d.value > 0);
  }, [ss, loggedInSessions]);

  const totalPie = useMemo(
    () => sessionStatusData.reduce((acc, d) => acc + d.value, 0),
    [sessionStatusData]
  );

  const groupedQuickActions = useMemo(() => {
    const groups = { sessions: [], scraping: [], messaging: [], lists: [], reports: [] };
    for (const a of quickActions) {
      const cat = a.category || 'reports';
      if (groups[cat]) groups[cat].push(a);
    }
    return groups;
  }, [quickActions]);

  const lastUpdatedLabel = lastUpdated
    ? lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

  /* ---------- Render ---------- */

  return (
    <div className="space-y-6">
      {/* Hero header */}
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-dark-900/80 via-dark-900/40 to-dark-900/80 px-5 py-5 sm:px-6 sm:py-6">
        <div
          aria-hidden
          className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full bg-primary-500/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -right-32 h-72 w-72 rounded-full bg-indigo-500/15 blur-3xl"
        />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-primary-300/80">
              <Sparkles className="h-3.5 w-3.5" />
              Telegram Control Center
            </div>
            <h1 className="mt-1.5 text-3xl font-semibold tracking-tight text-white">Dashboard</h1>
            <p className="mt-1 max-w-xl text-sm text-gray-400">
              Operational overview across sessions, scraping, and messaging — refreshed in near real-time.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <div className="inline-flex rounded-xl border border-white/10 bg-white/5 p-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPeriod(p.id)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
                    period === p.id
                      ? 'bg-primary-500/20 text-primary-100 shadow-[inset_0_0_0_1px_rgba(96,165,250,0.35)]'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              <span className="text-gray-400">Updated</span>
              <span className="font-mono text-gray-100 tabular-nums">{lastUpdatedLabel}</span>
            </div>
          </div>
        </div>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile
          icon={Layers}
          label="Total Sessions"
          value={totalSessions}
          loading={statsLoading}
          gradient="from-primary-500/30 via-primary-500/0 to-primary-500/0"
          meta={`${formatNumber(loggedInSessions)} logged in`}
        />
        <StatTile
          icon={ShieldCheck}
          label="Logged In"
          value={loggedInSessions}
          loading={statsLoading}
          gradient="from-emerald-500/30 via-emerald-500/0 to-emerald-500/0"
          meta={
            totalSessions > 0
              ? `${Math.round((loggedInSessions / totalSessions) * 100)}% of pool`
              : 'No sessions yet'
          }
        />
        <StatTile
          icon={Users}
          label="Scraped Users"
          value={totalScraped}
          loading={statsLoading}
          gradient="from-violet-500/30 via-violet-500/0 to-violet-500/0"
          meta={
            scrapeStats.totalJobs
              ? `${formatNumber(scrapeStats.totalJobs)} job${scrapeStats.totalJobs === 1 ? '' : 's'} run`
              : 'No scrape jobs yet'
          }
        />
        <StatTile
          icon={Send}
          label="Messages Today"
          value={messagesToday}
          loading={statsLoading}
          gradient="from-sky-500/30 via-sky-500/0 to-sky-500/0"
          meta={messagesWeek ? `${formatNumber(messagesWeek)} this week` : 'No messages yet'}
          spark={messagesSpark}
          sparkColor="#38bdf8"
          sparkId="spark-msg"
          trend={messagesWeekTrend !== null ? <TrendBadge value={messagesWeekTrend} /> : null}
        />
        <StatTile
          icon={Zap}
          label="Active Jobs"
          value={scrapeRunning + scrapePending}
          loading={statsLoading}
          gradient="from-amber-500/30 via-amber-500/0 to-amber-500/0"
          meta={`${formatNumber(scrapeRunning)} running · ${formatNumber(scrapePending)} pending`}
        />
        <StatTile
          icon={Target}
          label="Msg Success"
          value={`${msgSuccessRate.toFixed(1)}%`}
          loading={statsLoading}
          gradient="from-rose-500/30 via-rose-500/0 to-rose-500/0"
          meta={
            messagingStats.totalSent
              ? `${formatNumber(messagingStats.totalSent)} sent / ${formatNumber(messagingStats.totalFailed || 0)} failed`
              : 'Awaiting first send'
          }
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Messaging Throughput"
          icon={TrendingUp}
          action={
            <div className="flex items-center gap-3 text-xs">
              <div className="flex items-center gap-1.5 text-gray-400">
                <span className="h-2 w-2 rounded-full bg-sky-400" />
                Sent
              </div>
              <div className="flex items-center gap-1.5 text-gray-500">
                <span className="h-2 w-2 rounded-full bg-rose-400/80" />
                Failed
              </div>
              <span className="font-mono text-gray-200 tabular-nums">{formatNumber(messages7dTotal)}</span>
              {messagesWeekTrend !== null && <TrendBadge value={messagesWeekTrend} />}
            </div>
          }
        >
          {messages7d.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={messages7d} margin={{ top: 10, right: 10, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="grad-sent" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="grad-failed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f87171" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#f87171" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                />
                <RechartsTooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  cursor={{ stroke: 'rgba(148,163,184,0.2)' }}
                />
                <Area
                  type="monotone"
                  dataKey="failed"
                  stroke="#f87171"
                  strokeWidth={1.5}
                  fill="url(#grad-failed)"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="messages"
                  stroke="#38bdf8"
                  strokeWidth={2}
                  fill="url(#grad-sent)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[260px] flex-col items-center justify-center text-gray-500">
              <MessageSquare className="mb-2 h-8 w-8 opacity-50" />
              <p className="text-sm">No messaging data yet</p>
              <p className="mt-1 text-xs text-gray-600">Send messages to populate this chart.</p>
            </div>
          )}
        </Panel>

        <Panel title="Session Composition" icon={BarChart3}>
          {sessionStatusData.length > 0 ? (
            <div className="flex flex-col items-center gap-2">
              <div className="relative h-[200px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={sessionStatusData}
                      cx="50%"
                      cy="50%"
                      innerRadius={62}
                      outerRadius={92}
                      paddingAngle={3}
                      dataKey="value"
                      stroke="rgba(2,6,23,0.6)"
                      strokeWidth={2}
                      isAnimationActive={false}
                    >
                      {sessionStatusData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <RechartsTooltip contentStyle={CHART_TOOLTIP_STYLE} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="font-mono text-2xl font-semibold text-white tabular-nums">
                    {formatNumber(totalPie)}
                  </span>
                  <span className="text-[11px] uppercase tracking-wider text-gray-400">Sessions</span>
                </div>
              </div>
              <div className="grid w-full grid-cols-1 gap-1.5">
                {sessionStatusData.map((d) => {
                  const pct = totalPie > 0 ? (d.value / totalPie) * 100 : 0;
                  return (
                    <div
                      key={d.name}
                      className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-xs"
                    >
                      <div className="flex items-center gap-2 text-gray-300">
                        <span className="h-2 w-2 rounded-full" style={{ background: d.color }} />
                        <span>{d.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-gray-100 tabular-nums">{formatNumber(d.value)}</span>
                        <span className="font-mono text-[11px] text-gray-500 tabular-nums">{pct.toFixed(0)}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex h-[260px] flex-col items-center justify-center text-gray-500">
              <Database className="mb-2 h-8 w-8 opacity-50" />
              <p className="text-sm">No sessions uploaded yet</p>
            </div>
          )}
        </Panel>
      </div>

      {/* Performance grid */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Panel title="Session Health" icon={ShieldCheck}>
          <div className="space-y-3">
            <HBar label="Logged in" value={loggedInSessions} total={totalSessions || 1} tone="brand" />
            <HBar label="Active" value={activeSessions} total={totalSessions || 1} tone="success" />
            <HBar label="Uploaded" value={ss.uploaded || 0} total={totalSessions || 1} tone="purple" />
            <HBar label="Error" value={errorSessions} total={totalSessions || 1} tone="danger" />
            <HBar label="Inactive" value={ss.inactive || 0} total={totalSessions || 1} tone="muted" />
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3 text-xs text-gray-400">
            <span>Total accounts</span>
            <span className="font-mono text-gray-100 tabular-nums">
              {formatNumber(ss.totalAccounts || totalSessions)}
            </span>
          </div>
        </Panel>

        <Panel title="Scraping Pipeline" icon={Search}>
          <div className="space-y-3">
            <HBar
              label="Completed"
              value={scrapeCompleted}
              total={Math.max(1, scrapeStats.totalJobs || 0)}
              tone="success"
            />
            <HBar
              label="Running"
              value={scrapeRunning}
              total={Math.max(1, scrapeStats.totalJobs || 0)}
              tone="info"
            />
            <HBar
              label="Pending"
              value={scrapePending}
              total={Math.max(1, scrapeStats.totalJobs || 0)}
              tone="warning"
            />
            <HBar
              label="Failed"
              value={scrapeFailed}
              total={Math.max(1, scrapeStats.totalJobs || 0)}
              tone="danger"
            />
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3 text-xs text-gray-400">
            <span>Success rate</span>
            <Pill tone={scrapeSuccessRate >= 75 ? 'success' : scrapeSuccessRate >= 40 ? 'warning' : 'danger'}>
              {scrapeSuccessRate.toFixed(1)}%
            </Pill>
          </div>
        </Panel>

        <Panel title="Messaging Pipeline" icon={Send}>
          <div className="space-y-3">
            <HBar
              label="Sent"
              value={messagingStats.totalSent || 0}
              total={Math.max(1, messagingStats.totalMessages || messagingStats.totalSent || 0)}
              tone="success"
            />
            <HBar
              label="Failed"
              value={messagingStats.totalFailed || 0}
              total={Math.max(1, messagingStats.totalMessages || messagingStats.totalSent || 0)}
              tone="danger"
            />
            <HBar
              label="Skipped"
              value={messagingStats.totalSkipped || 0}
              total={Math.max(1, messagingStats.totalMessages || messagingStats.totalSent || 0)}
              tone="muted"
            />
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3 text-xs text-gray-400">
            <span>Success rate</span>
            <Pill tone={msgSuccessRate >= 75 ? 'success' : msgSuccessRate >= 40 ? 'warning' : 'danger'}>
              {msgSuccessRate.toFixed(1)}%
            </Pill>
          </div>
        </Panel>
      </div>

      {/* Activity + Quick actions */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        <Panel
          className="lg:col-span-3"
          title="Recent Activity"
          icon={Clock}
          action={
            <button
              onClick={() => navigate('/reports')}
              className="text-xs text-primary-300 hover:text-primary-200"
            >
              View all →
            </button>
          }
        >
          {activities.length > 0 ? (
            <div className="-mt-1">
              {activities.slice(0, 8).map((activity, idx) => (
                <ActivityRow
                  key={activity.id || idx}
                  activity={activity}
                  isLast={idx === Math.min(activities.length, 8) - 1}
                />
              ))}
            </div>
          ) : (
            <div className="flex h-32 flex-col items-center justify-center text-gray-500">
              <FileText className="mb-2 h-7 w-7 opacity-60" />
              <p className="text-sm">No recent activity</p>
            </div>
          )}
        </Panel>

        <Panel
          className="lg:col-span-2"
          title="Quick Actions"
          icon={Zap}
          action={
            errorSessions > 0 ? (
              <Pill tone="danger">
                <AlertTriangle className="h-3 w-3" />
                {errorSessions} error
              </Pill>
            ) : null
          }
        >
          {quickActions.length > 0 ? (
            <div className="space-y-4">
              {Object.entries(groupedQuickActions).map(([cat, items]) => {
                if (!items.length) return null;
                const catLabel = {
                  sessions: 'Sessions',
                  scraping: 'Scraping',
                  messaging: 'Messaging',
                  lists: 'Lists',
                  reports: 'Reports',
                }[cat];
                return (
                  <div key={cat}>
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-500">
                      {catLabel}
                    </div>
                    <div className="space-y-1.5">
                      {items.slice(0, 3).map((action) => {
                        const Icon = QUICK_ACTION_ICON_MAP[action.icon] || Activity;
                        const urgent = action.urgency === 'high';
                        return (
                          <QuickActionCard
                            key={action.action}
                            action={action}
                            Icon={Icon}
                            urgent={urgent}
                            onClick={() => handleQuickAction(action.action)}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex h-32 flex-col items-center justify-center text-gray-500">
              <Activity className="mb-2 h-7 w-7 opacity-60" />
              <p className="text-sm">No suggested actions yet</p>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
