import { apiError } from '../../utils/apiError';
import { useEffect, useState } from 'react';
import {
  BarChart3,
  RefreshCw,
  Activity,
  Download,
  Calendar,
} from 'lucide-react';
import { reportsAPI, dashboardAPI } from '@/api';
import { useToast } from '../../components/common/Toast';
import { formatNumber } from '@/utils/formatters';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

function StatCard({ label, value, accent }) {
  return (
    <div className="rounded-xl border border-pink-200 bg-white p-4 shadow-sm dark:border-pink-300/20 dark:bg-pink-950/40">
      <div className="text-[11px] uppercase tracking-wider text-pink-600/80 dark:text-pink-200/70">
        {label}
      </div>
      <div className={`mt-2 text-2xl font-bold ${accent || 'text-pink-900 dark:text-pink-100'}`}>
        {value}
      </div>
    </div>
  );
}

export default function InstagramReports() {
  const { showToast } = useToast();
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState([]);
  const [saved, setSaved] = useState([]);
  const [loading, setLoading] = useState(true);

  async function reload() {
    setLoading(true);
    try {
      const [s, a, r] = await Promise.all([
        dashboardAPI.stats(),
        reportsAPI.activity({ page: 1, limit: 30 }).catch(() => ({ data: { activities: [] } })),
        reportsAPI.saved({ page: 1, limit: 20 }).catch(() => ({ data: { reports: [] } })),
      ]);
      setStats(s.data?.data || s.data);
      const act = a.data?.data?.activities || a.data?.activities || [];
      setActivity(act.filter((x) => !x?.metadata?.platform || x.metadata.platform === 'instagram'));
      setSaved(r.data?.data?.reports || r.data?.reports || []);
    } catch (err) {
      showToast(apiError(err, 'Failed to load reports'), 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); }, []);

  const sessions = stats?.sessionStats || {};
  const scrape = stats?.scrapeStats || {};

  return (
    <div className="space-y-6">
      <div className={`rounded-2xl ${IG_GRADIENT} px-6 py-5 text-white shadow-lg`}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <BarChart3 className="h-7 w-7" />
            <div>
              <div className="text-lg font-semibold">Instagram reports</div>
              <div className="text-sm text-white/85">
                Audit trail and aggregated stats for the Instagram side of the panel.
              </div>
            </div>
          </div>
          <button
            onClick={reload}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-sm font-medium text-white hover:bg-white/20"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {/* KPI grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total accounts"   value={formatNumber(sessions.total || 0)} />
        <StatCard label="Active sessions"  value={formatNumber(sessions.loggedIn || sessions.logged_in || 0)} accent="text-green-600 dark:text-green-300" />
        <StatCard label="Scrape jobs run"  value={formatNumber(scrape.totalJobs || 0)} />
        <StatCard label="Users scraped"    value={formatNumber(scrape.totalUsersScraped || scrape.totalUsersFound || 0)} accent="text-pink-600 dark:text-pink-300" />
      </div>

      {/* Activity feed */}
      <div className="rounded-xl border border-pink-200 bg-white p-5 shadow-sm dark:border-pink-300/20 dark:bg-pink-950/40">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="h-4 w-4 text-pink-500" />
          <h3 className="font-semibold text-pink-900 dark:text-pink-100">Recent activity</h3>
        </div>
        {loading && <div className="text-sm text-pink-500">Loading…</div>}
        {!loading && activity.length === 0 && (
          <div className="rounded-lg bg-pink-50 p-6 text-center text-sm text-pink-700 dark:bg-pink-900/20 dark:text-pink-200">
            No Instagram activity yet — once you start scraping, every action will be logged here.
          </div>
        )}
        <ul className="divide-y divide-pink-100 dark:divide-pink-300/20">
          {activity.map((row, idx) => (
            <li key={row.id || idx} className="flex items-center justify-between py-3 text-sm">
              <div className="min-w-0">
                <span className="rounded bg-pink-100 px-2 py-0.5 font-mono text-[11px] text-pink-700">
                  {row.action || 'event'}
                </span>
                {row.entityType && (
                  <span className="ml-2 text-pink-700/80 dark:text-pink-200/80">
                    on <strong>{row.entityType}</strong>
                  </span>
                )}
              </div>
              <span className="flex items-center gap-1 text-xs text-pink-500/80">
                <Calendar className="h-3 w-3" />
                {row.createdAt ? new Date(row.createdAt).toLocaleString() : '—'}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Saved reports */}
      <div className="rounded-xl border border-pink-200 bg-white p-5 shadow-sm dark:border-pink-300/20 dark:bg-pink-950/40">
        <h3 className="font-semibold text-pink-900 dark:text-pink-100 mb-3">Saved reports</h3>
        {!loading && saved.length === 0 && (
          <div className="rounded-lg bg-pink-50 p-6 text-center text-sm text-pink-700 dark:bg-pink-900/20 dark:text-pink-200">
            No saved reports yet.
          </div>
        )}
        <ul className="divide-y divide-pink-100 dark:divide-pink-300/20">
          {saved.map((r) => (
            <li key={r.id} className="flex items-center justify-between py-3 text-sm">
              <div>
                <div className="font-semibold text-pink-900 dark:text-pink-100">{r.name}</div>
                <div className="text-xs text-pink-500/80">{r.report_type || r.type}</div>
              </div>
              <button
                onClick={async () => {
                  try {
                    const blob = await reportsAPI.exportReport(r.id, 'csv');
                    const url = URL.createObjectURL(blob.data);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${r.name || 'report'}.csv`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  } catch (err) {
                    showToast(apiError(err), 'error');
                  }
                }}
                className="inline-flex items-center gap-1 rounded-md border border-pink-200 bg-white px-3 py-1.5 text-xs font-medium text-pink-700 hover:bg-pink-50 dark:border-pink-300/20 dark:bg-pink-950/40 dark:text-pink-100"
              >
                <Download className="h-3.5 w-3.5" /> CSV
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
