import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ShieldAlert, ExternalLink } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { Modal } from './Modal';

/**
 * MissingApiCredsModal — global popup that fires the moment the panel
 * decides the user has no Telegram API ID/Hash configured. It is
 * mounted once at the App root and reacts to two signals:
 *
 *   1. The user object has `apiCredentialsCount === 0` right after
 *      login / profile refresh. We pop it once per session.
 *   2. Any API call returns a 412 `API_CREDENTIALS_REQUIRED`. The
 *      axios interceptor dispatches a `missing-api-creds` window
 *      event, which we listen for here. This catches the case where
 *      the user dismissed the popup once but later tried a feature.
 *
 * The CTA always lands on /settings#api-credentials so the Settings
 * page can scroll the right card into view.
 */
export default function MissingApiCredsModal() {
  const { user, isAuthenticated, isAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [auditMessage, setAuditMessage] = useState(null);

  // Login-time trigger: user logs in / refreshes profile and has 0
  // credentials. Show once per session — we reset the flag whenever
  // the user logs back in (different `user.id`).
  useEffect(() => {
    if (!isAuthenticated || isAdmin) return;
    if (!user) return;
    if (user.apiCredentialsCount == null) return;
    if (user.apiCredentialsCount > 0) return;
    // Skip when already on Settings; popup would be redundant.
    if (location.pathname.startsWith('/settings')) return;
    const sessionFlag = `apiCredsPopupSeen:${user.id}`;
    if (sessionStorage.getItem(sessionFlag)) return;
    sessionStorage.setItem(sessionFlag, '1');
    setAuditMessage(null);
    setOpen(true);
  }, [user, isAuthenticated, isAdmin, location.pathname]);

  // 412 trigger: dispatched by the axios interceptor whenever a
  // feature API returns API_CREDENTIALS_REQUIRED. We always show the
  // popup here, regardless of the per-session flag — by definition
  // the user just got blocked.
  useEffect(() => {
    function onMissingCreds(ev) {
      if (location.pathname.startsWith('/settings')) return;
      setAuditMessage(ev?.detail?.message || null);
      setOpen(true);
    }
    window.addEventListener('missing-api-creds', onMissingCreds);
    return () => window.removeEventListener('missing-api-creds', onMissingCreds);
  }, [location.pathname]);

  if (!isAuthenticated || isAdmin) return null;

  function goToSettings() {
    setOpen(false);
    navigate('/settings#api-credentials');
  }

  return (
    <Modal
      isOpen={open}
      onClose={() => setOpen(false)}
      title="Set up your Telegram API ID and Hash"
      size="md"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg border border-dark-700 bg-dark-800 px-4 py-2 text-sm text-dark-200 hover:bg-dark-700"
          >
            Later
          </button>
          <button
            type="button"
            onClick={goToSettings}
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-primary-500"
          >
            Open Settings
          </button>
        </div>
      }
    >
      <div className="flex gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-warning-500/20 text-warning-400">
          <ShieldAlert className="h-5 w-5" />
        </div>
        <div className="space-y-3 text-sm text-dark-200">
          <p>
            Please set up your <strong>Telegram API ID and Hash</strong> in
            Settings to use all features. Until you do, every panel feature
            (sessions, scrape, messaging, groups, …) is locked — even with
            an active subscription.
          </p>
          <p>
            Your credentials are tied to <em>your</em> account, encrypted
            at rest, and used for every Telegram operation we run on your
            behalf. You can register multiple credentials and configure
            <em> max sessions per credential</em> so we transparently
            rotate your sessions across them and avoid Telegram's
            suspicious-activity heuristics.
          </p>
          <p>
            Don't have an API ID and Hash yet? Create one at{' '}
            <a
              href="https://my.telegram.org/apps"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary-400 underline hover:text-primary-300"
            >
              my.telegram.org/apps
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            . It takes about a minute.
          </p>
          {auditMessage && (
            <p className="rounded-lg border border-warning-500/30 bg-warning-500/10 p-2 text-xs text-warning-300">
              {auditMessage}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
