import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/common/Toast';
import { parseApiError } from '../utils/formatters';
import { Mail, Lock, Loader2, Eye, EyeOff, Bot, UserPlus } from 'lucide-react';

export default function Register() {
  const navigate = useNavigate();
  const { register } = useAuth();
  const { error: showError, success: showSuccess } = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [apiError, setApiError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setApiError('');

    if (!email.trim()) return setApiError('Email is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setApiError('Enter a valid email.');
    if (password.length < 8) return setApiError('Password must be at least 8 characters.');
    if (password !== confirm) return setApiError('Passwords do not match.');

    setLoading(true);
    try {
      await register(email.trim(), password);
      // v8: admin approval has been removed. New users land on the
      // billing page so they can either start the free trial or pay.
      // The panel itself stays gated behind "set up your Telegram API
      // ID/Hash in Settings" which is enforced on the next request.
      showSuccess('Account created. Choose a plan or start your trial.', 'Welcome');
      navigate('/billing', { replace: true });
    } catch (err) {
      const message = parseApiError(err);
      setApiError(message);
      showError(message, 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-dark-950 px-4 py-8 sm:py-12">
      <div className="absolute inset-0 bg-gradient-to-br from-dark-950 via-dark-900 to-primary-900" />
      <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-primary-600/20 blur-3xl" />
      <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-blue-500/10 blur-3xl" />

      <div className="relative w-full max-w-md animate-fade-in">
        <div className="mb-6 flex flex-col items-center sm:mb-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-500 to-blue-600 shadow-lg shadow-primary-500/25 sm:h-14 sm:w-14">
            <Bot className="h-6 w-6 text-white sm:h-7 sm:w-7" />
          </div>
          <h1 className="mt-4 text-xl font-bold tracking-tight text-white sm:text-2xl">
            Create your account
          </h1>
          <p className="mt-1 text-sm text-dark-400">
            Sign up for the Telegram Panel
          </p>
        </div>

        <div className="rounded-2xl border border-dark-700/50 bg-dark-800/80 p-5 shadow-2xl shadow-black/20 backdrop-blur-xl sm:p-8">
          <div className="mb-6 flex items-center justify-center gap-2">
            <UserPlus className="h-5 w-5 text-primary-400" />
            <h2 className="text-lg font-semibold text-white">Sign up</h2>
          </div>

          {apiError && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-error-500/30 bg-error-500/10 p-3 text-sm text-error-400">
              <span className="flex-1">{apiError}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-dark-300">
                Email address
              </label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <Mail className="h-4 w-4 text-dark-500" />
                </div>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className="w-full rounded-xl border border-dark-700 bg-dark-900/60 py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-dark-600 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-dark-300">
                Password
              </label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <Lock className="h-4 w-4 text-dark-500" />
                </div>
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  className="w-full rounded-xl border border-dark-700 bg-dark-900/60 py-2.5 pl-10 pr-10 text-sm text-white placeholder:text-dark-600 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-dark-500 hover:text-dark-300"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="confirm" className="mb-1.5 block text-sm font-medium text-dark-300">
                Confirm password
              </label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <Lock className="h-4 w-4 text-dark-500" />
                </div>
                <input
                  id="confirm"
                  type={showPassword ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Re-enter password"
                  autoComplete="new-password"
                  className="w-full rounded-xl border border-dark-700 bg-dark-900/60 py-2.5 pl-10 pr-10 text-sm text-white placeholder:text-dark-600 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                  required
                />
              </div>
            </div>

            <p className="rounded-lg border border-primary-500/30 bg-primary-500/10 p-3 text-xs text-primary-200">
              You'll go straight to the billing page after sign-up — start the
              free trial or pick a plan. The panel itself unlocks once you set
              up your Telegram API ID and Hash in Settings.
            </p>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary-600 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-600/25 transition-all duration-200 hover:from-primary-500 hover:to-blue-500 hover:shadow-primary-500/30 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:ring-offset-2 focus:ring-offset-dark-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Creating account…</span>
                </>
              ) : (
                <>
                  <UserPlus className="h-4 w-4" />
                  <span>Create account</span>
                </>
              )}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-dark-400">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-primary-400 hover:text-primary-300">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
