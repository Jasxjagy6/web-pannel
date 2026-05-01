import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Users, Search, Loader2, ShieldCheck, Ban, RefreshCcw, Settings2, Trash2,
  CheckCircle2, X, ChevronDown, Filter,
  CreditCard, Sparkles, Wallet, DollarSign, Save, AlertCircle, ListChecks,
} from 'lucide-react';
import {
  listUsers, approveUser, banUser, unbanUser, deleteUser,
  setSubscription, getSystemStats,
  getBillingSettings, updateBillingSettings, listAdminInvoices,
  grantUserSubscription, expireUserSubscription,
} from '../api/admin';
import { useToast } from '../components/common/Toast';
import { parseApiError, formatDateTime, formatRelativeTime } from '../utils/formatters';

const TRIAL_FEATURE_OPTIONS = [
  { key: 'dashboard',   label: 'Dashboard' },
  { key: 'sessions',    label: 'Sessions' },
  { key: 'scrape',      label: 'Scrape' },
  { key: 'messaging',   label: 'Messaging' },
  { key: 'groups',      label: 'Groups' },
  { key: 'lists',       label: 'Lists' },
  { key: 'reports',     label: 'Reports' },
  { key: 'get_otp',     label: 'Get OTP' },
  { key: 'change_2fa',  label: 'Change 2FA' },
  { key: 'proxies',     label: 'Proxies' },
  { key: 'anti_detect', label: 'Anti-Detect' },
  { key: 'privacy',     label: 'Privacy' },
];

const STATUS_BADGE = {
  pending: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  approved: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  banned: 'bg-error-500/15 text-error-300 border-error-500/30',
};

const SUB_PLANS = ['trial', 'basic', 'pro', 'enterprise'];

export default function Admin() {
  const [tab, setTab] = useState('users');
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Admin Panel</h1>
          <p className="mt-1 text-sm text-dark-400">
            Manage users, approvals, subscriptions and billing.
          </p>
        </div>
        <AdminTabs tab={tab} onChange={setTab} />
      </div>

      {tab === 'users'   && <UsersTab />}
      {tab === 'billing' && <BillingAdminTab />}
    </div>
  );
}

