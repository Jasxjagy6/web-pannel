import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePolling } from '../hooks/usePolling';
import { dashboardAPI } from '@/api';
import { parseApiError, formatNumber, formatRelativeTime } from '@/utils/formatters';
import { useToast } from '../components/common/Toast';
import {
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
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
} from 'lucide-react';

const PIE_COLORS = ['#22c55e', '#94a3b8', '#ef4444', '#f97316'];

const chartTooltipStyle = {
  backgroundColor: '#1e293b',
  border: '1px solid #334155',
  borderRadius: '8px',
  padding: '8px 12px',
  color: '#f8fafc',
  fontSize: '13px',
};

function StatsCard({ icon: Icon, label, value, trend, trendUp, loading }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition-all duration-200 hover:shadow-md">
      <div className="flex items-start justify-between">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
          <Icon className="h-5 w-5" />
        </div>
        {trend !== undefined && trend !== null && (
          <div
            className={`flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium ${
              trendUp
                ? 'bg-green-50 text-green-600'
                : 'bg-red-50 text-red-600'
            }`}
          >
            {trendUp ? (
              <ArrowUpRight className="h-3 w-3" />
            ) : (
              <ArrowDownRight className="h-3 w-3" />
            )}
            {trend}%
          </div>
        )}
      </div>
      <div className="mt-4">
        {loading ? (
          <div className="h-7 w-20 animate-pulse rounded bg-gray-200" />
        ) : (
          <p className="text-2xl font-bold text-gray-900">{formatNumber(value ?? 0)}</p>
        )}
        <p className="mt-0.5 text-sm text-gray-500">{label}</p>
      </div>
      <div className="absolute -bottom-2 -right-2 h-16 w-16 rounded-full bg-primary-500/5" />
    </div>
  );
}

function ActivityItem({ icon: Icon, iconColor, bgColor, description, time }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${bgColor}`}>
        <Icon className={`h-4 w-4 ${iconColor}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-gray-700">{description}</p>
        <p className="mt-0.5 text-xs text-gray-400">{time}</p>
      </div>
    </div>
  );
}

