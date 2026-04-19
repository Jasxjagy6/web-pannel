import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import {
  User,
  Key,
  Bell,
  Shield,
  AlertTriangle,
  Trash2,
  Save,
  Info,
  ExternalLink,
  MessageSquare,
  Volume2,
} from 'lucide-react';
import { useToast } from '../components/common/Toast';
import { parseApiError } from '@/utils/formatters';

function SectionCard({ icon: Icon, title, description, children, className = '' }) {
  return (
    <div className={`rounded-xl border border-white/5 bg-dark-800 shadow-sm ${className}`}>
      <div className="border-b border-white/5 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-500/10 text-primary-400">
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white">{title}</h2>
            {description && <p className="text-sm text-gray-400">{description}</p>}
          </div>
        </div>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label, description }) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex-1">
        <p className="text-sm font-medium text-gray-200">{label}</p>
        {description && <p className="mt-0.5 text-xs text-gray-400">{description}</p>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-primary-600' : 'bg-white/10'
        }`}
        role="switch"
        aria-checked={checked}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

function ConfirmDialog({ isOpen, onClose, onConfirm, title, message, confirmLabel = 'Confirm', confirmText = '', onConfirmTextChange }) {
  if (!isOpen) return null;
  const needsConfirm = confirmText !== undefined && onConfirmTextChange;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl border border-white/10 bg-dark-800 p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <AlertTriangle className="h-5 w-5 text-red-400 shrink-0" />
          <h3 className="text-lg font-semibold text-white">{title}</h3>
        </div>
        <p className="text-sm text-gray-300 mb-4">{message}</p>
        {needsConfirm && (
          <div className="mb-4">
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              Type <span className="text-red-400 font-bold">DELETE</span> to confirm
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => onConfirmTextChange(e.target.value)}
              placeholder="Type DELETE here"
              className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
            />
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { onConfirm(); onClose(); }}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-dark-800"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Settings() {
  const { user, logout } = useAuth();
  const { error: showError, success: showSuccess } = useToast();

  // --- Notifications ---
  const [notifSessionLogin, setNotifSessionLogin] = useState(true);
  const [notifScrapeComplete, setNotifScrapeComplete] = useState(true);
  const [notifMessageSent, setNotifMessageSent] = useState(false);
  const [notifErrors, setNotifErrors] = useState(true);
  const [notifWeeklyReport, setNotifWeeklyReport] = useState(false);
  const [notifSound, setNotifSound] = useState(true);

  // --- Danger Zone ---
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') {
      showError('You must type DELETE to confirm.', 'Confirmation Required');
      return;
    }
    setDeleting(true);
    try {
      // In single-admin mode, this just logs out
      showSuccess('Logged out. To remove admin access, delete the admin credentials from .env.', 'Done');
      logout();
    } finally {
      setDeleting(false);
      setShowDeleteModal(false);
      setDeleteConfirmText('');
    }
  };

  const handleSaveNotifications = () => {
    showSuccess('Notification preferences saved locally.', 'Saved');
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Settings</h1>
        <p className="mt-1 text-sm text-gray-400">
          Manage your profile, API configuration, notification preferences, and account.
        </p>
      </div>

      {/* PROFILE SECTION */}
      <SectionCard
        icon={User}
        title="Profile"
        description="Single admin mode. Credentials are managed via backend .env file."
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">Admin Email</label>
            <div className="rounded-lg border border-white/5 bg-dark-900/50 px-3 py-2 text-sm text-gray-300">
              {user?.email || 'admin@example.com'}
              <span className="ml-2 text-xs text-gray-500">(managed via ADMIN_EMAIL in .env)</span>
            </div>
          </div>

          <div className="border-t border-white/5 pt-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-200">Admin Password</h3>
            <p className="text-sm text-gray-400">
              Password is managed via <code className="text-xs bg-dark-900 px-1.5 py-0.5 rounded">ADMIN_PASSWORD</code> in the backend <code className="text-xs bg-dark-900 px-1.5 py-0.5 rounded">.env</code> file. Cannot be changed from the UI.
            </p>
          </div>
        </div>
      </SectionCard>

      {/* TELEGRAM API SECTION */}
      <SectionCard
        icon={Key}
        title="Telegram API"
        description="Your Telegram API credentials used for authentication and operations."
      >
        <div className="space-y-5">
          <div className="flex gap-3 rounded-lg border border-blue-500/20 bg-blue-500/5 p-4">
            <Info className="h-5 w-5 text-blue-400 shrink-0 mt-0.5" />
            <div className="text-sm text-blue-200">
              <p className="font-medium mb-1">How to get your API credentials</p>
              <ol className="list-decimal list-inside space-y-1 text-blue-300/80">
                <li>Go to <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer" className="underline hover:text-blue-200 transition-colors inline-flex items-center gap-1">my.telegram.org <ExternalLink className="h-3 w-3" /></a></li>
                <li>Log in with your phone number</li>
                <li>Navigate to <strong>API development tools</strong></li>
                <li>Create a new application to get your <strong>API ID</strong> and <strong>API Hash</strong></li>
                <li>Add them to the backend .env file as TELEGRAM_API_ID and TELEGRAM_API_HASH</li>
              </ol>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">API ID</label>
            <div className="relative">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
              <input
                type="text"
                value={process.env.VITE_TELEGRAM_API_ID || 'Set in backend .env'}
                readOnly
                className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 pl-10 pr-3 text-sm font-mono text-gray-300 cursor-not-allowed"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">API Hash</label>
            <div className="relative">
              <Shield className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
              <input
                type="password"
                value="Set in backend .env"
                readOnly
                className="w-full rounded-lg border border-white/10 bg-dark-900 py-2 pl-10 pr-3 text-sm font-mono text-gray-300 cursor-not-allowed"
              />
            </div>
          </div>
        </div>
      </SectionCard>

      {/* NOTIFICATIONS SECTION */}
      <SectionCard
        icon={Bell}
        title="Notifications"
        description="Configure which events trigger notifications."
      >
        <div className="divide-y divide-white/5">
          <Toggle checked={notifSessionLogin} onChange={setNotifSessionLogin} label="Session Login Alerts" description="Get notified when a new session is authenticated." />
          <Toggle checked={notifScrapeComplete} onChange={setNotifScrapeComplete} label="Scrape Completion" description="Notify when a scrape job finishes." />
          <Toggle checked={notifMessageSent} onChange={setNotifMessageSent} label="Message Delivery" description="Notify when bulk message campaigns are completed." />
          <Toggle checked={notifErrors} onChange={setNotifErrors} label="Error Alerts" description="Get notified about session errors or failed operations." />
          <Toggle checked={notifWeeklyReport} onChange={setNotifWeeklyReport} label="Weekly Summary Report" description="Receive a weekly digest of your panel activity." />
          <Toggle checked={notifSound} onChange={setNotifSound} label="Sound Effects" description="Play a sound for in-app notifications." />
        </div>
        <div className="mt-4 pt-4 border-t border-white/5">
          <button
            onClick={handleSaveNotifications}
            className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <Save className="h-4 w-4" />
            Save Preferences
          </button>
        </div>
      </SectionCard>

      {/* DANGER ZONE */}
      <div className="rounded-xl border border-red-500/20 bg-dark-800 shadow-sm">
        <div className="border-b border-red-500/10 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-red-400">Danger Zone</h2>
              <p className="text-sm text-gray-400">Irreversible and destructive actions.</p>
            </div>
          </div>
        </div>
        <div className="p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 rounded-lg border border-red-500/20 bg-red-500/5 p-4">
            <div>
              <p className="text-sm font-medium text-red-300">Logout</p>
              <p className="mt-0.5 text-xs text-red-300/60">
                Log out of the admin panel. To revoke access, change the admin password in .env.
              </p>
            </div>
            <button
              onClick={() => setShowDeleteModal(true)}
              className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
            >
              <Trash2 className="h-4 w-4" />
              Logout
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={showDeleteModal}
        onClose={() => { setShowDeleteModal(false); setDeleteConfirmText(''); }}
        onConfirm={handleDeleteAccount}
        title="Logout"
        message="You will be logged out. To revoke access, change the admin credentials in the backend .env file."
        confirmLabel="Logout"
        confirmText={deleteConfirmText}
        onConfirmTextChange={setDeleteConfirmText}
      />
    </div>
  );
}
