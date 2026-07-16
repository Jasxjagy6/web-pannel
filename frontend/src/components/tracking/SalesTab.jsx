import { useState, useEffect, useCallback } from 'react';
import { Plus, ShieldAlert } from 'lucide-react';
import { trackingAccountsAPI } from '@/api';
import { useToast } from '../common/Toast';
import { parseApiError, formatDate } from '@/utils/formatters';
import { Modal } from '../common/Modal';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

const inputClass = 'w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500';
const labelClass = 'block text-xs font-medium text-gray-400 mb-1';

const PAYMENT_METHODS = ['crypto', 'bank_transfer', 'paypal', 'cash', 'other'];
const PAYMENT_STATUSES = ['pending', 'paid', 'partial', 'refunded', 'disputed'];

const EMPTY_FORM = {
  buyerName: '', buyerTelegramUsername: '', buyerTelegramId: '', buyerContact: '',
  saleDate: new Date().toISOString().slice(0, 10), salePrice: '', paymentMethod: 'crypto',
  paymentStatus: 'pending', invoiceNumber: '', notes: '',
};

const statusColor = {
  pending: 'text-amber-400', paid: 'text-green-400', partial: 'text-blue-400',
  refunded: 'text-gray-400', disputed: 'text-red-400',
};

export default function SalesTab({ accountId, onChanged }) {
  const { success, error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();
  const canView = hasPermission('sales');
  const canEdit = hasPermission('edit') && hasPermission('sales');

  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const fetchSales = useCallback(async () => {
    setLoading(true);
    try {
      const response = await trackingAccountsAPI.getSales(accountId);
      setSales(response.data.data || []);
    } catch (err) {
      showError(parseApiError(err), 'Failed to load sales');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => { if (canView) fetchSales(); else setLoading(false); }, [fetchSales, canView]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await trackingAccountsAPI.addSale(accountId, {
        ...form,
        buyerTelegramId: form.buyerTelegramId ? Number(form.buyerTelegramId) : null,
        salePrice: Number(form.salePrice),
      });
      success('Sale recorded — account marked as sold');
      setShowModal(false);
      setForm(EMPTY_FORM);
      fetchSales();
      onChanged?.();
    } catch (err) {
      showError(parseApiError(err), 'Failed to record sale');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusChange = async (sale, paymentStatus) => {
    try {
      await trackingAccountsAPI.updateSale(accountId, sale.id, { paymentStatus });
      success('Payment status updated');
      fetchSales();
    } catch (err) {
      showError(parseApiError(err), 'Failed to update payment status');
    }
  };

  if (!canView) {
    return (
      <div className="flex flex-col items-center py-16 text-center text-gray-500">
        <ShieldAlert className="h-8 w-8 mb-3" />
        <p className="text-sm">You don't have permission to view sales details.</p>
      </div>
    );
  }
  if (loading) return <p className="text-sm text-gray-400 py-6">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {canEdit && (
          <button onClick={() => setShowModal(true)} className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700">
            <Plus className="h-4 w-4" /> Record Sale
          </button>
        )}
      </div>

      {sales.length === 0 ? (
        <div className="rounded-xl border border-white/5 bg-dark-800/50 p-10 text-center text-sm text-gray-500">
          No sales recorded yet.
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-dark-800/50 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                {['Date', 'Buyer', 'Price', 'Method', 'Status', 'Invoice'].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {sales.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-2.5 text-sm text-gray-300">{formatDate(s.saleDate)}</td>
                  <td className="px-4 py-2.5 text-sm text-gray-100">
                    {s.buyerName || '—'}
                    {s.buyerTelegramUsername && <div className="text-xs text-blue-400">@{s.buyerTelegramUsername}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-gray-100">${Number(s.salePrice).toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-sm text-gray-400 capitalize">{s.paymentMethod?.replace('_', ' ')}</td>
                  <td className="px-4 py-2.5 text-sm">
                    {canEdit ? (
                      <select
                        value={s.paymentStatus}
                        onChange={(e) => handleStatusChange(s, e.target.value)}
                        className={`bg-transparent border-none text-xs focus:outline-none focus:ring-0 cursor-pointer ${statusColor[s.paymentStatus] || 'text-gray-400'}`}
                      >
                        {PAYMENT_STATUSES.map((st) => <option key={st} value={st} className="bg-dark-800 text-gray-200">{st}</option>)}
                      </select>
                    ) : (
                      <span className={statusColor[s.paymentStatus] || 'text-gray-400'}>{s.paymentStatus}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-gray-400 font-mono">{s.invoiceNumber || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title="Record Sale"
        size="lg"
        footer={
          <div className="flex justify-end gap-3">
            <button onClick={() => setShowModal(false)} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:bg-white/5">Cancel</button>
            <button onClick={handleSubmit} disabled={submitting} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">
              {submitting ? 'Saving…' : 'Record Sale'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Buyer name</label>
            <input className={inputClass} value={form.buyerName} onChange={(e) => setForm((f) => ({ ...f, buyerName: e.target.value }))} />
          </div>
          <div>
            <label className={labelClass}>Buyer Telegram username</label>
            <input className={inputClass} value={form.buyerTelegramUsername} onChange={(e) => setForm((f) => ({ ...f, buyerTelegramUsername: e.target.value }))} />
          </div>
          <div>
            <label className={labelClass}>Buyer Telegram ID</label>
            <input className={inputClass} value={form.buyerTelegramId} onChange={(e) => setForm((f) => ({ ...f, buyerTelegramId: e.target.value }))} />
          </div>
          <div>
            <label className={labelClass}>Buyer contact</label>
            <input className={inputClass} value={form.buyerContact} onChange={(e) => setForm((f) => ({ ...f, buyerContact: e.target.value }))} />
          </div>
          <div>
            <label className={labelClass}>Sale date</label>
            <input type="date" className={inputClass} value={form.saleDate} onChange={(e) => setForm((f) => ({ ...f, saleDate: e.target.value }))} />
          </div>
          <div>
            <label className={labelClass}>Sale price *</label>
            <input type="number" step="0.01" required className={inputClass} value={form.salePrice} onChange={(e) => setForm((f) => ({ ...f, salePrice: e.target.value }))} />
          </div>
          <div>
            <label className={labelClass}>Payment method</label>
            <select className={inputClass} value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))}>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass}>Payment status</label>
            <select className={inputClass} value={form.paymentStatus} onChange={(e) => setForm((f) => ({ ...f, paymentStatus: e.target.value }))}>
              {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass}>Invoice number</label>
            <input className={inputClass} value={form.invoiceNumber} onChange={(e) => setForm((f) => ({ ...f, invoiceNumber: e.target.value }))} />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass}>Notes</label>
            <textarea className={inputClass} rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </div>
        </form>
      </Modal>
    </div>
  );
}