function AdminTabs({ tab, onChange }) {
  const items = [
    { key: 'users',   label: 'Users',           icon: Users },
    { key: 'billing', label: 'Billing & Trial', icon: CreditCard },
  ];
  return (
    <div className="inline-flex rounded-xl border border-dark-700 bg-dark-900/60 p-1">
      {items.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
            tab === key
              ? 'bg-gradient-to-r from-primary-600 to-blue-600 text-white shadow shadow-primary-600/20'
              : 'text-dark-300 hover:bg-dark-800/60 hover:text-white'
          }`}
        >
          <Icon className="h-4 w-4" /> {label}
        </button>
      ))}
    </div>
  );
}

function UsersTab() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [editing, setEditing] = useState(null);
  const [actingUserId, setActingUserId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, st] = await Promise.all([
        listUsers({ search: search || undefined, status: statusFilter || undefined, limit: 100 }),
        getSystemStats(),
      ]);
      setUsers(list.data?.data?.users || []);
      setTotal(list.data?.data?.total || 0);
      setStats(st.data?.data || null);
    } catch (e) {
      toast.error(parseApiError(e), 'Failed to load admin data');
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, toast]);

  useEffect(() => { load(); }, [load]);

  const onApprove = async (u) => {
    setActingUserId(u.id);
    try {
      await approveUser(u.id);
      toast.success(`${u.email} approved`);
      await load();
    } catch (e) {
      toast.error(parseApiError(e), 'Approve failed');
    } finally { setActingUserId(null); }
  };

  const onBan = async (u) => {
    const reason = prompt('Ban reason (optional):') ?? '';
    setActingUserId(u.id);
    try {
      await banUser(u.id, reason);
      toast.success(`${u.email} banned`);
      await load();
    } catch (e) {
      toast.error(parseApiError(e), 'Ban failed');
    } finally { setActingUserId(null); }
  };

  const onUnban = async (u) => {
    setActingUserId(u.id);
    try {
      await unbanUser(u.id);
      toast.success(`${u.email} unbanned`);
      await load();
    } catch (e) {
      toast.error(parseApiError(e), 'Unban failed');
    } finally { setActingUserId(null); }
  };

  const onDelete = async (u) => {
    if (!confirm(`Permanently delete ${u.email}? This cascades to all their sessions and jobs.`)) return;
    setActingUserId(u.id);
    try {
      await deleteUser(u.id);
      toast.success('User deleted');
      await load();
    } catch (e) {
      toast.error(parseApiError(e), 'Delete failed');
    } finally { setActingUserId(null); }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button
          onClick={load}
          className="inline-flex items-center gap-2 rounded-xl border border-dark-700 bg-dark-800/70 px-3 py-2 text-sm font-medium text-dark-200 hover:border-dark-600 hover:bg-dark-800"
        >
          <RefreshCcw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <StatsGrid stats={stats} />

      <div className="rounded-2xl border border-dark-800 bg-dark-900/60 backdrop-blur-sm">
        <div className="flex flex-col gap-3 border-b border-dark-800 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-dark-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by email"
              className="w-full rounded-xl border border-dark-700 bg-dark-900/60 py-2 pl-10 pr-3 text-sm text-white placeholder:text-dark-500 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-dark-500" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-xl border border-dark-700 bg-dark-900/60 px-3 py-2 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="banned">Banned</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center p-10 text-dark-400">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading users…
          </div>
        ) : users.length === 0 ? (
          <div className="p-10 text-center text-sm text-dark-400">
            <Users className="mx-auto mb-2 h-8 w-8 text-dark-600" />
            No users match this filter.
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wider text-dark-500">
                  <tr className="border-b border-dark-800">
                    <th className="p-3">User</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Subscription</th>
                    <th className="p-3">Sessions</th>
                    <th className="p-3">Created</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <UserRow
                      key={u.id} u={u}
                      acting={actingUserId === u.id}
                      onApprove={onApprove}
                      onBan={onBan}
                      onUnban={onUnban}
                      onDelete={onDelete}
                      onEdit={() => setEditing(u)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <ul className="divide-y divide-dark-800 md:hidden">
              {users.map((u) => (
                <UserCard
                  key={u.id} u={u}
                  acting={actingUserId === u.id}
                  onApprove={onApprove}
                  onBan={onBan}
                  onUnban={onUnban}
                  onDelete={onDelete}
                  onEdit={() => setEditing(u)}
                />
              ))}
            </ul>
          </>
        )}
        <div className="border-t border-dark-800 p-3 text-right text-xs text-dark-500">
          Showing {users.length} of {total} users
        </div>
      </div>

      {editing && (
        <SubscriptionDrawer
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}
    </div>
  );
}

function StatsGrid({ stats }) {
  const items = [
    { label: 'Total users', value: stats?.total_users ?? '—' },
    { label: 'Pending', value: stats?.pending_users ?? '—', tone: 'amber' },
    { label: 'Approved', value: stats?.approved_users ?? '—', tone: 'emerald' },
    { label: 'Banned', value: stats?.banned_users ?? '—', tone: 'rose' },
    { label: 'Active subs', value: stats?.active_subscriptions ?? '—' },
    { label: 'Active sessions', value: stats?.active_sessions ?? '—' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-2xl border border-dark-800 bg-dark-900/60 p-3 backdrop-blur-sm sm:p-4"
        >
          <p className="text-[10px] uppercase tracking-wider text-dark-500 sm:text-xs">{it.label}</p>
          <p className="mt-1 text-xl font-bold text-white sm:text-2xl">{it.value}</p>
        </div>
      ))}
    </div>
  );
}

function UserRow({ u, acting, onApprove, onBan, onUnban, onDelete, onEdit }) {
  return (
    <tr className="border-b border-dark-800/60 hover:bg-dark-800/40">
      <td className="p-3">
        <div className="flex flex-col">
          <span className="font-medium text-white">{u.email}</span>
          <span className="text-xs text-dark-500">#{u.id} · {u.role}</span>
        </div>
      </td>
      <td className="p-3">
        <StatusBadge status={u.status} />
      </td>
      <td className="p-3 text-dark-300">
        {u.subscription?.plan ? (
          <span className="capitalize">{u.subscription.plan} <span className="text-dark-500">({u.subscription.status})</span></span>
        ) : <span className="text-dark-500">—</span>}
      </td>
      <td className="p-3 text-dark-300">{u.sessionsCount ?? 0} <span className="text-dark-500">({u.activeSessionsCount ?? 0} active)</span></td>
      <td className="p-3 text-dark-400">{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
      <td className="p-3">
        <RowActions u={u} acting={acting} onApprove={onApprove} onBan={onBan} onUnban={onUnban} onDelete={onDelete} onEdit={onEdit} />
      </td>
    </tr>
  );
}

function UserCard({ u, acting, onApprove, onBan, onUnban, onDelete, onEdit }) {
  return (
    <li className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-white">{u.email}</p>
          <p className="text-xs text-dark-500">#{u.id} · {u.role} · {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</p>
        </div>
        <StatusBadge status={u.status} />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-dark-300">
        <span><span className="text-dark-500">Subscription:</span> {u.subscription?.plan ? `${u.subscription.plan} (${u.subscription.status})` : '—'}</span>
        <span><span className="text-dark-500">Sessions:</span> {u.sessionsCount ?? 0} ({u.activeSessionsCount ?? 0} active)</span>
      </div>
      <RowActions u={u} acting={acting} onApprove={onApprove} onBan={onBan} onUnban={onUnban} onDelete={onDelete} onEdit={onEdit} />
    </li>
  );
}

function RowActions({ u, acting, onApprove, onBan, onUnban, onDelete, onEdit }) {
  if (u.role === 'admin') {
    return <span className="text-xs text-dark-500">Admin (protected)</span>;
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {u.status !== 'approved' && (
        <button
          onClick={() => onApprove(u)} disabled={acting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
        >
          <CheckCircle2 className="h-3.5 w-3.5" /> Approve
        </button>
      )}
      {u.status === 'banned' ? (
        <button
          onClick={() => onUnban(u)} disabled={acting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
        >
          <RefreshCcw className="h-3.5 w-3.5" /> Unban
        </button>
      ) : (
        <button
          onClick={() => onBan(u)} disabled={acting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-error-500/40 bg-error-500/10 px-2.5 py-1 text-xs font-medium text-error-300 hover:bg-error-500/20 disabled:opacity-50"
        >
          <Ban className="h-3.5 w-3.5" /> Ban
        </button>
      )}
      <button
        onClick={onEdit} disabled={acting}
        className="inline-flex items-center gap-1.5 rounded-lg border border-primary-500/40 bg-primary-500/10 px-2.5 py-1 text-xs font-medium text-primary-300 hover:bg-primary-500/20 disabled:opacity-50"
      >
        <Settings2 className="h-3.5 w-3.5" /> Subscription
      </button>
      <button
        onClick={() => onDelete(u)} disabled={acting}
        className="inline-flex items-center gap-1.5 rounded-lg border border-dark-700 bg-dark-900/60 px-2.5 py-1 text-xs font-medium text-dark-300 hover:border-error-500/40 hover:text-error-300 disabled:opacity-50"
        title="Permanently delete user"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function StatusBadge({ status }) {
  const cls = STATUS_BADGE[status] || 'bg-dark-700 text-dark-300 border-dark-600';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${cls}`}>
      {status === 'approved' && <ShieldCheck className="h-3 w-3" />}
      {status}
    </span>
  );
}

