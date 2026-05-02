import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Instagram,
  Users,
  Activity,
  ArrowUpRight,
  Camera,
  UserPlus,
  Heart,
  AtSign,
  Plus,
  Database,
} from 'lucide-react';
import { dashboardAPI } from '@/api';
import { useToast } from '../../components/common/Toast';
import { formatNumber } from '@/utils/formatters';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

function StatsCard({ icon: Icon, label, value, accent, loading }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-pink-100 bg-white p-5 shadow-sm transition-all duration-200 hover:shadow-md dark:border-pink-900/30 dark:bg-dark-800">
      <div className="flex items-start justify-between">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-lg text-white ${accent || IG_GRADIENT}`}
        >
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <div className="mt-4">
        {loading ? (
          <div className="h-8 w-20 animate-pulse rounded bg-gray-100 dark:bg-dark-700" />
        ) : (
          <div className="text-2xl font-semibold text-gray-900 dark:text-white">
            {formatNumber(value || 0)}
          </div>
        )}
        <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">{label}</div>
      </div>
    </div>
  );
}

function QuickAction({ icon: Icon, label, description, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border border-pink-100 bg-white p-4 text-left transition hover:border-[#dc2743] hover:shadow-md dark:border-pink-900/30 dark:bg-dark-800"
    >
      <div className={`flex h-10 w-10 items-center justify-center rounded-lg text-white ${IG_GRADIENT}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex-1">
        <div className="font-semibold text-gray-900 dark:text-white">{label}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{description}</div>
      </div>
      <ArrowUpRight className="h-4 w-4 text-gray-400" />
    </button>
  );
}

export default function InstagramDashboard() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    dashboardAPI
      .stats()
      .then((r) => {
        if (!alive) return;
        setStats(r.data?.data || r.data);
      })
      .catch((err) => {
        if (!alive) return;
        showToast(
          err?.response?.data?.error || err.message || 'Failed to load Instagram dashboard',
          'error'
        );
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [showToast]);

  const sessions = stats?.sessionStats || stats?.overview?.sessions || {};
  const scrape = stats?.scrapeStats || stats?.overview?.scraping || {};
  const byType = scrape.jobsByType || scrape.byTargetType || {};
  const recent = stats?.recentActivity || [];

  return (
    <div className="space-y-6">
      {/* Header — pink gradient strip */}
      <div className={`rounded-xl ${IG_GRADIENT} px-6 py-5 text-white shadow-lg`}>
        <div className="flex items-center gap-3">
          <Instagram className="h-7 w-7" />
          <div>
            <div className="text-lg font-semibold">Instagram Panel</div>
            <div className="text-sm text-white/85">
              Manage Instagram accounts, scrape audiences, and run institutional-grade workflows.
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatsCard
          icon={Users}
          label="Instagram Accounts"
          value={sessions.total || 0}
          loading={loading}
        />
        <StatsCard
          icon={Activity}
          label="Logged-in Sessions"
          value={sessions.loggedIn || sessions.logged_in || 0}
          loading={loading}
        />
        <StatsCard
          icon={Database}
          label="Users Scraped"
          value={scrape.totalUsersFound || scrape.total_users_scraped || 0}
          loading={loading}
        />
        <StatsCard
          icon={Camera}
          label="Active Scrape Jobs"
          value={scrape.activeJobs || scrape.active_jobs || 0}
          loading={loading}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-pink-100 bg-white p-5 shadow-sm dark:border-pink-900/30 dark:bg-dark-800">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-900 dark:text-white">Scrape jobs by type</h3>
            <Database className="h-4 w-4 text-pink-400" />
          </div>
          <ul className="mt-4 space-y-3 text-sm">
            {[
              { key: 'followers', label: 'Followers', icon: Users },
              { key: 'following', label: 'Following', icon: UserPlus },
              { key: 'likers', label: 'Post likers', icon: Heart },
              { key: 'commenters', label: 'Commenters', icon: AtSign },
              { key: 'tagged', label: 'Tagged posts', icon: Camera },
            ].map((row) => {
              const count = byType[row.key] || 0;
              return (
                <li key={row.key} className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-gray-700 dark:text-gray-200">
                    <row.icon className="h-4 w-4 text-pink-500" /> {row.label}
                  </span>
                  <span className="font-semibold text-gray-900 dark:text-white">{count}</span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="rounded-xl border border-pink-100 bg-white p-5 shadow-sm dark:border-pink-900/30 dark:bg-dark-800 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-900 dark:text-white">Quick actions</h3>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <QuickAction
              icon={Plus}
              label="Create Instagram session"
              description="Log in a new Instagram account (username, password, 2FA)"
              onClick={() => navigate('/instagram/create-session')}
            />
            <QuickAction
              icon={Users}
              label="View accounts"
              description="Manage uploaded Instagram sessions"
              onClick={() => navigate('/instagram/sessions')}
            />
            <QuickAction
              icon={Camera}
              label="Run a scrape"
              description="Followers, following, post likers and more"
              onClick={() => navigate('/instagram/scrape')}
            />
            <QuickAction
              icon={Activity}
              label="Recent activity"
              description="See logs of what your team has done"
              onClick={() => navigate('/instagram/reports')}
            />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-pink-100 bg-white p-5 shadow-sm dark:border-pink-900/30 dark:bg-dark-800">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 dark:text-white">Recent Instagram activity</h3>
        </div>
        <div className="mt-4 divide-y divide-pink-100 dark:divide-pink-900/30">
          {recent.length === 0 && (
            <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
              No Instagram activity yet — once you create sessions and run jobs, the timeline will appear here.
            </div>
          )}
          {recent.slice(0, 8).map((row, idx) => (
            <div key={row.id || idx} className="flex items-center justify-between py-3 text-sm">
              <div className="text-gray-700 dark:text-gray-200">
                <span className="font-mono text-xs text-pink-500">{row.action}</span>{' '}
                {row.entityType ? <span className="text-gray-500">on {row.entityType}</span> : null}
              </div>
              <div className="text-xs text-gray-400">{row.createdAt}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
