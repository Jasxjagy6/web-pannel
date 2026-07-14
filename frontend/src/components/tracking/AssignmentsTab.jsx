import { useState, useEffect, useCallback } from 'react';
import { UserPlus, UserMinus } from 'lucide-react';
import { trackingAccountsAPI } from '@/api';
import { useToast } from '../common/Toast';
import { parseApiError, formatDateTime } from '@/utils/formatters';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

const inputClass = 'w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500';
const labelClass = 'block text-xs font-medium text-gray-400 mb-1';

export default function AssignmentsTab({ accountId, onChanged }) {
  const { success, error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();
  const canEdit = hasPermission('edit');

  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ assignedToName: '', reason: '' });
  const [submitting, setSubmitting] = useState(false);

  const fetchAssignments = useCallback(async () => {
    setLoading(true);
    try {
      const response = await trackingAccountsAPI.getAssignments(accountId);
      setAssignments(response.data.data || []);
    } catch (err) {
      showError(parseApiError(err), 'Failed to load assignment history');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => { fetchAssignments(); }, [fetchAssignments]);

  const current = assignments.find((a) => !a.returnedDate);

  const handleAssign = async (e) => {
    e.preventDefault();
    if (!form.assignedToName.trim()) return;
    setSubmitting(true);
    try {
      await trackingAccountsAPI.assign(accountId, { assignedToName: form.assignedToName.trim(), reason: form.reason });
      success('Account assigned');
      setForm({ assignedToName: '', reason: '' });
      fetchAssignments();
      onChanged?.();
    } catch (err) {
      showError(parseApiError(err), 'Failed to assign account');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReturn = async () => {
    if (!current) return;
    try {
      await trackingAccountsAPI.returnAssignment(accountId, current.id);
      success('Assignment returned');
      fetchAssignments();
      onChanged?.();
    } catch (err) {
      showError(parseApiError(err), 'Failed to return assignment');
    }
  };

  if (loading) return <p className="text-sm text-gray-400 py-6">Loading…</p>;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-white/5 bg-dark-800/50 p-6">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-3">Current Holder</h3>
        {current ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-100">{current.assignedToEmail || current.assignedToName}</p>
              <p className="text-xs text-gray-500">Since {formatDateTime(current.assignedDate)}{current.reason ? ` — ${current.reason}` : ''}</p>
            </div>
            {canEdit && (
              <button onClick={handleReturn} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5">
                <UserMinus className="h-4 w-4" /> Return
              </button>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500">Unassigned</p>
        )}
      </div>

      {canEdit && (
        <form onSubmit={handleAssign} className="rounded-xl border border-white/5 bg-dark-800/50 p-6 space-y-3 max-w-lg">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Assign To</h3>
          <div>
            <label className={labelClass}>Assignee name / identifier</label>
            <input className={inputClass} value={form.assignedToName} onChange={(e) => setForm((f) => ({ ...f, assignedToName: e.target.value }))} placeholder="Staff name, buyer handle, etc." />
          </div>
          <div>
            <label className={labelClass}>Reason</label>
            <input className={inputClass} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
          </div>
          <button type="submit" disabled={submitting} className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">
            <UserPlus className="h-4 w-4" /> {submitting ? 'Assigning…' : 'Assign'}
          </button>
        </form>
      )}

      <div>
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-3">History</h3>
        {assignments.length === 0 ? (
          <p className="text-sm text-gray-500">No assignment history yet.</p>
        ) : (
          <div className="space-y-2">
            {assignments.map((a) => (
              <div key={a.id} className="rounded-lg border border-white/5 bg-dark-800/30 px-4 py-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-200">{a.assignedToEmail || a.assignedToName || 'Unknown'}</span>
                  <span className={a.returnedDate ? 'text-gray-500' : 'text-green-400'}>{a.returnedDate ? 'Returned' : 'Active'}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {formatDateTime(a.assignedDate)} {a.returnedDate ? `→ ${formatDateTime(a.returnedDate)}` : ''}
                  {a.reason ? ` — ${a.reason}` : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
