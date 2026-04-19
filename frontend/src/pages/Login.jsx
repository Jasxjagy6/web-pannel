import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/common/Toast';
import { parseApiError } from '../utils/formatters';
import { Mail, Lock, Loader2, Eye, EyeOff, Bot } from 'lucide-react';

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const { error: showError, success: showSuccess } = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [apiError, setApiError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validateForm()) return;

    setLoading(true);
    setApiError('');

    try {
      await login(email, password);
      showSuccess('Logged in successfully!', 'Welcome');
      navigate('/dashboard', { replace: true });
    } catch (err) {
      const message = parseApiError(err);
      setApiError(message);
      showError(message, 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const validateForm = () => {
    setApiError('');

    if (!email.trim()) {
      setApiError('Email is required.');
      return false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setApiError('Please enter a valid email address.');
      return false;
    }
    if (!password) {
      setApiError('Password is required.');
      return false;
    }
    return true;
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-dark-950 px-4 py-12">
      {/* Animated gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-dark-950 via-dark-900 to-primary-900" />
      <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-primary-600/20 blur-3xl" />
      <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-blue-500/10 blur-3xl" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-96 w-96 rounded-full bg-primary-500/5 blur-3xl" />

      {/* Card */}
      <div className="relative w-full max-w-md animate-fade-in">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-500 to-blue-600 shadow-lg shadow-primary-500/25">
            <Bot className="h-7 w-7 text-white" />
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-white">
            Telegram Panel
          </h1>
          <p className="mt-1 text-sm text-dark-400">
            Admin Login
          </p>
        </div>

        {/* Auth Card */}
        <div className="rounded-2xl border border-dark-700/50 bg-dark-800/80 p-6 shadow-2xl shadow-black/20 backdrop-blur-xl sm:p-8">
          {/* Title */}
          <div className="mb-6 flex items-center justify-center gap-2">
            <Lock className="h-5 w-5 text-primary-400" />
            <h2 className="text-lg font-semibold text-white">Admin Access</h2>
          </div>

          {/* API Error Message */}
          {apiError && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-error-500/30 bg-error-500/10 p-3 text-sm text-error-400">
              <span className="flex-1">{apiError}</span>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email */}
            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-sm font-medium text-dark-300"
              >
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
                  placeholder="admin@example.com"
                  autoComplete="email"
                  className="w-full rounded-xl border border-dark-700 bg-dark-900/60 py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-dark-600 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                  required
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-sm font-medium text-dark-300"
              >
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
                  placeholder="Enter admin password"
                  autoComplete="current-password"
                  className="w-full rounded-xl border border-dark-700 bg-dark-900/60 py-2.5 pl-10 pr-10 text-sm text-white placeholder:text-dark-600 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-dark-500 hover:text-dark-300"
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary-600 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-600/25 transition-all duration-200 hover:from-primary-500 hover:to-blue-500 hover:shadow-primary-500/30 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:ring-offset-2 focus:ring-offset-dark-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Signing in...</span>
                </>
              ) : (
                <>
                  <Lock className="h-4 w-4" />
                  <span>Sign in</span>
                </>
              )}
            </button>
          </form>
        </div>

        {/* Bottom link */}
        <p className="mt-6 text-center text-xs text-dark-600">
          Single admin mode. Credentials are stored in the server .env file.
        </p>
      </div>
    </div>
  );
}
