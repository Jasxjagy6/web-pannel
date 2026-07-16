import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Pencil, RefreshCw, ArrowLeftRight, DownloadCloud } from 'lucide-react';
import { trackingAccountsAPI } from '@/api';
import { useToast } from '../../components/common/Toast';
import { parseApiError, formatDate } from '@/utils/formatters';
import ServerPaginatedTable from '../../components/tracking/ServerPaginatedTable';
import FilterBar from '../../components/tracking/FilterBar';
import AccountFormModal from '../../components/tracking/AccountFormModal';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import StatusBadge from '../../components/common/StatusBadge';
import BulkActionToolbar from '../../components/tracking/BulkActionToolbar';
import ImportExportModal from '../../components/tracking/ImportExportModal';
import Avatar from '../../components/tracking/Avatar';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

const STATUS_OPTIONS = ['available', 'reserved', 'sold', 'dead', 'banned', 'deleted', 'lost_access'];

export default function TrackingAccounts() {
  const navigate = useNavigate();
  const { success, error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();

  const [accounts, setAccounts] = useState([]);
  const [pagination, setPagination] = useState({ total: 0, currentPage: 1, pageSize: 20 });
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState('created_at');
  const [order, setOrder] = useState('DESC');
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState([]);

  const [showFormModal, setShowFormModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showImportExport, setShowImportExport] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const params = { ...filters, page, limit: 20, sort, order };
      const response = await trackingAccountsAPI.list(params);
      setAccounts(response.data.data?.accounts || []);
      setPagination(response.data.data?.pagination || { total: 0, currentPage: 1, pageSize: 20 });
    } catch (err) {
      showError(parseApiError(err), 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page, sort, order]);

  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);
  useEffect(() => { setPage(1); }, [filters]);
  useEffect(() => { setSelectedIds([]); }, [filters, page]);

  // Keyboard shortcuts: "/" focuses search, "n" opens the create-account
  // modal — skipped while the user is already typing in a field.
  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (isTyping) {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('tracking-search-input')?.focus();
      } else if (e.key === 'n' && hasPermission('edit')) {
        e.preventDefault();
        openCreate();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPermission]);

  const openCreate = () => { setEditingAccount(null); setShowFormModal(true); };
  const openEdit = (account) => { setEditingAccount(account); setShowFormModal(true); };

  const handleSubmit = async (payload) => {
    setSubmitting(true);
    try {
      if (editingAccount) {
        await trackingAccountsAPI.update(editingAccount.id, payload);
        success('Account updated');
      } else {
        await trackingAccountsAPI.create(payload);
        success('Account created');
      }
      setShowFormModal(false);
      fetchAccounts();
    } catch (err) {
      showError(parseApiError(err), 'Failed to save account');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await trackingAccountsAPI.remove(deleteTarget.id);
      success('Account deleted');
      fetchAccounts();
    } catch (err) {
      showError(parseApiError(err), 'Failed to delete account');
    }
  };

  const handleSyncSessions = async () => {
    setSyncing(true);
    try {
      const res = await trackingAccountsAPI.syncAllLoggedIn();
      const d = res.data.data || {};
      success(`Synced ${d.synced || 0} of ${d.candidates || 0} logged-in session(s)`);
      fetchAccounts();
    } catch (err) {
      showError(parseApiError(err), 'Session sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const handleQuickStatus = async (account, status) => {
    try {
      await trackingAccountsAPI.changeStatus(account.id, { status });
      success(`Status changed to ${status}`);
      fetchAccounts();
    } catch (err) {
      showError(parseApiError(err), 'Failed to change status');
    }
  };

  const columns = [
    {
      key: 'internalCode', label: 'ID', sortable: true, className: 'font-mono text-gray-400',
      render: (r) => r.internalCode,
    },
    {
      key: 'username', label: 'Account', sortable: true,
      render: (r) => (
        <div className="flex items-center gap-2.5">
          <Avatar src={r.avatarThumb} name={r.displayName || r.username} size={32} />
          <div>
            <div className="text-gray-100 font-medium">{r.displayName || (r.username ? `@${r.username}` : '—')}</div>
            <div className="text-xs text-gray-500">{r.username && r.displayName ? `@${r.username}` : ''} {r.phoneNumber}</div>
          </div>
        </div>
      ),
    },
    { key: 'country', label: 'Country', sortable: true, render: (r) => r.country || '—' },
    {
      key: 'isPremium', label: 'Premium', render: (r) => (r.isPremium ? '⭐ Premium' : '—'),
    },
    {
      key: 'status', label: 'Status', sortable: true,
      render: (r) => (
        hasPermission('edit') ? (
          <select
            value={r.status}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => handleQuickStatus(r, e.target.value)}
            className="bg-transparent border-none text-xs focus:outline-none focus:ring-0 cursor-pointer"
          >
            {STATUS_OPTIONS.map((s) => <option key={s} value={s} className="bg-dark-800">{s.replace('_', ' ')}</option>)}
          </select>
        ) : (
          <StatusBadge status={r.status} size="sm" />
        )
      ),
    },
    {
      key: 'salePrice', label: 'Sale price', sortable: true,
      render: (r) => (r.salePrice != null ? `$${Number(r.salePrice).toFixed(2)}` : '—'),
    },
    { key: 'createdAt', label: 'Added', sortable: true, render: (r) => formatDate(r.createdAt) },
  ];

  if (hasPermission('edit') || hasPermission('delete')) {
    columns.push({
      key: 'actions', label: '', className: 'text-right w-24',
      render: (r) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {hasPermission('edit') && (
            <button onClick={() => openEdit(r)} className="rounded-lg p-1.5 text-gray-400 hover:text-white hover:bg-white/10" title="Edit">
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {hasPermission('delete') && (
            <button onClick={() => setDeleteTarget(r)} className="rounded-lg p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-400/10" title="Delete">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Tracking Accounts</h1>
          <p className="text-sm text-gray-400 mt-1">{pagination.total} account{pagination.total === 1 ? '' : 's'}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchAccounts}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={() => setShowImportExport(true)}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5"
          >
            <ArrowLeftRight className="h-4 w-4" /> Import / Export
          </button>
          {hasPermission('edit') && (
            <button
              onClick={handleSyncSessions}
              disabled={syncing}
              className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5 disabled:opacity-50"
              title="Pull live details from all logged-in Telegram sessions"
            >
              <DownloadCloud className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} /> {syncing ? 'Syncing…' : 'Sync sessions'}
            </button>
          )}
          {hasPermission('edit') && (
            <button
              onClick={openCreate}
              className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
            >
              <Plus className="h-4 w-4" /> Add Account
            </button>
          )}
        </div>
      </div>

      <FilterBar filters={filters} onChange={setFilters} />

      {selectedIds.length > 0 && (
        <BulkActionToolbar
          selectedIds={selectedIds}
          onClearSelection={() => setSelectedIds([])}
          onCompleted={fetchAccounts}
        />
      )}

      <ServerPaginatedTable
        columns={columns}
        rows={accounts}
        loading={loading}
        page={pagination.currentPage}
        pageSize={pagination.pageSize}
        total={pagination.total}
        onPageChange={setPage}
        sort={sort}
        order={order}
        onSortChange={(s, o) => { setSort(s); setOrder(o); }}
        selectable={hasPermission('edit') || hasPermission('delete')}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        onRowClick={(row) => navigate(`/tracking/accounts/${row.id}`)}
        emptyMessage="No tracking accounts yet — add your first one to get started."
      />

      <ImportExportModal
        isOpen={showImportExport}
        onClose={() => setShowImportExport(false)}
        currentFilters={filters}
        onImported={fetchAccounts}
      />

      <AccountFormModal
        isOpen={showFormModal}
        onClose={() => setShowFormModal(false)}
        onSubmit={handleSubmit}
        account={editingAccount}
        submitting={submitting}
      />

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete account?"
        message={`This soft-deletes ${deleteTarget?.internalCode || 'this account'}. It can be restored from the detail view.`}
        confirmLabel="Delete"
      />
    </div>
  );
}
