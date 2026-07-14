import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2, RotateCcw, Loader2 } from 'lucide-react';
import { trackingAccountsAPI } from '@/api';
import { useToast } from '../../components/common/Toast';
import { parseApiError, formatDate, formatDateTime } from '@/utils/formatters';
import StatusBadge from '../../components/common/StatusBadge';
import AccountFormModal from '../../components/tracking/AccountFormModal';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import SessionTab from '../../components/tracking/SessionTab';
import SimTab from '../../components/tracking/SimTab';
import SecurityTab from '../../components/tracking/SecurityTab';
import PurchaseTab from '../../components/tracking/PurchaseTab';
import SalesTab from '../../components/tracking/SalesTab';
import AssignmentsTab from '../../components/tracking/AssignmentsTab';
import NotesTab from '../../components/tracking/NotesTab';
import AttachmentsTab from '../../components/tracking/AttachmentsTab';
import TagManagerModal from '../../components/tracking/TagManagerModal';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

const STATUS_OPTIONS = ['available', 'reserved', 'sold', 'dead', 'banned', 'deleted', 'lost_access'];

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'session', label: 'Session' },
  { key: 'sim', label: 'SIM' },
  { key: 'security', label: 'Security' },
  { key: 'purchase', label: 'Purchase' },
  { key: 'sales', label: 'Sales' },
  { key: 'assignments', label: 'Assignments' },
  { key: 'notes', label: 'Notes' },
  { key: 'attachments', label: 'Attachments' },
];

function hasTelegramMeta(meta) {
  if (!meta) return false;
  return !!(
    meta.telegramRole || meta.dateOfBirth || meta.dateOfBirthVerified != null ||
    meta.premiumExpiresAt || meta.spamblockStatus || meta.spamblockUntil ||
    meta.hasProfilePic || meta.statsSpamCount > 0 || meta.statsInvitesCount > 0
  );
}

function Field({ label, value }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm text-gray-200 mt-0.5">{value ?? '—'}</p>
    </div>
  );
}

