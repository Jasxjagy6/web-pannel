import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Users, Search, Loader2, ShieldCheck, Ban, RefreshCcw, Settings2, Trash2,
  CheckCircle2, X, ChevronDown, Filter,
} from 'lucide-react';
import {
  listUsers, approveUser, banUser, unbanUser, deleteUser,
  setSubscription, getSystemStats,
} from '../api/admin';
import { useToast } from '../components/common/Toast';
import { parseApiError } from '../utils/formatters';

const STATUS_BADGE = {
  pending: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  approved: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  banned: 'bg-error-500/15 text-error-300 border-error-500/30',
};

const SUB_PLANS = ['trial', 'basic', 'pro', 'enterprise'];

export default function Admin() {
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Admin Panel</h1>
          <p className="mt-1 text-sm text-dark-400">Manage users, approvals, and subscriptions.</p>
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-2 self-start rounded-xl border border-dark-700 bg-dark-800/70 px-3 py-2 text-sm font-medium text-dark-200 hover:border-dark-600 hover:bg-dark-800"
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
