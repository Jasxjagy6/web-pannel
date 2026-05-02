/**
 * InstagramAdmin — dedicated, IG-themed admin panel.
 *
 * Mounted at /instagram/admin (admin-only). Visually independent from
 * the Telegram admin: dark obsidian glass + Instagram gradient accents.
 *
 * Tabs:
 *   - Overview        — IG-scoped KPI tiles + recent IG admin actions.
 *   - Users           — search/filter users, approve/ban/unban/delete.
 *   - Subscriptions   — per-user Instagram subscription editor (plan,
 *                       status, expiry, features), grant trial, force
 *                       expire, plus quick toggle for active state.
 *   - Trial & Pricing — IG-specific billing.instagram.* settings:
 *                       trial enabled / duration / allowed features,
 *                       price / period / currency.
 *   - Activity        — recent admin actions, filtered to subscription
 *                       updates so the admin can audit IG flow.
 *
 * Backed entirely by existing endpoints — see frontend/src/api/admin.js.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Users as UsersIcon,
  Search as SearchIcon,
  Loader2,
  ShieldCheck,
  Ban,
  RefreshCcw,
  Trash2,
  CheckCircle2,
  X,
  Filter,
  CreditCard,
  Sparkles,
  Save,
  AlertCircle,
  Crown,
  Activity as ActivityIcon,
  Hourglass,
  Zap,
  Clock,
  PlayCircle,
  StopCircle,
  Settings2,
  ListChecks,
} from 'lucide-react';
import {
  listUsers,
  approveUser,
  banUser,
  unbanUser,
  deleteUser,
  getSystemStats,
  getRecentActions,
  listUserPlatformSubscriptions,
  setUserPlatformSubscription,
  getBillingSettings,
  updateBillingSettings,
} from '../../api/admin';
import { useToast } from '../../components/common/Toast';
import { parseApiError, formatDateTime, formatRelativeTime } from '../../utils/formatters';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';
const IG_GRADIENT_SOFT = 'bg-gradient-to-tr from-[#f09433]/15 via-[#dc2743]/15 to-[#bc1888]/15';

const PLAN_OPTIONS = ['trial', 'basic', 'pro', 'enterprise'];
const STATUS_OPTIONS = ['inactive', 'active', 'expired', 'cancelled'];

const TRIAL_FEATURE_OPTIONS = [
  { key: 'dashboard',        label: 'Dashboard' },
  { key: 'sessions',         label: 'Accounts (sessions)' },
  { key: 'sessions_create',  label: 'Add account' },
  { key: 'scrape',           label: 'Scraping' },
  { key: 'lists',            label: 'Saved lists' },
  { key: 'reports',          label: 'Reports' },
  { key: 'proxies',          label: 'Proxies' },
  { key: 'identity_device',  label: 'Identity / device' },
  { key: 'privacy_set',      label: 'Privacy' },
  { key: 'twofa_change',     label: '2FA' },
];

/* -------------------------------------------------------------------------- */
/* Top-level page                                                             */
/* -------------------------------------------------------------------------- */

export default function InstagramAdmin() {
  const [tab, setTab] = useState('overview');

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className={`relative overflow-hidden rounded-2xl ${IG_GRADIENT} px-5 sm:px-6 py-5 text-white shadow-2xl ring-1 ring-white/15`}>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-30"
          style={{
            background:
              'radial-gradient(ellipse at 0% 0%, rgba(255,255,255,0.45) 0%, transparent 55%)',
          }}
        />
        <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/20 ring-1 ring-white/30 shrink-0">
              <Crown className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-lg sm:text-xl font-bold tracking-tight">
                  Instagram Admin
                </h1>
                <span className="inline-flex items-center rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.2em] ring-1 ring-white/30">
                  IG Studio
                </span>
              </div>
              <p className="text-xs sm:text-sm text-white/85">
                Approve users, control Instagram trials, manage subscriptions and pricing — all in one place.
              </p>
            </div>
          </div>
          <AdminTabs tab={tab} onChange={setTab} />
        </div>
      </div>

      {tab === 'overview' && <OverviewTab onJump={setTab} />}
      {tab === 'users' && <UsersTab />}
      {tab === 'subscriptions' && <SubscriptionsTab />}
      {tab === 'trial' && <TrialPricingTab />}
      {tab === 'activity' && <ActivityTab />}
    </div>
  );
}

