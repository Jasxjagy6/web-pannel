import { useState, useEffect } from 'react';
import { Trash2, UserPlus, Tags, X } from 'lucide-react';
import { trackingBulkAPI, trackingTagsAPI } from '@/api';
import { useToast } from '../common/Toast';
import { parseApiError } from '@/utils/formatters';
import { Modal } from '../common/Modal';
import ConfirmDialog from '../common/ConfirmDialog';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

const STATUS_OPTIONS = ['available', 'reserved', 'sold', 'dead', 'banned', 'deleted', 'lost_access'];
const inputClass = 'w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500';

function reportOutcome(success, showError, label, result) {
  const { succeeded, failed } = result;
  if (failed.length === 0) {
    success(`${label}: ${succeeded.length} account${succeeded.length === 1 ? '' : 's'} updated`);
  } else {
    showError(`${failed.length} failed, ${succeeded.length} succeeded`, label);
  }
}

export default function BulkActionToolbar({ selectedIds, onClearSelection, onCompleted }) {
  const { success, error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();
  const [busy, setBusy] = useState(false);
  const [statusValue, setStatusValue] = useState('available');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignForm, setAssignForm] = useState({ assignedToName: '', reason: '' });
  const [showTagModal, setShowTagModal] = useState(false);
  const [tagCatalog, setTagCatalog] = useState([]);
  const [selectedTagId, setSelectedTagId] = useState('');

  useEffect(() => {
    if (showTagModal) {
      trackingTagsAPI.list().then((r) => setTagCatalog(r.data.data || [])).catch(() => {});
    }
  }, [showTagModal]);

  const finish = () => { setBusy(false); onCompleted?.(); };

  const handleDelete = async () => {
    setBusy(true);
    try {
      const response = await trackingBulkAPI.delete(selectedIds);
      reportOutcome(success, showError, 'Bulk delete', response.data.data);
      onClearSelection();
      finish();
    } catch (err) {
      showError(parseApiError(err), 'Bulk delete failed');
      setBusy(false);
    }
  };

  const handleStatusApply = async () => {
    setBusy(true);
    try {
      const response = await trackingBulkAPI.status(selectedIds, statusValue);
      reportOutcome(success, showError, 'Bulk status change', response.data.data);
      onClearSelection();
      finish();
    } catch (err) {
      showError(parseApiError(err), 'Bulk status change failed');
      setBusy(false);
    }
  };

  const handleAssign = async (e) => {
    e.preventDefault();
    if (!assignForm.assignedToName.trim()) return;
    setBusy(true);
    try {
      const response = await trackingBulkAPI.assign(selectedIds, assignForm);
      reportOutcome(success, showError, 'Bulk assign', response.data.data);
      setShowAssignModal(false);
      setAssignForm({ assignedToName: '', reason: '' });
      onClearSelection();
      finish();
    } catch (err) {
      showError(parseApiError(err), 'Bulk assign failed');
      setBusy(false);
    }
  };

  const handleTag = async () => {
    if (!selectedTagId) return;
    setBusy(true);
    try {
      const response = await trackingBulkAPI.tag(selectedIds, [Number(selectedTagId)]);
      reportOutcome(success, showError, 'Bulk tag', response.data.data);
      setShowTagModal(false);
      setSelectedTagId('');
      onClearSelection();
      finish();
    } catch (err) {
      showError(parseApiError(err), 'Bulk tag failed');
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary-500/30 bg-primary-500/10 px-4 py-2.5">
      <span className="text-sm text-primary-300 font-medium">{selectedIds.length} selected</span>

      {hasPermission('edit') && (
        <div className="flex items-center gap-1.5">
          <select value={statusValue} onChange={(e) => setStatusValue(e.target.value)} className="rounded-lg border border-white/10 bg-dark-900 px-2 py-1.5 text-xs text-gray-200">
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
          <button onClick={handleStatusApply} disabled={busy} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/5 disabled:opacity-50">
            Apply status
          </button>
        </div>
      )}

      {hasPermission('edit') && (
        <button onClick={() => setShowAssignModal(true)} disabled={busy} className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white disabled:opacity-50">
          <UserPlus className="h-3.5 w-3.5" /> Assign
        </button>
      )}

      {hasPermission('edit') && (
        <button onClick={() => setShowTagModal(true)} disabled={busy} className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white disabled:opacity-50">
          <Tags className="h-3.5 w-3.5" /> Tag
        </button>
      )}

      {hasPermission('delete') && (
        <button onClick={() => setShowDeleteConfirm(true)} disabled={busy} className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 disabled:opacity-50">
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
      )}

      <button onClick={onClearSelection} className="ml-auto flex items-center gap-1 text-xs text-gray-400 hover:text-white">
        <X className="h-3.5 w-3.5" /> Clear
      </button>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title={`Delete ${selectedIds.length} accounts?`}
        message="This soft-deletes the selected accounts. They can be restored individually later."
        confirmLabel="Delete"
      />

      <Modal
        isOpen={showAssignModal}
        onClose={() => setShowAssignModal(false)}
        title={`Assign ${selectedIds.length} accounts`}
        footer={
          <div className="flex justify-end gap-3">
            <button onClick={() => setShowAssignModal(false)} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:bg-white/5">Cancel</button>
            <button onClick={handleAssign} disabled={busy} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">
              {busy ? 'Assigning…' : 'Assign'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleAssign} className="space-y-3">
          <input
            className={inputClass}
            placeholder="Assignee name / identifier"
            value={assignForm.assignedToName}
            onChange={(e) => setAssignForm((f) => ({ ...f, assignedToName: e.target.value }))}
          />
          <input
            className={inputClass}
            placeholder="Reason (optional)"
            value={assignForm.reason}
            onChange={(e) => setAssignForm((f) => ({ ...f, reason: e.target.value }))}
          />
        </form>
      </Modal>

      <Modal
        isOpen={showTagModal}
        onClose={() => setShowTagModal(false)}
        title={`Tag ${selectedIds.length} accounts`}
        footer={
          <div className="flex justify-end gap-3">
            <button onClick={() => setShowTagModal(false)} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:bg-white/5">Cancel</button>
            <button onClick={handleTag} disabled={busy || !selectedTagId} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">
              {busy ? 'Applying…' : 'Apply tag'}
            </button>
          </div>
        }
      >
        <div className="flex flex-wrap gap-2">
          {tagCatalog.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedTagId(String(t.id))}
              className={`rounded-full px-3 py-1.5 text-sm font-medium border transition-colors ${
                selectedTagId === String(t.id)
                  ? 'border-primary-500/50 bg-primary-500/15 text-primary-300'
                  : 'border-white/10 text-gray-400 hover:bg-white/5'
              }`}
            >
              {t.name}
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}
