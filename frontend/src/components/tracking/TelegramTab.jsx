import { useState } from 'react';
import { RefreshCw, Monitor, Smartphone, Globe, ShieldCheck, MapPin } from 'lucide-react';
import { trackingAccountsAPI } from '@/api';
import { useToast } from '../common/Toast';
import { parseApiError, formatDateTime } from '@/utils/formatters';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

const PRIVACY_LABELS = {
  statusTimestamp: 'Last Seen & Online',
  phoneNumber: 'Phone Number',
  profilePhoto: 'Profile Photo',
  forwards: 'Forwarded Messages',
  phoneCall: 'Calls',
  phoneP2P: 'Calls — Peer-to-peer',
  chatInvite: 'Group & Channel Invites',
  voiceMessages: 'Voice Messages',
  addedByPhone: 'Who can find me by phone',
  birthday: 'Birthday',
};

const PRIVACY_VALUE_LABELS = {
  everybody: 'Everybody',
  contacts: 'My Contacts',
  close_friends: 'Close Friends',
  premium: 'Premium Users',
  nobody: 'Nobody',
  custom: 'Custom',
  unknown: '—',
};

function Field({ label, value }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm text-gray-200 mt-0.5">{value ?? '—'}</p>
    </div>
  );
}

export default function TelegramTab({ account, onChanged }) {
  const { success, error: showError } = useToast();
  const { hasPermission } = useTrackingAccess();
  const [syncing, setSyncing] = useState(false);

  const meta = account.telegramMeta || {};
  const logins = account.logins || [];
  const privacy = meta.privacySettings || {};
  const canSync = hasPermission('edit') && !!account.sourceSessionId;

  const handleSync = async () => {
    setSyncing(true);
    try {
      await trackingAccountsAPI.sync(account.id);
      success('Synced from live session');
      onChanged?.();
    } catch (err) {
      showError(parseApiError(err), 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const DeviceIcon = (platform) => {
    const p = (platform || '').toLowerCase();
    if (p.includes('android') || p.includes('ios') || p.includes('iphone')) return Smartphone;
    if (p.includes('web')) return Globe;
    return Monitor;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="text-sm text-gray-400">
          {account.isSessionLinked ? (
            <>Linked to a logged-in session · last synced {account.sessionSyncedAt ? formatDateTime(account.sessionSyncedAt) : 'never'}</>
          ) : (
            <>Not linked to a logged-in session. Log this account in on the Telegram panel to auto-sync its live details here.</>
          )}
        </div>
        {canSync && (
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} /> {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>

      {/* Live 2FA state (masked — full values live on the Security tab) */}
      <div className="rounded-xl border border-white/5 bg-dark-800/50 p-6">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-300 uppercase tracking-wide mb-4">
          <ShieldCheck className="h-4 w-4" /> Two-Factor (from live session)
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Field label="2FA enabled" value={meta.twoFaEnabledLive == null ? null : (meta.twoFaEnabledLive ? 'Yes' : 'No')} />
          <Field label="Hint" value={meta.twoFaHint} />
          <Field label="Recovery email set" value={meta.hasRecoveryEmail == null ? null : (meta.hasRecoveryEmail ? 'Yes' : 'No')} />
          <Field label="Recovery (masked)" value={meta.maskedRecoveryEmail} />
        </div>
        <p className="text-xs text-gray-500 mt-3">
          Telegram only exposes a masked recovery pattern and a hint for a logged-in session — the full recovery email and
          plaintext 2FA password live on the <span className="text-gray-400">Security</span> tab (from the uploaded session
          info or manual entry).
        </p>
      </div>

      {/* Privacy settings */}
      <div className="rounded-xl border border-white/5 bg-dark-800/50 p-6">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-4">Privacy Settings</h3>
        {Object.keys(privacy).length === 0 ? (
          <p className="text-sm text-gray-500">No privacy data synced yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2">
            {Object.entries(PRIVACY_LABELS)
              .filter(([key]) => privacy[key])
              .map(([key, label]) => (
                <div key={key} className="flex items-center justify-between border-b border-white/5 py-1.5">
                  <span className="text-sm text-gray-400">{label}</span>
                  <span className="text-sm text-gray-200">{PRIVACY_VALUE_LABELS[privacy[key]] || privacy[key]}</span>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Active logins / devices */}
      <div className="rounded-xl border border-white/5 bg-dark-800/50 p-6">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-4">
          Active Logins {logins.length > 0 && <span className="text-gray-500">({logins.length})</span>}
        </h3>
        {logins.length === 0 ? (
          <p className="text-sm text-gray-500">No login/device data synced yet.</p>
        ) : (
          <div className="space-y-2">
            {logins.map((l) => {
              const Icon = DeviceIcon(l.platform);
              return (
                <div key={l.id} className="flex items-start gap-3 rounded-lg border border-white/5 bg-dark-800/30 px-4 py-3">
                  <Icon className="h-5 w-5 text-gray-400 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-gray-100 font-medium">{l.deviceModel || 'Unknown device'}</span>
                      {l.isCurrent && <span className="rounded-full bg-green-500/15 text-green-400 text-[10px] px-2 py-0.5">Current</span>}
                      {l.officialApp === false && <span className="rounded-full bg-amber-500/15 text-amber-400 text-[10px] px-2 py-0.5">Unofficial app</span>}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {[l.appName, l.appVersion].filter(Boolean).join(' ')} · {[l.platform, l.systemVersion].filter(Boolean).join(' ')}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1 flex-wrap">
                      <MapPin className="h-3 w-3" />
                      {[l.ip, [l.region, l.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                      {l.dateActive && <span> · active {formatDateTime(l.dateActive)}</span>}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
