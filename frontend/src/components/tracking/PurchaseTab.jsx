import { useState, useEffect, useCallback } from 'react';
import { trackingAccountsAPI } from '@/api';
import { useToast } from '../common/Toast';
import { parseApiError } from '@/utils/formatters';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

const inputClass = 'w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-60';
const labelClass = 'block text-xs font-medium text-gray-400 mb-1';

const EMPTY = { source: '', supplierName: '', supplierContact: '', purchasePrice: '', purchaseDate: '', orderId: '', notes: '' };

export default function PurchaseTab({ accountId, onChanged }) {
  const { success, error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();
  const canEdit = hasPermission('edit');
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchPurchase = useCallback(async () => {
    setLoading(true);
    try {
      const response = await trackingAccountsAPI.getPurchase(accountId);
      const data = response.data.data;
      setForm({
        source: data?.source || '', supplierName: data?.supplierName || '', supplierContact: data?.supplierContact || '',
        purchasePrice: data?.purchasePrice ?? '', purchaseDate: data?.purchaseDate ? data.purchaseDate.slice(0, 10) : '',
        orderId: data?.orderId || '', notes: data?.notes || '',
      });
    } catch (err) {
      showError(parseApiError(err), 'Failed to load purchase info');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => { fetchPurchase(); }, [fetchPurchase]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await trackingAccountsAPI.updatePurchase(accountId, {
        ...form,
        purchasePrice: form.purchasePrice === '' ? null : Number(form.purchasePrice),
      });
      success('Purchase info saved');
      fetchPurchase();
      onChanged?.();
    } catch (err) {
      showError(parseApiError(err), 'Failed to save purchase info');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-sm text-gray-400 py-6">Loading…</p>;

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800/50 p-6 space-y-4 max-w-xl">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Source</label>
          <input className={inputClass} disabled={!canEdit} value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} placeholder="Marketplace, direct, etc." />
        </div>
        <div>
          <label className={labelClass}>Order ID</label>
          <input className={inputClass} disabled={!canEdit} value={form.orderId} onChange={(e) => setForm((f) => ({ ...f, orderId: e.target.value }))} />
        </div>
        <div>
          <label className={labelClass}>Supplier name</label>
          <input className={inputClass} disabled={!canEdit} value={form.supplierName} onChange={(e) => setForm((f) => ({ ...f, supplierName: e.target.value }))} />
        </div>
        <div>
          <label className={labelClass}>Supplier contact</label>
          <input className={inputClass} disabled={!canEdit} value={form.supplierContact} onChange={(e) => setForm((f) => ({ ...f, supplierContact: e.target.value }))} />
        </div>
        <div>
          <label className={labelClass}>Purchase price</label>
          <input type="number" step="0.01" className={inputClass} disabled={!canEdit} value={form.purchasePrice} onChange={(e) => setForm((f) => ({ ...f, purchasePrice: e.target.value }))} />
        </div>
        <div>
          <label className={labelClass}>Purchase date</label>
          <input type="date" className={inputClass} disabled={!canEdit} value={form.purchaseDate} onChange={(e) => setForm((f) => ({ ...f, purchaseDate: e.target.value }))} />
        </div>
      </div>
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
