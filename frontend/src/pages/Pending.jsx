import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Bot, Clock, ShieldAlert, LogOut, RefreshCw } from 'lucide-react';

export default function Pending() {
  const { user, logout, refreshProfile, isAdmin, isApproved, status } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    // If state is updated (e.g. admin approved while page was open),
    // bounce them through.
    if (isAdmin) navigate('/admin', { replace: true });
    else if (isApproved && status === 'approved') navigate('/dashboard', { replace: true });
  }, [isAdmin, isApproved, status, navigate]);

  const onRefresh = async () => {
    try {
      const u = await refreshProfile();
      if (u?.role === 'admin') navigate('/admin', { replace: true });
      else if (u?.status === 'approved' && u?.isApproved) navigate('/dashboard', { replace: true });
    } catch { /* ignore */ }
  };

  const banned = status === 'banned';

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-dark-950 px-4 py-8 sm:py-12">
      <div className="absolute inset-0 bg-gradient-to-br from-dark-950 via-dark-900 to-primary-900" />
      <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-primary-600/20 blur-3xl" />

      <div className="relative w-full max-w-lg animate-fade-in">
        <div className="mb-6 flex flex-col items-center sm:mb-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-500 to-blue-600 shadow-lg shadow-primary-500/25 sm:h-14 sm:w-14">
            <Bot className="h-6 w-6 text-white sm:h-7 sm:w-7" />
          </div>
          <h1 className="mt-4 text-xl font-bold tracking-tight text-white sm:text-2xl">
            Telegram Panel
          </h1>
        </div>

        <div className="rounded-2xl border border-dark-700/50 bg-dark-800/80 p-6 shadow-2xl shadow-black/20 backdrop-blur-xl sm:p-8">
          <div className="mb-4 flex items-center justify-center gap-2">
            {banned ? (
              <ShieldAlert className="h-5 w-5 text-error-400" />
            ) : (
              <Clock className="h-5 w-5 text-amber-400" />
            )}
            <h2 className="text-lg font-semibold text-white">
              {banned ? 'Account banned' : 'Awaiting approval'}
            </h2>
          </div>

          <p className="text-center text-sm text-dark-300">
            {banned
              ? 'Your account has been suspended by an administrator. Please contact support if you believe this is a mistake.'
              : 'Your account has been created and is waiting for an admin to grant access. You will be able to use all features once approved.'}
          </p>

          {!banned && (
            <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
              Tip: keep this page open. Click "Check status" once the admin approves you and you'll be redirected automatically.
            </p>
          )}

          <div className="mt-6 grid gap-3 text-xs text-dark-300 sm:grid-cols-2">
            <div className="rounded-lg border border-dark-700/60 bg-dark-900/40 p-3">
              <p className="text-[11px] uppercase tracking-wide text-dark-500">Email</p>
              <p className="mt-1 font-medium text-white break-all">{user?.email}</p>
            </div>
            <div className="rounded-lg border border-dark-700/60 bg-dark-900/40 p-3">
              <p className="text-[11px] uppercase tracking-wide text-dark-500">Status</p>
              <p className="mt-1 font-medium text-white capitalize">{status || '—'}</p>
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            {!banned && (
              <button
                onClick={onRefresh}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary-600 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-600/25 transition-all duration-200 hover:from-primary-500 hover:to-blue-500"
              >
                <RefreshCw className="h-4 w-4" />
                Check status
              </button>
            )}
            <button
              onClick={() => { logout(); navigate('/login', { replace: true }); }}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-dark-700 bg-dark-900/60 px-4 py-2.5 text-sm font-medium text-dark-200 hover:border-dark-600 hover:bg-dark-900"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
