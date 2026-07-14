import { useState, useEffect } from 'react';
import { Modal } from '../common/Modal';

const inputClass = 'w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary-500';
const labelClass = 'block text-xs font-medium text-gray-400 mb-1';

const EMPTY_FORM = {
  phoneNumber: '', country: '', countryCode: '', telegramUserId: '', username: '',
  displayName: '', bio: '', isPremium: false, isVerified: false, isScam: false, isFake: false,
};

export default function AccountFormModal({ isOpen, onClose, onSubmit, account, submitting }) {
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => {
    if (account) {
      setForm({
        phoneNumber: account.phoneNumber || '',
        country: account.country || '',
        countryCode: account.countryCode || '',
        telegramUserId: account.telegramUserId || '',
        username: account.username || '',
        displayName: account.displayName || '',
        bio: account.bio || '',
        isPremium: !!account.isPremium,
        isVerified: !!account.isVerified,
        isScam: !!account.isScam,
        isFake: !!account.isFake,
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [account, isOpen]);

  const update = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const handleSubmit = (e) => {
    e.preventDefault();
    const payload = {
      ...form,
      telegramUserId: form.telegramUserId ? Number(form.telegramUserId) : null,
    };
    onSubmit(payload);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={account ? `Edit ${account.internalCode || 'Account'}` : 'Add Account'}
      size="lg"
      footer={
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : account ? 'Save changes' : 'Create account'}
          </button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Phone number</label>
          <input className={inputClass} value={form.phoneNumber} onChange={(e) => update('phoneNumber', e.target.value)} placeholder="+1 555 000 1111" />
        </div>
        <div>
          <label className={labelClass}>Telegram User ID</label>
          <input className={inputClass} value={form.telegramUserId} onChange={(e) => update('telegramUserId', e.target.value)} placeholder="123456789" />
        </div>
        <div>
          <label className={labelClass}>Username</label>
          <input className={inputClass} value={form.username} onChange={(e) => update('username', e.target.value)} placeholder="username" />
        </div>
        <div>
          <label className={labelClass}>Display name</label>
          <input className={inputClass} value={form.displayName} onChange={(e) => update('displayName', e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Country</label>
          <input className={inputClass} value={form.country} onChange={(e) => update('country', e.target.value)} placeholder="United States" />
        </div>
        <div>
          <label className={labelClass}>Country code</label>
          <input className={inputClass} value={form.countryCode} onChange={(e) => update('countryCode', e.target.value.toUpperCase())} placeholder="US" maxLength={8} />
        </div>
        <div className="md:col-span-2">
          <label className={labelClass}>Bio</label>
          <textarea className={inputClass} rows={2} value={form.bio} onChange={(e) => update('bio', e.target.value)} />
        </div>
        <div className="md:col-span-2 flex flex-wrap gap-4">
          {[
            ['isPremium', 'Premium'],
            ['isVerified', 'Verified'],
            ['isScam', 'Flagged: Scam'],
            ['isFake', 'Flagged: Fake'],
          ].map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={form[key]}
                onChange={(e) => update(key, e.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-dark-900 text-primary-600 focus:ring-primary-500"
              />
              {label}
            </label>
          ))}
        </div>
      </form>
    </Modal>
  );
}