function AdminTabs({ tab, onChange }) {
  const items = [
    { key: 'overview',      label: 'Overview',      icon: ActivityIcon },
    { key: 'users',         label: 'Users',         icon: UsersIcon },
    { key: 'subscriptions', label: 'Subscriptions', icon: ShieldCheck },
    { key: 'trial',         label: 'Trial & Pricing', icon: Sparkles },
    { key: 'activity',      label: 'Activity',      icon: ListChecks },
  ];
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-xl border border-white/20 bg-white/10 p-1 backdrop-blur-md">
      {items.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] sm:text-xs font-semibold transition ${
            tab === key
              ? 'bg-white text-pink-700 shadow ring-1 ring-white/40'
              : 'text-white/85 hover:bg-white/15'
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared bits                                                                */
/* -------------------------------------------------------------------------- */

function GlassCard({ className = '', children }) {
  return (
    <div className={`rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md shadow-xl ${className}`}>
      {children}
    </div>
  );
}

function StatTile({ label, value, hint, accent }) {
  return (
    <GlassCard className="p-4 sm:p-5">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-pink-200/70">
        {label}
      </div>
      <p className={`mt-2 text-2xl font-bold ${accent || 'text-pink-50'}`}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-[11px] text-pink-200/60">{hint}</p> : null}
    </GlassCard>
  );
}

function StatusBadge({ status }) {
  const map = {
    pending:  'bg-amber-500/15 text-amber-200 ring-amber-500/30',
    approved: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30',
    banned:   'bg-rose-500/15 text-rose-200 ring-rose-500/30',
    active:   'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30',
    inactive: 'bg-white/5 text-pink-200/70 ring-white/10',
    expired:  'bg-rose-500/15 text-rose-200 ring-rose-500/30',
    cancelled:'bg-rose-500/15 text-rose-200 ring-rose-500/30',
  };
  const cls = map[status] || 'bg-white/5 text-pink-200/70 ring-white/10';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ring-1 ${cls}`}>
      {status || '—'}
    </span>
  );
}

function igSub(user) {
  // Returns the IG-platform subscription snapshot for a user list row.
  // user.subscriptions.instagram is populated by the publicUser helper.
  return user?.subscriptions?.instagram || null;
}

function igTrialActive(sub) {
  if (!sub?.trial?.expiresAt) return false;
  return new Date(sub.trial.expiresAt) > new Date();
}

function igPaidActive(sub) {
  if (!sub) return false;
  if (sub.status === 'active' && sub.expiresAt && new Date(sub.expiresAt) > new Date()) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Overview                                                                   */
/* -------------------------------------------------------------------------- */

function OverviewTab({ onJump }) {
  const toast = useToast();
  const [stats, setStats] = useState(null);
  const [igCounts, setIgCounts] = useState({ activeSubs: 0, activeTrials: 0, totalUsers: 0 });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, list] = await Promise.all([
        getSystemStats().catch(() => ({ data: { data: null } })),
        listUsers({ limit: 200 }),
      ]);
      const sysStats = s.data?.data || null;
      setStats(sysStats);

      const users = list.data?.data?.users || [];
      let activeSubs = 0, activeTrials = 0;
      for (const u of users) {
        const sub = igSub(u);
        if (igPaidActive(sub)) activeSubs += 1;
        else if (igTrialActive(sub)) activeTrials += 1;
      }
      setIgCounts({
        activeSubs,
        activeTrials,
        totalUsers: list.data?.data?.total || users.length,
      });
    } catch (e) {
      toast.error(parseApiError(e), 'Failed to load Instagram admin overview');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Total users"        value={loading ? '—' : (stats?.total_users ?? igCounts.totalUsers ?? 0)} />
        <StatTile label="Pending approvals"  value={loading ? '—' : (stats?.pending_users ?? 0)} accent="text-amber-200" />
        <StatTile label="IG · active subs"   value={loading ? '—' : igCounts.activeSubs}        accent="text-emerald-200" />
        <StatTile label="IG · active trials" value={loading ? '—' : igCounts.activeTrials}      accent="text-pink-200" />
        <StatTile label="Banned users"       value={loading ? '—' : (stats?.banned_users ?? 0)} accent="text-rose-200" />
      </div>

      <GlassCard className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-pink-50">Quick actions</h3>
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-pink-100 hover:bg-white/10"
          >
            <RefreshCcw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <QuickAction icon={UsersIcon} title="Manage users"
            description="Approve, ban or remove panel users."
            onClick={() => onJump('users')} />
          <QuickAction icon={ShieldCheck} title="Edit subscriptions"
            description="Grant or revoke Instagram subs and trials."
            onClick={() => onJump('subscriptions')} />
          <QuickAction icon={Sparkles} title="Trial & pricing"
            description="Configure Instagram trial duration, allowed features, price."
            onClick={() => onJump('trial')} />
        </div>
      </GlassCard>
    </div>
  );
}

function QuickAction({ icon: Icon, title, description, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-3 text-left transition hover:border-pink-300/40 hover:bg-white/10"
    >
      <div className={`flex h-10 w-10 items-center justify-center rounded-xl text-white ${IG_GRADIENT} ring-1 ring-white/20`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-pink-50">{title}</div>
        <div className="text-[11px] text-pink-200/70">{description}</div>
      </div>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Users tab                                                                  */
/* -------------------------------------------------------------------------- */

function UsersTab() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listUsers({
        search: search || undefined,
        status: statusFilter || undefined,
        limit: 200,
      });
      setUsers(r.data?.data?.users || []);
      setTotal(r.data?.data?.total || 0);
    } catch (e) {
      toast.error(parseApiError(e), 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, toast]);

  useEffect(() => { load(); }, [load]);

  const wrap = useCallback((fn, ok) => async (u, ...rest) => {
    setActing(u.id);
    try { await fn(u.id, ...rest); toast.success(ok); await load(); }
    catch (e) { toast.error(parseApiError(e), 'Action failed'); }
    finally { setActing(null); }
  }, [toast, load]);

  const onApprove = wrap(approveUser,                                'User approved');
  const onUnban   = wrap(unbanUser,                                  'User unbanned');
  const onBan     = (u) => {
    const reason = prompt('Ban reason (optional):') ?? '';
    return wrap((id) => banUser(id, reason), 'User banned')(u);
  };
  const onDelete  = (u) => {
    if (!confirm(`Permanently delete ${u.email}? This cascades to all sessions and jobs.`)) return;
    return wrap(deleteUser, 'User deleted')(u);
  };

  return (
    <GlassCard className="overflow-hidden">
      {/* Filter bar */}
      <div className="flex flex-col gap-3 border-b border-white/10 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-pink-200/60" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search users by email"
            className="w-full rounded-xl border border-white/10 bg-white/5 py-2 pl-10 pr-3 text-sm text-pink-50 placeholder:text-pink-200/40 focus:border-pink-300/50 focus:outline-none focus:ring-2 focus:ring-pink-500/20"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-pink-200/60" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-xl border border-white/10 bg-[#1a0820] px-3 py-2 text-sm text-pink-50 focus:border-pink-300/50 focus:outline-none focus:ring-2 focus:ring-pink-500/20"
          >
            <option value="">All status</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="banned">Banned</option>
          </select>
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-pink-100 hover:bg-white/10"
          >
            <RefreshCcw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center p-10 text-pink-200/70">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading users…
        </div>
      ) : users.length === 0 ? (
        <div className="p-10 text-center text-sm text-pink-200/70">
          <UsersIcon className="mx-auto mb-2 h-8 w-8 text-pink-200/40" />
          No users match this filter.
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[10px] uppercase tracking-[0.2em] text-pink-200/60">
                <tr className="border-b border-white/10">
                  <th className="p-3">User</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">IG Subscription</th>
                  <th className="p-3">Sessions</th>
                  <th className="p-3">Created</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow
                    key={u.id} u={u}
                    acting={acting === u.id}
                    onApprove={onApprove} onBan={onBan} onUnban={onUnban} onDelete={onDelete}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile cards */}
          <ul className="divide-y divide-white/10 md:hidden">
            {users.map((u) => (
              <UserCard
                key={u.id} u={u}
                acting={acting === u.id}
                onApprove={onApprove} onBan={onBan} onUnban={onUnban} onDelete={onDelete}
              />
            ))}
          </ul>
          <div className="border-t border-white/10 p-3 text-[11px] text-pink-200/60">
            Showing {users.length} of {total}
          </div>
        </>
      )}
    </GlassCard>
  );
}

function UserRow({ u, acting, onApprove, onBan, onUnban, onDelete }) {
  const sub = igSub(u);
  return (
    <tr className="border-b border-white/5 hover:bg-white/5 align-middle">
      <td className="p-3">
        <div className="flex flex-col min-w-0">
          <span className="font-medium text-pink-50 truncate">{u.email}</span>
          <span className="text-xs text-pink-200/60">#{u.id} · {u.role}</span>
        </div>
      </td>
      <td className="p-3"><StatusBadge status={u.status} /></td>
      <td className="p-3 text-pink-100/85">
        <IgSubPill sub={sub} />
      </td>
      <td className="p-3 text-pink-100/85">{u.sessionsCount ?? 0} <span className="text-pink-200/50">({u.activeSessionsCount ?? 0} active)</span></td>
      <td className="p-3 text-pink-200/70">{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
      <td className="p-3"><RowActions u={u} acting={acting} onApprove={onApprove} onBan={onBan} onUnban={onUnban} onDelete={onDelete} /></td>
    </tr>
  );
}

function UserCard({ u, acting, onApprove, onBan, onUnban, onDelete }) {
  const sub = igSub(u);
  return (
    <li className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-pink-50">{u.email}</p>
          <p className="text-xs text-pink-200/60">#{u.id} · {u.role} · {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</p>
        </div>
        <StatusBadge status={u.status} />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-pink-100/80">
        <span className="text-pink-200/60">IG:</span>
        <IgSubPill sub={sub} />
        <span><span className="text-pink-200/60">Sessions:</span> {u.sessionsCount ?? 0} ({u.activeSessionsCount ?? 0} active)</span>
      </div>
      <RowActions u={u} acting={acting} onApprove={onApprove} onBan={onBan} onUnban={onUnban} onDelete={onDelete} />
    </li>
  );
}

function IgSubPill({ sub }) {
  if (!sub) return <span className="text-pink-200/50">—</span>;
  if (igPaidActive(sub)) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-200 ring-1 ring-emerald-500/30">
        <ShieldCheck className="h-3 w-3" /> {sub.plan || 'paid'}
      </span>
    );
  }
  if (igTrialActive(sub)) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-pink-500/15 px-2 py-0.5 text-[11px] font-semibold text-pink-200 ring-1 ring-pink-500/30">
        <Hourglass className="h-3 w-3" /> Trial
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium text-pink-200/70 ring-1 ring-white/10">
      <Clock className="h-3 w-3" /> Inactive
    </span>
  );
}

function RowActions({ u, acting, onApprove, onBan, onUnban, onDelete }) {
  if (u.role === 'admin') {
    return <span className="text-xs text-pink-200/60 italic">Admin (protected)</span>;
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {u.status !== 'approved' && (
        <button
          onClick={() => onApprove(u)} disabled={acting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
        >
          <CheckCircle2 className="h-3.5 w-3.5" /> Approve
        </button>
      )}
      {u.status === 'banned' ? (
        <button
          onClick={() => onUnban(u)} disabled={acting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
        >
          <RefreshCcw className="h-3.5 w-3.5" /> Unban
        </button>
      ) : (
        <button
          onClick={() => onBan(u)} disabled={acting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-400/40 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-200 hover:bg-rose-500/20 disabled:opacity-50"
        >
          <Ban className="h-3.5 w-3.5" /> Ban
        </button>
      )}
      <button
        onClick={() => onDelete(u)} disabled={acting}
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-pink-200/80 hover:border-rose-400/40 hover:text-rose-200 disabled:opacity-50"
        title="Permanently delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Subscriptions tab                                                          */
/* -------------------------------------------------------------------------- */

function SubscriptionsTab() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listUsers({ search: search || undefined, limit: 300 });
      setUsers(r.data?.data?.users || []);
    } catch (e) {
      toast.error(parseApiError(e), 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [search, toast]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(
    () => users.filter((u) => u.role !== 'admin'),
    [users]
  );

  return (
    <>
      <GlassCard className="p-4 mb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-pink-50">Per-user Instagram subscription</h3>
            <p className="text-[11px] text-pink-200/70">
              Click a user to grant or revoke their Instagram subscription, set the plan, expiry and feature flags.
              Trials configured here apply only to the IG panel — the Telegram subscription is managed separately.
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-pink-200/60" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search users…"
              className="w-full rounded-xl border border-white/10 bg-white/5 py-2 pl-10 pr-3 text-sm text-pink-50 placeholder:text-pink-200/40 focus:border-pink-300/50 focus:outline-none focus:ring-2 focus:ring-pink-500/20"
            />
          </div>
        </div>
      </GlassCard>

      <GlassCard className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center p-10 text-pink-200/70">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-pink-200/70">
            No users match this filter.
          </div>
        ) : (
          <ul className="divide-y divide-white/10">
            {filtered.map((u) => (
              <SubscriptionRow
                key={u.id}
                user={u}
                onEdit={() => setEditing(u)}
              />
            ))}
          </ul>
        )}
      </GlassCard>

      {editing && (
        <SubscriptionDrawer
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </>
  );
}

function SubscriptionRow({ user, onEdit }) {
  const sub = igSub(user);
  const expiresLine = sub?.expiresAt
    ? `Expires ${formatDateTime(sub.expiresAt)}`
    : sub?.trial?.expiresAt
      ? `Trial until ${formatDateTime(sub.trial.expiresAt)}`
      : 'No active subscription';
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate font-medium text-pink-50">{user.email}</p>
        <p className="text-[11px] text-pink-200/60">#{user.id} · {user.status}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-pink-100/85">
        <IgSubPill sub={sub} />
        <span className="text-pink-200/60">{expiresLine}</span>
      </div>
      <button
        onClick={onEdit}
        className="inline-flex items-center gap-1.5 rounded-lg border border-pink-300/40 bg-pink-500/10 px-3 py-1.5 text-xs font-semibold text-pink-100 hover:bg-pink-500/20"
      >
        <Settings2 className="h-3.5 w-3.5" /> Manage
      </button>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Subscription drawer                                                        */
/* -------------------------------------------------------------------------- */

function SubscriptionDrawer({ user, onClose, onSaved }) {
  const toast = useToast();
  const [snapshot, setSnapshot] = useState(null); // null=loading
  const [plan, setPlan] = useState('trial');
  const [status, setStatus] = useState('active');
  const [expires, setExpires] = useState('');
  const [features, setFeatures] = useState({});
  const [allFeatures, setAllFeatures] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    listUserPlatformSubscriptions(user.id)
      .then((r) => {
        if (!alive) return;
        const subs = r.data?.subscriptions || [];
        const ig = subs.find((s) => s.platform === 'instagram') || {};
        setSnapshot(ig);
        setPlan(ig.plan || 'trial');
        setStatus(ig.status || 'inactive');
        setExpires(ig.expires_at ? String(ig.expires_at).slice(0, 10) : '');
        const f = ig.features || {};
        if (f.all === true) {
          setAllFeatures(true);
          setFeatures({});
        } else {
          setAllFeatures(false);
          setFeatures(f || {});
        }
      })
      .catch(() => alive && setSnapshot({}));
    return () => { alive = false; };
  }, [user.id]);

  const setFeature = (key, on) => {
    setFeatures((prev) => {
      const next = { ...prev };
      if (on) next[key] = true;
      else delete next[key];
      return next;
    });
  };

  const buildPayload = (override = {}) => {
    const featPayload = override.features !== undefined
      ? override.features
      : (allFeatures ? { all: true } : features);
    return {
      plan: override.plan ?? plan,
      status: override.status ?? status,
      expiresAt: (override.expiresAt !== undefined
        ? override.expiresAt
        : (expires ? new Date(expires).toISOString() : null)),
      features: featPayload,
    };
  };

  const save = async (override = {}) => {
    setSaving(true);
    try {
      await setUserPlatformSubscription(user.id, 'instagram', buildPayload(override));
      toast.success('Instagram subscription updated');
      onSaved();
    } catch (e) {
      toast.error(parseApiError(e), 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const grantTrialNow = async (minutes = 60 * 24 * 7) => {
    // Default: 7-day trial. The admin can also set a longer expiry
    // manually via the date picker if needed.
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    await save({ plan: 'trial', status: 'active', expiresAt, features: { all: true } });
  };

  const expireNow = () => save({ plan, status: 'expired', expiresAt: new Date().toISOString() });

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-t-2xl border border-white/10 bg-[#150620] shadow-2xl sm:rounded-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`relative px-5 py-4 ${IG_GRADIENT} text-white`}>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-base font-semibold">Instagram subscription</h3>
              <p className="text-xs text-white/85 truncate">{user.email}</p>
            </div>
            <button onClick={onClose} className="rounded-lg p-1 text-white/85 hover:bg-white/15">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {snapshot === null ? (
          <div className="flex items-center justify-center p-10 text-pink-200/70">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading subscription…
          </div>
        ) : (
          <div className="space-y-4 p-5">
            {/* Quick action row */}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => grantTrialNow()}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50"
              >
                <PlayCircle className="h-3.5 w-3.5" /> Start 7-day trial
              </button>
              <button
                onClick={expireNow}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-400/40 bg-rose-500/15 px-3 py-1.5 text-xs font-semibold text-rose-100 hover:bg-rose-500/25 disabled:opacity-50"
              >
                <StopCircle className="h-3.5 w-3.5" /> Expire now
              </button>
              <button
                onClick={() => save({ status: 'active', plan: plan === 'trial' ? 'basic' : plan })}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg border border-pink-400/40 bg-pink-500/15 px-3 py-1.5 text-xs font-semibold text-pink-100 hover:bg-pink-500/25 disabled:opacity-50"
              >
                <Zap className="h-3.5 w-3.5" /> Activate
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-pink-200/70">Plan</label>
                <select
                  value={plan} onChange={(e) => setPlan(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#1a0820] px-3 py-2 text-sm text-pink-50 focus:border-pink-300/50 focus:outline-none focus:ring-2 focus:ring-pink-500/20"
                >
                  {PLAN_OPTIONS.map((o) => (
                    <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-pink-200/70">Status</label>
                <select
                  value={status} onChange={(e) => setStatus(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#1a0820] px-3 py-2 text-sm text-pink-50 focus:border-pink-300/50 focus:outline-none focus:ring-2 focus:ring-pink-500/20"
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-pink-200/70">Expires</label>
                <input
                  type="date"
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#1a0820] px-3 py-2 text-sm text-pink-50 focus:border-pink-300/50 focus:outline-none focus:ring-2 focus:ring-pink-500/20"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-[11px] uppercase tracking-[0.18em] text-pink-200/70">Allowed features</label>
                <label className="inline-flex items-center gap-2 text-[11px] text-pink-100/80">
                  <input
                    type="checkbox"
                    checked={allFeatures}
                    onChange={(e) => setAllFeatures(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-white/30 bg-transparent accent-pink-500"
                  />
                  Grant full access (<code className="font-mono">{`{ all: true }`}</code>)
                </label>
              </div>
              <div className={`grid grid-cols-2 sm:grid-cols-3 gap-2 ${allFeatures ? 'opacity-40 pointer-events-none' : ''}`}>
                {TRIAL_FEATURE_OPTIONS.map((f) => (
                  <label
                    key={f.key}
                    className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-pink-100/85"
                  >
                    <input
                      type="checkbox"
                      checked={!!features[f.key]}
                      onChange={(e) => setFeature(f.key, e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-white/30 bg-transparent accent-pink-500"
                    />
                    <span className="truncate">{f.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={onClose}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-pink-100 hover:bg-white/10"
              >
                Close
              </button>
              <button
                onClick={() => save()}
                disabled={saving}
                className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-pink-900/40 ring-1 ring-white/20 transition disabled:opacity-50 ${IG_GRADIENT}`}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save changes
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Trial & Pricing tab                                                        */
/* -------------------------------------------------------------------------- */

function TrialPricingTab() {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);

  // IG-specific settings keys, with global fallbacks.
  const IG_KEYS = {
    trial_enabled: 'billing.instagram.trial_enabled',
    trial_minutes: 'billing.instagram.trial_duration_minutes',
    trial_features: 'billing.instagram.trial_allowed_features',
    price: 'billing.instagram.subscription_price_usd',
    period: 'billing.instagram.subscription_period_days',
    currency: 'billing.instagram.currency',
  };
  const FALLBACK = {
    trial_enabled: 'billing.trial_enabled',
    trial_minutes: 'billing.trial_duration_minutes',
    trial_features: 'billing.trial_allowed_features',
    price: 'billing.subscription_price_usd',
    period: 'billing.subscription_period_days',
    currency: 'billing.currency',
  };

  const get = useCallback((k) => {
    if (!settings) return undefined;
    if (settings[IG_KEYS[k]] !== undefined) return settings[IG_KEYS[k]];
    return settings[FALLBACK[k]];
  }, [settings]);

  const [trialEnabled, setTrialEnabled] = useState(true);
  const [trialMinutes, setTrialMinutes] = useState(5);
  const [trialFeatures, setTrialFeatures] = useState({});
  const [price, setPrice] = useState(9.99);
  const [periodDays, setPeriodDays] = useState(30);
  const [currency, setCurrency] = useState('USD');

  const load = useCallback(async () => {
    try {
      const r = await getBillingSettings();
      setSettings(r.data?.data || r.data || null);
    } catch (e) {
      toast.error(parseApiError(e), 'Failed to load billing settings');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!settings) return;
    setTrialEnabled(get('trial_enabled') !== false);
    setTrialMinutes(Number(get('trial_minutes') ?? 5));
    const feats = get('trial_features') || [];
    const map = {};
    if (Array.isArray(feats)) for (const f of feats) map[f] = true;
    setTrialFeatures(map);
    setPrice(Number(get('price') ?? 9.99));
    setPeriodDays(Number(get('period') ?? 30));
    setCurrency(String(get('currency') ?? 'USD').toUpperCase());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const save = async (patch) => {
    setSaving(true);
    try {
      await updateBillingSettings(patch);
      toast.success('Instagram billing settings saved');
      await load();
    } catch (e) {
      toast.error(parseApiError(e), 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const onSaveTrial = (e) => {
    e?.preventDefault?.();
    save({
      [IG_KEYS.trial_enabled]: !!trialEnabled,
      [IG_KEYS.trial_minutes]: Number(trialMinutes),
      [IG_KEYS.trial_features]: Object.keys(trialFeatures).filter((k) => trialFeatures[k]),
    });
  };

  const onSavePricing = (e) => {
    e?.preventDefault?.();
    save({
      [IG_KEYS.price]: Number(price),
      [IG_KEYS.period]: Number(periodDays),
      [IG_KEYS.currency]: String(currency || 'USD').toUpperCase(),
    });
  };

  if (!settings) {
    return (
      <GlassCard className="flex items-center justify-center p-10 text-pink-200/70">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading settings…
      </GlassCard>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      {/* Trial settings */}
      <form onSubmit={onSaveTrial}>
        <GlassCard className="p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-pink-300" />
            <h3 className="text-sm font-semibold text-pink-50">Instagram trial</h3>
          </div>
          <p className="mt-1 text-xs text-pink-200/70">
            Trial values configured here apply only to the Instagram panel.
            If a key is left empty, the global default (<code className="font-mono">billing.*</code>) is used.
          </p>

          <label className="mt-4 flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-3">
            <div>
              <p className="text-sm font-medium text-pink-50">Trial enabled</p>
              <p className="text-[11px] text-pink-200/60">When off, new users land directly on the billing page.</p>
            </div>
            <input
              type="checkbox"
              checked={trialEnabled}
              onChange={(e) => setTrialEnabled(e.target.checked)}
              className="h-5 w-5 rounded border-white/30 bg-transparent accent-pink-500"
            />
          </label>

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-pink-200/70">
                Trial duration (minutes)
              </label>
              <input
                type="number" min="1" step="1"
                value={trialMinutes}
                onChange={(e) => setTrialMinutes(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#1a0820] px-3 py-2 text-sm text-pink-50 focus:border-pink-300/50 focus:outline-none focus:ring-2 focus:ring-pink-500/20"
              />
              <p className="mt-1 text-[11px] text-pink-200/60">
                Use 60 for 1h, 1440 for 1 day, 10080 for 1 week, etc.
              </p>
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-pink-200/70">
                Currently effective
              </label>
              <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-pink-100">
                {trialEnabled ? (
                  <span className="text-emerald-200 inline-flex items-center gap-1.5">
                    <ShieldCheck className="h-3.5 w-3.5" /> {prettyMinutes(trialMinutes)}
                  </span>
                ) : (
                  <span className="text-rose-200">Disabled</span>
                )}
              </div>
            </div>
          </div>

          <div className="mt-4">
            <label className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-pink-200/70">
              Allowed features during trial
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {TRIAL_FEATURE_OPTIONS.map((f) => (
                <label
                  key={f.key}
                  className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-pink-100/85"
                >
                  <input
                    type="checkbox"
                    checked={!!trialFeatures[f.key]}
                    onChange={(e) =>
                      setTrialFeatures((prev) => ({ ...prev, [f.key]: e.target.checked }))
                    }
                    className="h-3.5 w-3.5 rounded border-white/30 bg-transparent accent-pink-500"
                  />
                  <span className="truncate">{f.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end">
            <button
              type="submit"
              disabled={saving}
              className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-pink-900/40 ring-1 ring-white/20 transition disabled:opacity-50 ${IG_GRADIENT}`}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save trial settings
            </button>
          </div>
        </GlassCard>
      </form>

      {/* Pricing settings */}
      <form onSubmit={onSavePricing}>
        <GlassCard className="p-5">
          <div className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-pink-300" />
            <h3 className="text-sm font-semibold text-pink-50">Instagram subscription pricing</h3>
          </div>
          <p className="mt-1 text-xs text-pink-200/70">
            Per-platform price and billing period for the Instagram subscription.
          </p>

          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-pink-200/70">Price</label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-pink-200/60">$</span>
                <input
                  type="number" min="0" step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#1a0820] py-2 pl-7 pr-3 text-sm text-pink-50 focus:border-pink-300/50 focus:outline-none focus:ring-2 focus:ring-pink-500/20"
                />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-pink-200/70">Period (days)</label>
              <input
                type="number" min="1" step="1"
                value={periodDays}
                onChange={(e) => setPeriodDays(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#1a0820] px-3 py-2 text-sm text-pink-50 focus:border-pink-300/50 focus:outline-none focus:ring-2 focus:ring-pink-500/20"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-[0.18em] text-pink-200/70">Currency</label>
              <input
                type="text" maxLength={6}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                className="w-full rounded-lg border border-white/10 bg-[#1a0820] px-3 py-2 text-sm text-pink-50 focus:border-pink-300/50 focus:outline-none focus:ring-2 focus:ring-pink-500/20"
              />
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end">
            <button
              type="submit"
              disabled={saving}
              className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-pink-900/40 ring-1 ring-white/20 transition disabled:opacity-50 ${IG_GRADIENT}`}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save pricing
            </button>
          </div>
        </GlassCard>
      </form>
    </div>
  );
}

function prettyMinutes(m) {
  m = Number(m) || 0;
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${(m / 60).toFixed(m % 60 ? 1 : 0)}h`;
  const d = m / (60 * 24);
  return `${d.toFixed(d % 1 ? 1 : 0)}d`;
}

/* -------------------------------------------------------------------------- */
/* Activity tab                                                               */
/* -------------------------------------------------------------------------- */

function ActivityTab() {
  const toast = useToast();
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getRecentActions({ limit: 100 });
      const list = r.data?.data?.actions || r.data?.actions || [];
      setActions(list);
    } catch (e) {
      toast.error(parseApiError(e), 'Failed to load activity');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const igActions = useMemo(
    () => actions.filter((a) => {
      // Surface IG-relevant actions: subscription updates targeting IG,
      // user approvals, bans, etc. We err on the side of showing them
      // all so the admin has audit context.
      const det = a.details || {};
      if (det && typeof det === 'object' && det.platform && det.platform !== 'instagram') return false;
      return true;
    }),
    [actions]
  );

  return (
    <GlassCard className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/10 p-4">
        <div>
          <h3 className="text-sm font-semibold text-pink-50">Recent admin activity</h3>
          <p className="text-[11px] text-pink-200/60">
            Audit trail of admin actions. Filtered to skip Telegram-only subscription updates.
          </p>
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-pink-100 hover:bg-white/10"
        >
          <RefreshCcw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>
      {loading ? (
        <div className="flex items-center justify-center p-10 text-pink-200/70">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : igActions.length === 0 ? (
        <div className="p-10 text-center text-sm text-pink-200/70">
          <AlertCircle className="mx-auto mb-2 h-6 w-6 text-pink-200/40" />
          No admin actions recorded yet.
        </div>
      ) : (
        <ul className="divide-y divide-white/10">
          {igActions.map((a) => (
            <li key={a.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between text-sm">
              <div className="min-w-0">
                <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-[11px] text-pink-100/85">
                  {a.action}
                </span>
                {a.adminEmail || a.admin_email ? (
                  <span className="ml-2 text-pink-200/70 text-xs">
                    by <strong className="text-pink-100">{a.adminEmail || a.admin_email}</strong>
                  </span>
                ) : null}
                {a.targetUserEmail || a.target_user_email ? (
                  <span className="ml-2 text-pink-200/70 text-xs">
                    on <strong className="text-pink-100">{a.targetUserEmail || a.target_user_email}</strong>
                  </span>
                ) : a.targetUserId || a.target_user_id ? (
                  <span className="ml-2 text-pink-200/70 text-xs">
                    on user #{a.targetUserId || a.target_user_id}
                  </span>
                ) : null}
              </div>
              <span className="text-[11px] text-pink-200/60">
                {a.performedAt || a.performed_at
                  ? formatRelativeTime(a.performedAt || a.performed_at)
                  : '—'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  );
}