function SubscriptionDrawer({ user, onClose, onSaved }) {
  const toast = useToast();
  const [plan, setPlan] = useState(user.subscription?.plan || 'trial');
  const [status, setStatus] = useState(user.subscription?.status || 'active');
  const [expires, setExpires] = useState(
    user.subscription?.expiresAt ? user.subscription.expiresAt.slice(0, 10) : ''
  );
  const [features, setFeatures] = useState(JSON.stringify(user.subscription?.features || { all: true }, null, 2));
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    let parsed = {};
    try {
      parsed = features.trim() ? JSON.parse(features) : {};
    } catch {
      toast.error('Features must be valid JSON');
      return;
    }
    setSaving(true);
    try {
      await setSubscription(user.id, {
        plan, status,
        expiresAt: expires ? new Date(expires).toISOString() : null,
        features: parsed,
      });
      toast.success('Subscription updated');
      onSaved();
    } catch (e) {
      toast.error(parseApiError(e), 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-t-2xl border border-dark-700 bg-dark-900 shadow-2xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-dark-800 p-4">
          <div>
            <h3 className="text-base font-semibold text-white">Subscription</h3>
            <p className="text-xs text-dark-500 truncate">{user.email}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-dark-400 hover:bg-dark-800 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-dark-300">Plan</label>
            <select
              value={plan} onChange={(e) => setPlan(e.target.value)}
              className="w-full rounded-xl border border-dark-700 bg-dark-900/60 px-3 py-2 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              {SUB_PLANS.map((p) => (<option key={p} value={p}>{p}</option>))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-dark-300">Status</label>
            <select
              value={status} onChange={(e) => setStatus(e.target.value)}
              className="w-full rounded-xl border border-dark-700 bg-dark-900/60 px-3 py-2 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              <option value="inactive">Inactive</option>
              <option value="active">Active</option>
              <option value="expired">Expired</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-dark-300">Expires at</label>
            <input
              type="date" value={expires} onChange={(e) => setExpires(e.target.value)}
              className="w-full rounded-xl border border-dark-700 bg-dark-900/60 px-3 py-2 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-dark-300">
              Features (JSON)
            </label>
            <textarea
              rows={5}
              value={features}
              onChange={(e) => setFeatures(e.target.value)}
              className="w-full rounded-xl border border-dark-700 bg-dark-900/60 px-3 py-2 font-mono text-xs text-white focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            />
            <p className="mt-1 text-[11px] text-dark-500">Use <code>{'{"all":true}'}</code> to grant every feature, or list specific keys.</p>
          </div>
        </div>
        <div className="flex flex-col gap-2 border-t border-dark-800 p-4 sm:flex-row sm:justify-end">
          <button
            onClick={onClose}
            className="rounded-xl border border-dark-700 bg-dark-900/60 px-4 py-2 text-sm font-medium text-dark-200 hover:border-dark-600 hover:bg-dark-800"
          >
            Cancel
          </button>
          <button
            onClick={onSave} disabled={saving}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary-600 to-blue-600 px-4 py-2 text-sm font-semibold text-white hover:from-primary-500 hover:to-blue-500 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Save subscription
          </button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Billing & Trial admin tab
// =====================================================================
function BillingAdminTab() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(null);
  const [stats, setStats] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [invoiceStatus, setInvoiceStatus] = useState('');
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, list] = await Promise.all([
        getBillingSettings(),
        listAdminInvoices({
          status: invoiceStatus || undefined,
          search: invoiceSearch || undefined,
          limit: 100,
        }),
      ]);
      setSettings(s.data?.data || null);
      setInvoices(list.data?.data?.invoices || []);
      setStats(list.data?.data?.stats || null);
    } catch (e) {
      toast.error(parseApiError(e), 'Failed to load billing data');
    } finally {
      setLoading(false);
    }
  }, [toast, invoiceStatus, invoiceSearch]);

  useEffect(() => { load(); }, [load]);

  const onSaveSettings = async (patch) => {
    setSaving(true);
    try {
      await updateBillingSettings(patch);
      toast.success('Billing settings saved');
      await load();
    } catch (e) {
      toast.error(parseApiError(e), 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-10 text-dark-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading billing…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <BillingStatsGrid stats={stats} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <PriceSettingsCard
          settings={settings} saving={saving} onSave={onSaveSettings}
        />
        <TrialSettingsCard
          settings={settings} saving={saving} onSave={onSaveSettings}
        />
      </div>
      <InvoicesAdminCard
        invoices={invoices}
        status={invoiceStatus}
        onStatusChange={setInvoiceStatus}
        search={invoiceSearch}
        onSearchChange={setInvoiceSearch}
        onRefresh={load}
        toast={toast}
        onChanged={load}
      />
    </div>
  );
}

function BillingStatsGrid({ stats }) {
  if (!stats) return null;
  const cards = [
    { label: 'Paid (lifetime)',  value: `$${Number(stats.gross_paid_usd || 0).toFixed(2)}`, icon: DollarSign },
    { label: 'Paid (30d)',       value: `$${Number(stats.paid_usd_30d || 0).toFixed(2)}`,    icon: DollarSign },
    { label: 'Active subs',      value: stats.active_paid_subs ?? '—',                       icon: ShieldCheck },
    { label: 'Active trials',    value: stats.active_trials ?? '—',                          icon: Sparkles },
    { label: 'Total invoices',   value: stats.total_invoices ?? '—',                         icon: ListChecks },
    { label: 'Pending invoices', value: stats.pending_invoices ?? '—',                       icon: Wallet },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c) => (
        <div key={c.label} className="rounded-2xl border border-dark-800 bg-dark-900/60 p-3 backdrop-blur-sm sm:p-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-dark-500 sm:text-xs">
            <c.icon className="h-3.5 w-3.5" /> {c.label}
          </div>
          <p className="mt-1 text-xl font-bold text-white sm:text-2xl">{c.value}</p>
        </div>
      ))}
    </div>
  );
}

