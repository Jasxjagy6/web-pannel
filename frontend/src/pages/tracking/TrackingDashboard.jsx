import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users, CheckCircle2, DollarSign, TrendingUp, Star, Ban, Clock, UploadCloud,
  AlertTriangle, ShieldAlert, HardDriveDownload, Loader2, ListChecks,
} from 'lucide-react';
import { trackingDashboardAPI } from '@/api';
import { useToast } from '../../components/common/Toast';
import { parseApiError, formatDate, formatDateTime } from '@/utils/formatters';
import StatCard from '../../components/tracking/StatCard';
import ChartPanel from '../../components/tracking/ChartPanel';
import StatusBadge from '../../components/common/StatusBadge';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

function money(v) {
  return `$${Number(v || 0).toFixed(2)}`;
}

export default function TrackingDashboard() {
  const navigate = useNavigate();
  const { error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();
  const canSeeEarnings = hasPermission('earnings') && hasPermission('sales');

  const [stats, setStats] = useState(null);
  const [charts, setCharts] = useState({ uploads: [], sales: [] });
  const [recent, setRecent] = useState({ recentUploads: [], recentSales: [], recentActivity: [] });
  const [alerts, setAlerts] = useState({ reservationsExpiringSoon: [], paymentsPending: [], backupMissing: [] });
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, chartsRes, recentRes, alertsRes] = await Promise.all([
        trackingDashboardAPI.getStats(),
        trackingDashboardAPI.getCharts(12),
        trackingDashboardAPI.getRecent(8),
        trackingDashboardAPI.getAlerts(),
      ]);
      setStats(statsRes.data.data);
      setCharts(chartsRes.data.data);
      setRecent(recentRes.data.data);
      setAlerts(alertsRes.data.data);
    } catch (err) {
      showError(parseApiError(err), 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  if (loading || !stats) {
    return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>;
  }

  const totalAlerts = alerts.reservationsExpiringSoon.length + alerts.paymentsPending.length + alerts.backupMissing.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Tracking Dashboard</h1>
          <p className="text-sm text-gray-400 mt-1">Telegram account inventory overview</p>
        </div>
        <button
          onClick={() => navigate('/tracking/accounts')}
          className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
        >
          <ListChecks className="h-4 w-4" /> View Accounts
        </button>
      </div>

      {totalAlerts > 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-300">
            <AlertTriangle className="h-4 w-4" /> Needs attention
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            {alerts.reservationsExpiringSoon.length > 0 && (
              <div className="flex items-center gap-2 text-gray-300">
                <Clock className="h-4 w-4 text-amber-400 shrink-0" />
                {alerts.reservationsExpiringSoon.length} reservation{alerts.reservationsExpiringSoon.length === 1 ? '' : 's'} expiring within 24h
              </div>
            )}
            {canSeeEarnings && alerts.paymentsPending.length > 0 && (
              <div className="flex items-center gap-2 text-gray-300">
                <DollarSign className="h-4 w-4 text-amber-400 shrink-0" />
                {alerts.paymentsPending.length} payment{alerts.paymentsPending.length === 1 ? '' : 's'} pending
              </div>
            )}
            {alerts.backupMissing.length > 0 && (
              <div className="flex items-center gap-2 text-gray-300">
                <HardDriveDownload className="h-4 w-4 text-amber-400 shrink-0" />
                {alerts.backupMissing.length} account{alerts.backupMissing.length === 1 ? '' : 's'} missing a session backup
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
        <StatCard label="Total Accounts" value={stats.totalAccounts} icon={Users} />
        <StatCard label="Active" value={stats.activeAccounts} icon={CheckCircle2} tone="green" />
        <StatCard label="Available" value={stats.availableAccounts} icon={CheckCircle2} />
        <StatCard label="Reserved" value={stats.reservedAccounts} icon={Clock} tone="amber" />
        <StatCard label="Sold" value={stats.soldAccounts} icon={TrendingUp} tone="blue" />
        <StatCard label="Premium" value={stats.premiumAccounts} icon={Star} tone="amber" />
        <StatCard label="Non-Premium" value={stats.nonPremiumAccounts} icon={Users} />
        <StatCard label="Banned" value={stats.bannedAccounts} icon={Ban} tone="red" />
        <StatCard label="Deleted" value={stats.deletedAccounts} icon={Ban} tone="red" />
        <StatCard label="Uploaded Today" value={stats.uploadedToday} icon={UploadCloud} />
      </div>

      {canSeeEarnings && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
          <StatCard label="Inventory Value" value={money(stats.totalEstimatedInventoryValue)} icon={DollarSign} />
          <StatCard label="Total Sales Value" value={money(stats.totalSalesValue)} icon={DollarSign} tone="green" />
          <StatCard label="Total Profit" value={money(stats.totalProfit)} icon={TrendingUp} tone="green" />
          <StatCard label="Avg. Sale Price" value={money(stats.averageSellingPrice)} icon={DollarSign} />
          <StatCard label="Pending Payments" value={stats.pendingPayments} icon={AlertTriangle} tone="amber" />
          <StatCard label="Highest Sale" value={money(stats.highestSale)} icon={TrendingUp} />
          <StatCard label="Lowest Sale" value={money(stats.lowestSale)} icon={TrendingUp} />
          <StatCard label="Daily Earnings" value={money(stats.dailyEarnings)} icon={DollarSign} />
          <StatCard label="Weekly Earnings" value={money(stats.weeklyEarnings)} icon={DollarSign} />
          <StatCard label="Monthly Earnings" value={money(stats.monthlyEarnings)} icon={DollarSign} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ChartPanel title="Uploads per Month" data={charts.uploads} type="bar" dataKey="count" color="#6366f1" />
        <ChartPanel title="Sales per Month" data={charts.sales} type="bar" dataKey="count" color="#22c55e" />
        {canSeeEarnings && (
          <>
            <ChartPanel title="Revenue" data={charts.sales} type="line" dataKey="revenue" color="#f59e0b" valuePrefix="$" />
            <ChartPanel title="Profit" data={charts.sales} type="line" dataKey="profit" color="#06b6d4" valuePrefix="$" />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-white/5 bg-dark-800/50 p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">Recent Uploads</h3>
          <div className="space-y-2">
            {recent.recentUploads.length === 0 ? (
              <p className="text-sm text-gray-500">Nothing yet.</p>
            ) : recent.recentUploads.map((a) => (
              <div key={a.id} onClick={() => navigate(`/tracking/accounts/${a.id}`)} className="flex items-center justify-between text-sm cursor-pointer hover:bg-white/5 rounded-lg px-2 py-1.5 -mx-2">
                <span className="text-gray-300 truncate">{a.display_name || (a.username ? `@${a.username}` : a.internal_code)}</span>
                <StatusBadge status={a.status} size="sm" />
              </div>
            ))}
          </div>
        </div>

        {canSeeEarnings && (
          <div className="rounded-xl border border-white/5 bg-dark-800/50 p-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Recent Sales</h3>
            <div className="space-y-2">
              {recent.recentSales.length === 0 ? (
                <p className="text-sm text-gray-500">No sales yet.</p>
              ) : recent.recentSales.map((s) => (
                <div key={s.id} onClick={() => navigate(`/tracking/accounts/${s.account_id}`)} className="flex items-center justify-between text-sm cursor-pointer hover:bg-white/5 rounded-lg px-2 py-1.5 -mx-2">
                  <span className="text-gray-300 truncate">{s.buyer_name || s.internal_code}</span>
                  <span className="text-green-400">{money(s.sale_price)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-xl border border-white/5 bg-dark-800/50 p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">Recent Activity</h3>
          <div className="space-y-2">
            {recent.recentActivity.length === 0 ? (
              <p className="text-sm text-gray-500">No activity yet.</p>
            ) : recent.recentActivity.map((a) => (
              <div key={a.id} className="text-sm">
                <p className="text-gray-300">{a.action.replace(/_/g, ' ')}</p>
                <p className="text-xs text-gray-500">{a.email || 'system'} — {formatDateTime(a.created_at)}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