function QuickActionButton({ icon: Icon, label, onClick, variant = 'default' }) {
  const variants = {
    default:
      'bg-white border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-primary-200 hover:text-primary-600',
    primary:
      'bg-primary-600 border-primary-600 text-white hover:bg-primary-700 hover:shadow-md hover:shadow-primary-600/20',
    outline:
      'bg-white border-gray-200 text-gray-700 hover:bg-gray-50',
  };

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium shadow-sm transition-all duration-200 ${variants[variant]}`}
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
}

// Map backend activity action strings to icons and labels
const ACTIVITY_CONFIG = {
  session_login: { icon: Play, iconColor: 'text-green-600', bgColor: 'bg-green-50' },
  session_logout: { icon: Pause, iconColor: 'text-amber-600', bgColor: 'bg-amber-50' },
  session_upload: { icon: Upload, iconColor: 'text-blue-600', bgColor: 'bg-blue-50' },
  session_delete: { icon: AlertCircle, iconColor: 'text-red-600', bgColor: 'bg-red-50' },
  scrape_start: { icon: Search, iconColor: 'text-purple-600', bgColor: 'bg-purple-50' },
  scrape_complete: { icon: CheckCircle, iconColor: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  scrape_cancel: { icon: AlertCircle, iconColor: 'text-orange-600', bgColor: 'bg-orange-50' },
  message_send: { icon: Send, iconColor: 'text-indigo-600', bgColor: 'bg-indigo-50' },
  message_bulk: { icon: Mail, iconColor: 'text-cyan-600', bgColor: 'bg-cyan-50' },
  group_add: { icon: UserPlus, iconColor: 'text-violet-600', bgColor: 'bg-violet-50' },
  list_import: { icon: FileText, iconColor: 'text-teal-600', bgColor: 'bg-teal-50' },
  report_generate: { icon: BarChart3, iconColor: 'text-sky-600', bgColor: 'bg-sky-50' },
};

function getActivityIcon(activity) {
  return ACTIVITY_CONFIG[activity.action] || {
    icon: Activity,
    iconColor: 'text-gray-600',
    bgColor: 'bg-gray-50',
  };
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
    default:
      return details.description || activity.action || 'Unknown activity';
  }
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { error: showError } = useToast();

  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [activities, setActivities] = useState([]);
  const [quickActions, setQuickActions] = useState([]);

  const fetchData = async () => {
    try {
      const response = await dashboardAPI.stats();
      const data = response.data.data;
      setStats(data);
    } catch (err) {
      showError(parseApiError(err), 'Failed to load stats');
    } finally {
      setStatsLoading(false);
    }
  };

  const fetchActivities = async () => {
    try {
      const response = await dashboardAPI.activity({ limit: 10 });
      const data = response.data.data;
      if (data?.activities?.length > 0) {
        setActivities(data.activities);
      }
    } catch (err) {
      console.warn('Failed to fetch activities:', parseApiError(err));
    }
  };

  const fetchQuickActions = async () => {
    try {
      const response = await dashboardAPI.quickActions();
      const data = response.data.data;
      if (data?.actions?.length > 0) {
        setQuickActions(data.actions);
      }
    } catch (err) {
      console.warn('Failed to fetch quick actions:', parseApiError(err));
    }
  };

  useEffect(() => {
    fetchData();
    fetchActivities();
    fetchQuickActions();
  }, []);

  usePolling(fetchData, 30000, true);

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

  // Extract values from real stats
  const totalSessions = stats?.sessionStats?.total ?? 0;
  const activeSessions = stats?.sessionStats?.active ?? 0;
  const totalScrapedUsers = stats?.overview?.scraping?.totalUsersFound ?? 0;
  const messagesToday = stats?.overview?.messaging?.today ?? 0;

  // Session status pie chart data
  const ss = stats?.sessionStats || {};
  const sessionStatusData = [
    { name: 'Active', value: ss.active || 0 },
    { name: 'Uploaded', value: ss.uploaded || 0 },
    { name: 'Error', value: ss.error || 0 },
    { name: 'Inactive', value: ss.inactive || 0 },
  ].filter((d) => d.value > 0);

  // Messages over 7 days
  const dailyStats = stats?.messagingStats?.dailyStats || [];
  const messagesOver7Days = dailyStats.slice(-7).map((d) => ({
    day: new Date(d.date).toLocaleDateString('en', { weekday: 'short' }),
    messages: d.sent || 0,
  }));

  // Top groups - not available in current API response

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            Overview of your Telegram panel activity and performance.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Clock className="h-4 w-4" />
          <span>Last updated: {new Date().toLocaleTimeString()}</span>
        </div>
      </div>

      {/* Stats Cards Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatsCard
          icon={Layers}
          label="Total Sessions"
          value={totalSessions}
          loading={statsLoading}
        />
        <StatsCard
          icon={Activity}
          label="Active Sessions"
          value={activeSessions}
          loading={statsLoading}
        />
        <StatsCard
          icon={Users}
          label="Total Scraped Users"
          value={totalScrapedUsers}
          loading={statsLoading}
        />
        <StatsCard
          icon={Send}
          label="Messages Sent Today"
          value={messagesToday}
          loading={statsLoading}
        />
      </div>

      {/* Charts Grid Row 1 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Messages Over Last 7 Days — Line Chart */}
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary-600" />
            <h2 className="text-base font-semibold text-gray-900">Messages Sent (7 Days)</h2>
          </div>
          {messagesOver7Days.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={messagesOver7Days} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                <RechartsTooltip contentStyle={chartTooltipStyle} />
                <Line
                  type="monotone"
                  dataKey="messages"
                  stroke="#3b82f6"
                  strokeWidth={2.5}
                  dot={{ fill: '#3b82f6', strokeWidth: 2, r: 4, stroke: '#fff' }}
                  activeDot={{ r: 6, stroke: '#3b82f6', strokeWidth: 2, fill: '#fff' }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[280px] items-center justify-center text-gray-400">
              <p>No message data yet. Send messages to see trends.</p>
            </div>
          )}
        </div>

        {/* Session Status Distribution — Pie Chart */}
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-primary-600" />
            <h2 className="text-base font-semibold text-gray-900">Session Status</h2>
          </div>
          {sessionStatusData.length > 0 ? (
            <div className="flex items-center justify-center">
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={sessionStatusData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={4}
                    dataKey="value"
                    stroke="none"
                  >
                    {sessionStatusData.map((_entry, index) => (
                      <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip contentStyle={chartTooltipStyle} />
                  <Legend
                    verticalAlign="bottom"
                    height={36}
                    iconType="circle"
                    formatter={(value) => (
                      <span className="text-sm text-gray-600">{value}</span>
                    )}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-[280px] items-center justify-center text-gray-400">
              <p>No sessions uploaded yet.</p>
            </div>
          )}
        </div>
      </div>

      {/* Recent Activity Feed */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary-600" />
            <h2 className="text-base font-semibold text-gray-900">Recent Activity</h2>
          </div>
        </div>
        <div className="divide-y divide-gray-100">
          {activities.map((activity) => {
            const { icon: Icon, iconColor, bgColor } = getActivityIcon(activity);
            return (
              <ActivityItem
                key={activity.id}
                icon={Icon}
                iconColor={iconColor}
                bgColor={bgColor}
                description={getActivityDescription(activity)}
                time={formatRelativeTime(activity.created_at)}
              />
            );
          })}
        </div>
        {activities.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-gray-400">
            <FileText className="mb-2 h-8 w-8" />
            <p className="text-sm">No recent activity</p>
          </div>
        )}
      </div>

      {/* Quick Actions */}
      {quickActions.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <Play className="h-5 w-5 text-primary-600" />
            <h2 className="text-base font-semibold text-gray-900">Quick Actions</h2>
          </div>
          <div className="flex flex-wrap gap-3">
            {quickActions.slice(0, 8).map((action) => {
              const iconMap = {
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
              const Icon = iconMap[action.icon] || Activity;
              const isPrimary = ['login', 'scrape', 'message'].includes(action.icon);
              return (
                <QuickActionButton
                  key={action.action}
                  icon={Icon}
                  label={action.label}
                  onClick={() => handleQuickAction(action.action)}
                  variant={isPrimary ? 'primary' : 'default'}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