function PriceSettingsCard({ settings, saving, onSave }) {
  const [price, setPrice] = useState(settings?.['billing.subscription_price_usd'] ?? 9.99);
  const [periodDays, setPeriodDays] = useState(settings?.['billing.subscription_period_days'] ?? 30);
  const [currency, setCurrency] = useState(settings?.['billing.currency'] ?? 'USD');

  useEffect(() => {
    setPrice(settings?.['billing.subscription_price_usd'] ?? 9.99);
    setPeriodDays(settings?.['billing.subscription_period_days'] ?? 30);
    setCurrency(settings?.['billing.currency'] ?? 'USD');
  }, [settings]);

  const submit = (e) => {
    e?.preventDefault?.();
    onSave({
      'billing.subscription_price_usd': Number(price),
      'billing.subscription_period_days': Number(periodDays),
      'billing.currency': String(currency || 'USD').toUpperCase(),
    });
  };

  return (
    <form onSubmit={submit} className="rounded-2xl border border-dark-800 bg-dark-900/60 p-5 backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-primary-300" />
        <h3 className="text-sm font-semibold text-white">Subscription pricing</h3>
      </div>
      <p className="mt-1 text-xs text-dark-400">
        Set the monthly subscription price shown on the user-facing checkout page.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-dark-300">Price</label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dark-500">$</span>
            <input
              type="number" min="0" step="0.01" value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-full rounded-xl border border-dark-700 bg-dark-900/60 py-2 pl-7 pr-3 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            />
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-dark-300">Period (days)</label>
          <input
            type="number" min="1" step="1" value={periodDays}
            onChange={(e) => setPeriodDays(e.target.value)}
            className="w-full rounded-xl border border-dark-700 bg-dark-900/60 px-3 py-2 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-dark-300">Currency</label>
          <input
            type="text" value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="w-full rounded-xl border border-dark-700 bg-dark-900/60 px-3 py-2 text-sm font-mono uppercase tracking-wider text-white focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            placeholder="USD"
          />
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200/90">
        <AlertCircle className="mr-1.5 inline h-3.5 w-3.5 -translate-y-px" />
        OxaPay creates the invoice in this fiat amount and the customer can pay in any supported cryptocurrency.
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="submit" disabled={saving}
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-primary-600 to-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-primary-600/25 hover:from-primary-500 hover:to-blue-500 disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save pricing
        </button>
      </div>
    </form>
  );
}

