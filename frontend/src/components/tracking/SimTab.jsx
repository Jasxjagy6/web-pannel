import { useState, useEffect, useCallback } from 'react';
import { trackingAccountsAPI } from '@/api';
import { useToast } from '../common/Toast';
import { parseApiError } from '@/utils/formatters';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

const inputClass = 'w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-60';
const labelClass = 'block text-xs font-medium text-gray-400 mb-1';

const EMPTY = {
  phoneNumber: '', simProvider: '', simCountry: '', simType: 'physical',
  twoFaEnabled: false, recoveryStatus: 'unknown', simStatus: 'active', notes: '',
};

export default function SimTab({ accountId }) {
  const { success, error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();
  const canEdit = hasPermission('edit');
  const [form, setForm] = useState(EMPTY);
  const [recoveryEmailConfigured, setRecoveryEmailConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchSim = useCallback(async () => {
    setLoading(true);
    try {
      const response = await trackingAccountsAPI.getSim(accountId);
      const data = response.data.data;
      setForm({
        phoneNumber: data.phoneNumber || '', simProvider: data.simProvider || '', simCountry: data.simCountry || '',
        simType: data.simType || 'physical', twoFaEnabled: !!data.twoFaEnabled, recoveryStatus: data.recoveryStatus || 'unknown',
        simStatus: data.simStatus || 'active', notes: data.notes || '',
      });
      setRecoveryEmailConfigured(!!data.recoveryEmailConfigured);
    } catch (err) {
      showError(parseApiError(err), 'Failed to load SIM info');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => { fetchSim(); }, [fetchSim]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await trackingAccountsAPI.updateSim(accountId, form);
      success('SIM info saved');
      fetchSim();
    } catch (err) {
      showError(parseApiError(err), 'Failed to save SIM info');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-sm text-gray-400 py-6">Loading…</p>;

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800/50 p-6 space-y-4 max-w-2xl">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Phone number</label>
          <input className={inputClass} disabled={!canEdit} value={form.phoneNumber} onChange={(e) => setForm((f) => ({ ...f, phoneNumber: e.target.value }))} />
        </div>
        <div>
          <label className={labelClass}>SIM provider</label>
          <input className={inputClass} disabled={!canEdit} value={form.simProvider} onChange={(e) => setForm((f) => ({ ...f, simProvider: e.target.value }))} />
        </div>
        <div>
          <label className={labelClass}>Country</label>
          <input className={inputClass} disabled={!canEdit} value={form.simCountry} onChange={(e) => setForm((f) => ({ ...f, simCountry: e.target.value }))} />
        </div>
        <div>
          <label className={labelClass}>Physical / eSIM</label>
          <select className={inputClass} disabled={!canEdit} value={form.simType} onChange={(e) => setForm((f) => ({ ...f, simType: e.target.value }))}>
            <option value="physical">Physical</option>
            <option value="esim">eSIM</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Recovery status</label>
          <select className={inputClass} disabled={!canEdit} value={form.recoveryStatus} onChange={(e) => setForm((f) => ({ ...f, recoveryStatus: e.target.value }))}>
            <option value="unknown">Unknown</option>
            <option value="verified">Verified</option>
            <option value="unverified">Unverified</option>
            <option value="locked">Locked</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>SIM status</label>
          <select className={inputClass} disabled={!canEdit} value={form.simStatus} onChange={(e) => setForm((f) => ({ ...f, simStatus: e.target.value }))}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="lost">Lost</option>
            <option value="blocked">Blocked</option>
          </select>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-300">
        <input type="checkbox" disabled={!canEdit} checked={form.twoFaEnabled} onChange={(e) => setForm((f) => ({ ...f, twoFaEnabled: e.target.checked }))} className="h-4 w-4 rounded border-white/20 bg-dark-900 text-primary-600" />
        2FA enabled
      </label>
      <p className="text-xs text-gray-500">
        Recovery email: {recoveryEmailConfigured ? <span className="text-green-400">configured (see Security tab)</span> : <span className="text-gray-500">not set</span>}
      </p>
      <div>
        <label className={labelClass}>Notes</label>
        <textarea className={inputClass} rows={2} disabled={!canEdit} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
      </div>
      {canEdit && (
        <button onClick={handleSave} disabled={saving} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
    </div>
  );
}
