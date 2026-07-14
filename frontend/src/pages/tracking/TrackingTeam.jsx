import { useState, useEffect, useCallback } from 'react';
import { UserPlus, Trash2, ShieldAlert } from 'lucide-react';
import { trackingTeamAPI } from '@/api';
import { useToast } from '../../components/common/Toast';
import { parseApiError, formatDate } from '@/utils/formatters';
import { Modal } from '../../components/common/Modal';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

const ROLES = ['owner', 'admin', 'staff', 'viewer'];
const inputClass = 'w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500';

const ROLE_DESCRIPTIONS = {
  owner: 'Full access, including managing the team itself.',
  admin: 'Full access except managing team members.',
  staff: 'Can view and edit accounts; no delete, export, sales, or earnings visibility.',
  viewer: 'Read-only access.',
};

export default function TrackingTeam() {
  const { success, error: showError } = useToast();
  const { hasPermission, role: myRole } = useTrackingAccess();
  const canManage = hasPermission('manageTeam');

  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [form, setForm] = useState({ userId: '', role: 'viewer' });
  const [submitting, setSubmitting] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);

  const fetchMembers = useCallback(async () => {
    setLoading(true);
    try {
      const response = await trackingTeamAPI.list();
      setMembers(response.data.data || []);
    } catch (err) {
      showError(parseApiError(err), 'Failed to load team');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (canManage) fetchMembers(); else setLoading(false); }, [fetchMembers, canManage]);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!form.userId) return;
    setSubmitting(true);
    try {
      await trackingTeamAPI.addMember({ userId: Number(form.userId), role: form.role });
      success('Team member added');
      setShowAddModal(false);
      setForm({ userId: '', role: 'viewer' });
      fetchMembers();
    } catch (err) {
      showError(parseApiError(err), 'Failed to add team member');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRoleChange = async (member, role) => {
    try {
      await trackingTeamAPI.updateMember(member.userId, { role });
      success('Role updated');
      fetchMembers();
    } catch (err) {
      showError(parseApiError(err), 'Failed to update role');
    }
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    try {
      await trackingTeamAPI.removeMember(removeTarget.userId);
      success('Team member removed');
      fetchMembers();
    } catch (err) {
      showError(parseApiError(err), 'Failed to remove team member');
    }
  };

  if (!canManage) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ShieldAlert className="h-10 w-10 text-gray-600 mb-4" />
        <h2 className="text-lg font-semibold text-white">Owner access required</h2>
        <p className="text-sm text-gray-400 mt-1 max-w-sm">Only Owners (or Admins with team access) can manage the Tracking team.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Tracking Team</h1>
          <p className="text-sm text-gray-400 mt-1">Your role: <span className="capitalize text-primary-400">{myRole}</span></p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
        >
          <UserPlus className="h-4 w-4" /> Add Member
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs text-gray-500">
        {ROLES.map((r) => (
          <div key={r} className="rounded-lg border border-white/5 bg-dark-800/30 p-3">
            <p className="font-semibold text-gray-300 capitalize mb-1">{r}</p>
            <p>{ROLE_DESCRIPTIONS[r]}</p>
          </div>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="rounded-xl border border-white/5 bg-dark-800/50 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                {['Email', 'Role', 'Added', ''].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {members.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-2.5 text-sm text-gray-100">{m.email}</td>
                  <td className="px-4 py-2.5 text-sm">
                    <select
                      value={m.role}
                      onChange={(e) => handleRoleChange(m, e.target.value)}
                      className="bg-transparent border border-white/10 rounded-lg px-2 py-1 text-xs text-gray-200"
                    >
                      {ROLES.map((r) => <option key={r} value={r} className="bg-dark-800">{r}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-gray-400">{formatDate(m.createdAt)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => setRemoveTarget(m)} className="rounded-lg p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-400/10" title="Remove">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {members.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-500">No explicit team members — panel admins have implicit Owner access.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add Team Member"
        footer={
          <div className="flex justify-end gap-3">
            <button onClick={() => setShowAddModal(false)} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:bg-white/5">Cancel</button>
            <button onClick={handleAdd} disabled={submitting} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">
              {submitting ? 'Adding…' : 'Add'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleAdd} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Panel user ID</label>
            <input className={inputClass} value={form.userId} onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))} placeholder="e.g. 4" />
            <p className="text-xs text-gray-500 mt-1">Find the user ID on the Admin Panel's user list.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Role</label>
            <select className={inputClass} value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        isOpen={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={handleRemove}
        title="Remove team member?"
        message={`${removeTarget?.email} will lose access to Tracking.`}
        confirmLabel="Remove"
      />
    </div>
  );
}