function TrialSettingsCard({ settings, saving, onSave }) {
  const [enabled, setEnabled] = useState(!!settings?.['billing.trial_enabled']);
  const [duration, setDuration] = useState(settings?.['billing.trial_duration_minutes'] ?? 5);
  const [allowed, setAllowed] = useState(
    Array.isArray(settings?.['billing.trial_allowed_features'])
      ? settings['billing.trial_allowed_features']
      : []
  );

  useEffect(() => {
    setEnabled(!!settings?.['billing.trial_enabled']);
    setDuration(settings?.['billing.trial_duration_minutes'] ?? 5);
    setAllowed(Array.isArray(settings?.['billing.trial_allowed_features'])
      ? settings['billing.trial_allowed_features']
      : []);
  }, [settings]);

  const toggle = (key) => {
    setAllowed((cur) => cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]);
  };

  const submit = (e) => {
    e?.preventDefault?.();
    onSave({
      'billing.trial_enabled': !!enabled,
      'billing.trial_duration_minutes': Number(duration),
      'billing.trial_allowed_features': allowed,
    });
  };

  return (
    <form onSubmit={submit} className="rounded-2xl border border-dark-800 bg-dark-900/60 p-5 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-300" />
          <h3 className="text-sm font-semibold text-white">Free trial</h3>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <span className="text-xs text-dark-400">{enabled ? 'Enabled' : 'Disabled'}</span>
          <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${enabled ? 'bg-amber-500/60' : 'bg-dark-700'}`}>
            <input
              type="checkbox" className="peer sr-only" checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </span>
        </label>
      </div>
      <p className="mt-1 text-xs text-dark-400">
        Let new users try the panel without paying. You control how long the trial lasts and which features are unlocked.
      </p>

      <div className="mt-4">
        <label className="mb-1.5 block text-xs font-medium text-dark-300">Duration (minutes)</label>
        <input
          type="number" min="1" step="1" value={duration} disabled={!enabled}
          onChange={(e) => setDuration(e.target.value)}
          className="w-32 rounded-xl border border-dark-700 bg-dark-900/60 px-3 py-2 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 disabled:opacity-50"
        />
        <p className="mt-1 text-[11px] text-dark-500">
          The default value of <span className="font-mono text-dark-300">5</span> matches a typical first-time evaluation window.
        </p>
      </div>

      <div className="mt-4">
        <label className="mb-1.5 block text-xs font-medium text-dark-300">Allowed features during trial</label>
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-dark-700 bg-dark-950/60 p-3 sm:grid-cols-3">
          {TRIAL_FEATURE_OPTIONS.map((opt) => {
            const on = allowed.includes(opt.key);
            return (
              <button
                key={opt.key} type="button"
                onClick={() => toggle(opt.key)}
                disabled={!enabled}
                className={`flex items-center justify-between rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  on
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                    : 'border-dark-700 bg-dark-900/60 text-dark-300 hover:border-dark-600'
                } disabled:opacity-50`}
              >
                {opt.label}
                {on ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="text-dark-600">·</span>}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] text-dark-500">Click to toggle. Only the highlighted features are reachable during a trial.</p>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="submit" disabled={saving}
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-amber-500/25 hover:from-amber-400 hover:to-orange-400 disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save trial config
        </button>
      </div>
    </form>
  );
}

function InvoicesAdminCard({
  invoices, status, onStatusChange, search, onSearchChange, onRefresh, toast, onChanged,
}) {
  const [acting, setActing] = useState(null);

  const onGrant = async (inv) => {
    const days = parseInt(prompt(`Grant additional days to ${inv.email}?`, '30') || '0', 10);
    if (!days || days <= 0) return;
    setActing(inv.id);
    try {
      await grantUserSubscription(inv.user_id, { days, plan: 'manual' });
      toast.success(`Granted ${days} days to ${inv.email}`);
      onChanged?.();
    } catch (e) {
      toast.error(parseApiError(e), 'Grant failed');
    } finally { setActing(null); }
  };

  const onExpire = async (inv) => {
    if (!confirm(`Force-expire subscription for ${inv.email}?`)) return;
    setActing(inv.id);
    try {
      await expireUserSubscription(inv.user_id, { reason: 'admin override' });
      toast.success(`Expired subscription for ${inv.email}`);
      onChanged?.();
    } catch (e) {
      toast.error(parseApiError(e), 'Expire failed');
    } finally { setActing(null); }
  };

  return (
    <div className="rounded-2xl border border-dark-800 bg-dark-900/60 backdrop-blur-sm">
      <div className="flex flex-col gap-3 border-b border-dark-800 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-dark-400" />
          <h3 className="text-sm font-semibold text-white">Payments</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-dark-500" />
            <input
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search by email or track id"
              className="w-64 rounded-xl border border-dark-700 bg-dark-900/60 py-2 pl-9 pr-3 text-sm text-white placeholder:text-dark-500 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            />
          </div>
          <select
            value={status} onChange={(e) => onStatusChange(e.target.value)}
            className="rounded-xl border border-dark-700 bg-dark-900/60 px-3 py-2 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="paid">Paid</option>
            <option value="failed">Failed</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
            <option value="refunded">Refunded</option>
          </select>
          <button
            onClick={onRefresh}
            className="inline-flex items-center gap-2 rounded-xl border border-dark-700 bg-dark-800/70 px-3 py-2 text-sm text-dark-200 hover:bg-dark-800"
          >
            <RefreshCcw className="h-4 w-4" /> Refresh
          </button>
        </div>
      </div>

      {invoices.length === 0 ? (
        <div className="p-8 text-center text-sm text-dark-500">No invoices match this filter.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wider text-dark-500">
              <tr className="border-b border-dark-800">
                <th className="p-3">Created</th>
                <th className="p-3">User</th>
                <th className="p-3">Amount</th>
                <th className="p-3">Status</th>
                <th className="p-3">OxaPay track</th>
                <th className="p-3">Granted until</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-dark-800/60 hover:bg-dark-800/40">
                  <td className="p-3 text-xs text-dark-300">
                    <div>{formatDateTime(inv.created_at)}</div>
                    <div className="text-[11px] text-dark-500">{formatRelativeTime(inv.created_at)}</div>
                  </td>
                  <td className="p-3 font-medium text-white">{inv.email}</td>
                  <td className="p-3 font-medium text-white">${Number(inv.amount_usd).toFixed(2)} {inv.currency}</td>
                  <td className="p-3">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                      inv.status === 'paid' ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300' :
                      inv.status === 'pending' ? 'border-amber-500/30 bg-amber-500/15 text-amber-300' :
                      inv.status === 'failed' ? 'border-rose-500/30 bg-rose-500/15 text-rose-300' :
                      'border-dark-600 bg-dark-700/40 text-dark-300'
                    }`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-[11px] text-dark-400">
                    {inv.oxapay_track_id ? inv.oxapay_track_id.slice(0, 14) + '…' : '—'}
                  </td>
                  <td className="p-3 text-xs text-dark-300">
                    {inv.granted_until ? formatDateTime(inv.granted_until) : '—'}
                  </td>
                  <td className="p-3 text-right">
                    <div className="inline-flex flex-wrap justify-end gap-1">
                      <button
                        onClick={() => onGrant(inv)} disabled={acting === inv.id}
                        className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                        title="Grant additional subscription days"
                      >
                        <CheckCircle2 className="h-3 w-3" /> Grant
                      </button>
                      <button
                        onClick={() => onExpire(inv)} disabled={acting === inv.id}
                        className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200 hover:bg-rose-500/20 disabled:opacity-50"
                        title="Force-expire subscription"
                      >
                        <Ban className="h-3 w-3" /> Expire
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