export default function TrackingAccountDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { success, error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();

  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [showEditModal, setShowEditModal] = useState(false);
  const [showTagModal, setShowTagModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const fetchAccount = useCallback(async () => {
    setLoading(true);
    try {
      const response = await trackingAccountsAPI.get(id);
      setAccount(response.data.data);
    } catch (err) {
      showError(parseApiError(err), 'Failed to load account');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => { fetchAccount(); }, [fetchAccount]);

  const handleEditSubmit = async (payload) => {
    setSubmitting(true);
    try {
      await trackingAccountsAPI.update(id, payload);
      success('Account updated');
      setShowEditModal(false);
      fetchAccount();
    } catch (err) {
      showError(parseApiError(err), 'Failed to save account');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusChange = async (status) => {
    try {
      await trackingAccountsAPI.changeStatus(id, { status });
      success(`Status changed to ${status}`);
      fetchAccount();
    } catch (err) {
      showError(parseApiError(err), 'Failed to change status');
    }
  };

  const handleDelete = async () => {
    try {
      await trackingAccountsAPI.remove(id);
      success('Account deleted');
      navigate('/tracking/accounts');
    } catch (err) {
      showError(parseApiError(err), 'Failed to delete account');
    }
  };

  const handleRestore = async () => {
    try {
      await trackingAccountsAPI.restore(id);
      success('Account restored');
      fetchAccount();
    } catch (err) {
      showError(parseApiError(err), 'Failed to restore account');
    }
  };

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>;
  }
  if (!account) {
    return <p className="text-center text-gray-400 py-20">Account not found.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/tracking/accounts')} className="rounded-lg p-2 text-gray-400 hover:bg-white/5 hover:text-white">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-white">{account.displayName || account.username || account.internalCode}</h1>
              <StatusBadge status={account.status} size="sm" />
              {account.isDeleted && <span className="text-xs text-red-400">(soft-deleted)</span>}
            </div>
            <p className="text-sm text-gray-500 font-mono">{account.internalCode}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasPermission('edit') && !account.isDeleted && (
            <select
              value={account.status}
              onChange={(e) => handleStatusChange(e.target.value)}
              className="rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-200"
            >
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          )}
          {hasPermission('edit') && !account.isDeleted && (
            <button onClick={() => setShowEditModal(true)} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5">
              <Pencil className="h-4 w-4" /> Edit
            </button>
          )}
          {hasPermission('delete') && !account.isDeleted && (
            <button onClick={() => setShowDeleteConfirm(true)} className="flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10">
              <Trash2 className="h-4 w-4" /> Delete
            </button>
          )}
          {hasPermission('delete') && account.isDeleted && (
            <button onClick={handleRestore} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 hover:bg-white/5">
              <RotateCcw className="h-4 w-4" /> Restore
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-white/5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === t.key ? 'border-primary-500 text-primary-400' : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-2 rounded-xl border border-white/5 bg-dark-800/50 p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Basic Information</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <Field label="Phone number" value={account.phoneNumber} />
              <Field label="Telegram User ID" value={account.telegramUserId} />
              <Field label="Username" value={account.username ? `@${account.username}` : null} />
              <Field label="Country" value={account.country ? `${account.country}${account.countryCode ? ` (${account.countryCode})` : ''}` : null} />
              <Field label="Premium" value={account.isPremium ? 'Yes' : 'No'} />
              <Field label="Verified" value={account.isVerified ? 'Yes' : 'No'} />
              <Field label="Scam flag" value={account.isScam ? 'Yes' : 'No'} />
              <Field label="Fake flag" value={account.isFake ? 'Yes' : 'No'} />
              <Field label="Last seen" value={account.lastSeenAt ? formatDateTime(account.lastSeenAt) : null} />
            </div>
            {account.bio && (
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Bio</p>
                <p className="text-sm text-gray-300 mt-1 whitespace-pre-wrap">{account.bio}</p>
              </div>
            )}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Tags</p>
                {hasPermission('edit') && (
                  <button onClick={() => setShowTagModal(true)} className="text-xs text-primary-400 hover:text-primary-300">
                    Manage
                  </button>
                )}
              </div>
              {account.tags?.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {account.tags.map((t) => (
                    <span key={t.id} className="rounded-full bg-white/5 border border-white/10 px-2.5 py-0.5 text-xs text-gray-300">{t.name}</span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500">No tags yet.</p>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-white/5 bg-dark-800/50 p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Status &amp; Value</h2>
            <Field label="Status" value={<StatusBadge status={account.status} size="sm" />} />
            {account.reservedUntil && <Field label="Reserved until" value={formatDateTime(account.reservedUntil)} />}
            <Field label="Assigned to" value={account.currentAssignment ? (account.currentAssignment.assigned_to_email || account.currentAssignment.assigned_to_name) : 'Unassigned'} />
            <Field label="Purchase price" value={account.purchasePrice != null ? `$${account.purchasePrice.toFixed(2)}` : null} />
            <Field label="Sale price" value={account.salePrice != null ? `$${account.salePrice.toFixed(2)}` : null} />
            <Field label="Estimated value" value={account.estimatedValue != null ? `$${account.estimatedValue.toFixed(2)}` : null} />
            <Field label="Backup available" value={account.backupAvailable ? 'Yes' : 'No'} />
            <Field label="Added" value={formatDate(account.createdAt)} />
            <Field label="Last updated" value={formatDate(account.updatedAt)} />
            <Field label="Notes" value={`${account.notesCount} note${account.notesCount === 1 ? '' : 's'}`} />
            <Field label="Attachments" value={`${account.attachmentsCount} file${account.attachmentsCount === 1 ? '' : 's'}`} />
          </div>

          {hasTelegramMeta(account.telegramMeta) && (
            <div className="md:col-span-3 rounded-xl border border-white/5 bg-dark-800/50 p-6">
              <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-4">Account Health</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Field label="Telegram role" value={account.telegramMeta.telegramRole} />
                <Field label="Date of birth" value={account.telegramMeta.dateOfBirth ? formatDate(account.telegramMeta.dateOfBirth) : null} />
                <Field label="DOB verified" value={account.telegramMeta.dateOfBirthVerified == null ? null : (account.telegramMeta.dateOfBirthVerified ? 'Yes' : 'No')} />
                <Field label="Premium expires" value={account.telegramMeta.premiumExpiresAt ? formatDateTime(account.telegramMeta.premiumExpiresAt) : null} />
                <Field label="Spamblock status" value={account.telegramMeta.spamblockStatus} />
                <Field label="Spamblock until" value={account.telegramMeta.spamblockUntil ? formatDateTime(account.telegramMeta.spamblockUntil) : null} />
                <Field label="Has profile pic" value={account.telegramMeta.hasProfilePic ? 'Yes' : 'No'} />
                <Field label="Spam reports" value={account.telegramMeta.statsSpamCount} />
                <Field label="Invites sent" value={account.telegramMeta.statsInvitesCount} />
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'session' && <SessionTab accountId={id} onChanged={fetchAccount} />}
      {activeTab === 'sim' && <SimTab accountId={id} />}
      {activeTab === 'security' && <SecurityTab accountId={id} />}
      {activeTab === 'purchase' && <PurchaseTab accountId={id} onChanged={fetchAccount} />}
      {activeTab === 'sales' && <SalesTab accountId={id} onChanged={fetchAccount} />}
      {activeTab === 'assignments' && <AssignmentsTab accountId={id} onChanged={fetchAccount} />}
      {activeTab === 'notes' && <NotesTab accountId={id} />}
      {activeTab === 'attachments' && <AttachmentsTab accountId={id} />}

      <TagManagerModal
        isOpen={showTagModal}
        onClose={() => setShowTagModal(false)}
        accountId={id}
        currentTags={account.tags || []}
        onChanged={fetchAccount}
      />

      <AccountFormModal
        isOpen={showEditModal}
        onClose={() => setShowEditModal(false)}
        onSubmit={handleEditSubmit}
        account={account}
        submitting={submitting}
      />

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Delete account?"
        message={`This soft-deletes ${account.internalCode}. It can be restored later.`}
        confirmLabel="Delete"
      />
    </div>
  );
}
