import { useState, useEffect, useCallback } from 'react';
import { Eye, EyeOff, ShieldAlert } from 'lucide-react';
import { trackingAccountsAPI } from '@/api';
import { useToast } from '../common/Toast';
import { parseApiError, formatDate } from '@/utils/formatters';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

const inputClass = 'w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-60';
const labelClass = 'block text-xs font-medium text-gray-400 mb-1';

export default function SecurityTab({ accountId }) {
  const { success, error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();
  const canEdit = hasPermission('edit') && hasPermission('security');
  const canView = hasPermission('security');

  const [form, setForm] = useState({ twoFaPassword: '', twoFaHint: '', recoveryEmail: '', securityNotes: '', passwordChangedAt: '' });
  const [reveal, setReveal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchSecurity = useCallback(async () => {
    setLoading(true);
    try {
      const response = await trackingAccountsAPI.getSecurity(accountId);
      const data = response.data.data;
      setForm({
        twoFaPassword: data.twoFaPassword || '', twoFaHint: data.twoFaHint || '',
        recoveryEmail: data.recoveryEmail || '', securityNotes: data.securityNotes || '',
        passwordChangedAt: data.passwordChangedAt ? data.passwordChangedAt.slice(0, 10) : '',
      });
    } catch (err) {
      showError(parseApiError(err), 'Failed to load security info');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => { if (canView) fetchSecurity(); else setLoading(false); }, [fetchSecurity, canView]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await trackingAccountsAPI.updateSecurity(accountId, form);
      success('Security info saved');
      fetchSecurity();
    } catch (err) {
      showError(parseApiError(err), 'Failed to save security info');
    } finally {
      setSaving(false);
    }
  };

  if (!canView) {
    return (
      <div className="flex flex-col items-center py-16 text-center text-gray-500">
        <ShieldAlert className="h-8 w-8 mb-3" />
        <p className="text-sm">You don't have permission to view security details.</p>
      </div>
    );
  }
  if (loading) return <p className="text-sm text-gray-400 py-6">Loading…</p>;

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800/50 p-6 space-y-4 max-w-xl">
      <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
        <ShieldAlert className="h-4 w-4 shrink-0" /> Stored encrypted at rest. Handle with care.
      </div>
      <div>
        <label className={labelClass}>2FA password</label>
        <div className="relative">
          <input
            type={reveal ? 'text' : 'password'}
            className={inputClass}
            disabled={!canEdit}
            value={form.twoFaPassword}
            onChange={(e) => setForm((f) => ({ ...f, twoFaPassword: e.target.value }))}
          />
          <button type="button" onClick={() => setReveal((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
            {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>
      <div>
        <label className={labelClass}>Hint</label>
        <input className={inputClass} disabled={!canEdit} value={form.twoFaHint} onChange={(e) => setForm((f) => ({ ...f, twoFaHint: e.target.value }))} />
      </div>
      <div>
        <label className={labelClass}>Recovery email</label>
        <input type="email" className={inputClass} disabled={!canEdit} value={form.recoveryEmail} onChange={(e) => setForm((f) => ({ ...f, recoveryEmail: e.target.value }))} />
      </div>
      <div>
        <label className={labelClass}>Password changed date</label>
        <input type="date" className={inputClass} disabled={!canEdit} value={form.passwordChangedAt} onChange={(e) => setForm((f) => ({ ...f, passwordChangedAt: e.target.value }))} />
      </div>
      <div>
        <label className={labelClass}>Notes</label>
        <textarea className={inputClass} rows={2} disabled={!canEdit} value={form.securityNotes} onChange={(e) => setForm((f) => ({ ...f, securityNotes: e.target.value }))} />
      </div>
      {canEdit && (
        <button onClick={handleSave} disabled={saving} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
      {form.passwordChangedAt && <p className="text-xs text-gray-500">Last changed {formatDate(form.passwordChangedAt)}</p>}
    </div>
  );
}
