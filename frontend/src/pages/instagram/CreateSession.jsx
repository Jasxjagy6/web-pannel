import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Instagram,
  ShieldCheck,
  Lock,
  KeyRound,
  ArrowRight,
  CheckCircle2,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import {
  createSessionStart,
  createSessionVerify,
  createSessionPassword,
  createSessionResend,
  createSessionCancel,
} from '@/api/sessions';
import { listMyProxies } from '@/api/userProxies';
import { useToast } from '../../components/common/Toast';
import { apiError } from '../../utils/apiError';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

const STEPS = [
  { id: 'credentials', label: 'Credentials', icon: Lock },
  { id: 'twofa',       label: '2FA',         icon: ShieldCheck },
  { id: 'challenge',   label: 'Challenge',   icon: KeyRound },
  { id: 'done',        label: 'Done',        icon: CheckCircle2 },
];

function StepIndicator({ activeStep, completedSteps }) {
  return (
    <ol className="mb-6 flex items-center justify-between gap-2">
      {STEPS.map((s, idx) => {
        const isActive = s.id === activeStep;
        const isDone = completedSteps.has(s.id);
        return (
          <li key={s.id} className="flex flex-1 items-center gap-3">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ${
                isDone
                  ? 'bg-green-500 text-white'
                  : isActive
                    ? `${IG_GRADIENT} text-white shadow-lg`
                    : 'bg-pink-50 text-pink-500 dark:bg-pink-900/20'
              }`}
            >
              <s.icon className="h-4 w-4" />
            </div>
            <span
              className={`hidden text-sm sm:block ${
                isActive ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-400'
              }`}
            >
              {s.label}
            </span>
            {idx < STEPS.length - 1 && (
              <span className="hidden h-px flex-1 bg-pink-100 dark:bg-pink-900/30 sm:block" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">{label}</div>
      {children}
      {hint && (
        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</div>
      )}
    </label>
  );
}

export default function InstagramCreateSession() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [step, setStep] = useState('credentials');
  const completedSteps = new Set();
  if (step !== 'credentials') completedSteps.add('credentials');
  if (step === 'challenge' || step === 'done') completedSteps.add('twofa');
  if (step === 'done') completedSteps.add('challenge');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [proxyId, setProxyId] = useState('');
  const [proxies, setProxies] = useState([]);
  const [proxyState, setProxyState] = useState('loading');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await listMyProxies();
        if (!active) return;
        const rows = r.data?.data?.proxies || [];
        setProxies(rows);
        const auto = rows.find((p) => p.is_working && p.validated_for_instagram)
          || rows.find((p) => p.is_working)
          || rows[0];
        if (auto) setProxyId(String(auto.id));
        setProxyState('ready');
      } catch (e) {
        if (!active) return;
        const code = e?.response?.data?.error?.code || e?.response?.data?.code;
        setProxyState(code === 'TRIAL_FEATURE_NOT_ALLOWED' ? 'trial_blocked' : 'error');
      }
    })();
    return () => { active = false; };
  }, []);

  const [sessionToken, setSessionToken] = useState(null);
  const [twofaIdentifier, setTwofaIdentifier] = useState(null);
  const [challengeMethod, setChallengeMethod] = useState('sms');
  const [code, setCode] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [createdSession, setCreatedSession] = useState(null);

  function _err(e) {
    return apiError(e);
  }

  async function startLogin(evt) {
    evt?.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Username and password are required');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const r = await createSessionStart({
        username: username.trim(),
        password,
        proxyId: proxyId ? Number(proxyId) : undefined,
      });
      const data = r.data?.data || r.data;
      setSessionToken(data.sessionToken);
      if (data.requires === '2fa' || data.next === '2fa') {
        setTwofaIdentifier(data.twoFactorIdentifier || null);
        setStep('twofa');
      } else if (data.requires === 'challenge' || data.next === 'challenge') {
        setChallengeMethod(data.challengeMethod || 'sms');
        setStep('challenge');
      } else if (data.sessionId) {
        setCreatedSession(data);
        setStep('done');
      } else {
        // Some success shape we didn't enumerate — treat as done
        setStep('done');
      }
    } catch (e) {
      setError(_err(e));
    } finally {
      setLoading(false);
    }
  }

  async function submit2fa(evt) {
    evt?.preventDefault();
    if (!code.trim()) {
      setError('Enter your 2FA code');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const r = await createSessionPassword({ sessionToken, code: code.trim() });
      const data = r.data?.data || r.data;
      setCode('');
      if (data.requires === 'challenge' || data.next === 'challenge') {
        setChallengeMethod(data.challengeMethod || 'sms');
        setStep('challenge');
      } else if (data.sessionId) {
        setCreatedSession(data);
        setStep('done');
      } else {
        setStep('done');
      }
    } catch (e) {
      setError(_err(e));
    } finally {
      setLoading(false);
    }
  }

  async function submitChallenge(evt) {
    evt?.preventDefault();
    if (!code.trim()) {
      setError('Enter the verification code from Instagram');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const r = await createSessionVerify({ sessionToken, code: code.trim() });
      const data = r.data?.data || r.data;
      setCode('');
      if (data.sessionId) {
        setCreatedSession(data);
        setStep('done');
      } else {
        setStep('done');
      }
    } catch (e) {
      setError(_err(e));
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    setError('');
    setLoading(true);
    try {
      await createSessionResend({ sessionToken, method: challengeMethod });
      showToast('Verification code requested again', 'success');
    } catch (e) {
      setError(_err(e));
    } finally {
      setLoading(false);
    }
  }

  async function cancel() {
    if (sessionToken) {
      try { await createSessionCancel({ sessionToken }); } catch (_) { /* ignore */ }
    }
    navigate('/instagram/sessions');
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className={`rounded-xl ${IG_GRADIENT} px-6 py-5 text-white shadow-lg`}>
        <div className="flex items-center gap-3">
          <Instagram className="h-7 w-7" />
          <div>
            <div className="text-lg font-semibold">Create Instagram session</div>
            <div className="text-sm text-white/85">
              Log in an Instagram account. We handle TOTP / SMS 2FA and the IG checkpoint flow automatically.
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-pink-100 bg-white p-6 shadow-sm dark:border-pink-900/30 dark:bg-dark-800">
        <StepIndicator activeStep={step} completedSteps={completedSteps} />

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/30 dark:bg-red-900/10 dark:text-red-300">
            <XCircle className="mt-0.5 h-4 w-4 flex-none" />
            <div>{error}</div>
          </div>
        )}

        {step === 'credentials' && (
          <form onSubmit={startLogin} className="space-y-4">
            <Field label="Instagram username">
              <input
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                className="block w-full rounded-lg border border-gray-200 bg-white p-2.5 text-sm focus:border-pink-500 focus:outline-none focus:ring-2 focus:ring-pink-200 dark:border-dark-600 dark:bg-dark-700 dark:text-white"
                placeholder="your.username"
              />
            </Field>

            <Field label="Password">
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                className="block w-full rounded-lg border border-gray-200 bg-white p-2.5 text-sm focus:border-pink-500 focus:outline-none focus:ring-2 focus:ring-pink-200 dark:border-dark-600 dark:bg-dark-700 dark:text-white"
              />
            </Field>

            <Field
              label="Egress proxy *"
              hint="Required: every Instagram account is pinned to a proxy you own. Add proxies in the Proxies page."
            >
              {proxyState === 'trial_blocked' ? (
                <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-700">
                  Bring-your-own proxy is a paid feature. <a href="/billing" className="underline">Upgrade</a> to add a proxy.
                </div>
              ) : proxyState === 'loading' ? (
                <div className="text-xs text-gray-500">Loading your proxies…</div>
              ) : proxies.length === 0 ? (
                <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-700">
                  You haven&apos;t added any proxies. <a href="/instagram/proxies" target="_blank" rel="noopener noreferrer" className="underline">Add one</a> first.
                </div>
              ) : (
                <select
                  value={proxyId}
                  onChange={(e) => setProxyId(e.target.value)}
                  disabled={loading}
                  className="block w-full rounded-lg border border-gray-200 bg-white p-2.5 text-sm focus:border-pink-500 focus:outline-none focus:ring-2 focus:ring-pink-200 dark:border-dark-600 dark:bg-dark-700 dark:text-white"
                >
                  <option value="">— Pick a proxy —</option>
                  {proxies.map((p) => {
                    const cc = p.country_code ? ` ${p.country_code.toUpperCase()}` : '';
                    const ig = p.validated_for_instagram ? ' · IG✓' : '';
                    const dead = p.is_working ? '' : ' · ⚠ not working';
                    return (
                      <option key={p.id} value={p.id}>
                        {(p.label || `${p.host}:${p.port}`)}{cc} · {p.protocol.toUpperCase()}{ig}{dead}
                      </option>
                    );
                  })}
                </select>
              )}
            </Field>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancel}
                disabled={loading}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-dark-600 dark:text-gray-300 dark:hover:bg-dark-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className={`flex items-center gap-2 rounded-lg ${IG_GRADIENT} px-5 py-2 text-sm font-semibold text-white shadow disabled:opacity-50`}
              >
                {loading ? 'Working…' : (<>Continue <ArrowRight className="h-4 w-4" /></>)}
              </button>
            </div>
          </form>
        )}

        {step === 'twofa' && (
          <form onSubmit={submit2fa} className="space-y-4">
            <div className="rounded-lg border border-pink-100 bg-pink-50 p-3 text-sm text-pink-800 dark:border-pink-900/30 dark:bg-pink-900/10 dark:text-pink-200">
              Two-factor authentication is enabled on this account. Enter the 6-digit TOTP code from your authenticator app
              {twofaIdentifier ? ` (identifier: ${String(twofaIdentifier).slice(0, 12)}…)` : ''}.
            </div>

            <Field label="Authenticator code">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={loading}
                className="block w-full rounded-lg border border-gray-200 bg-white p-2.5 text-center text-lg tracking-widest focus:border-pink-500 focus:outline-none focus:ring-2 focus:ring-pink-200 dark:border-dark-600 dark:bg-dark-700 dark:text-white"
                placeholder="••••••"
              />
            </Field>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancel}
                disabled={loading}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-dark-600 dark:text-gray-300 dark:hover:bg-dark-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className={`flex items-center gap-2 rounded-lg ${IG_GRADIENT} px-5 py-2 text-sm font-semibold text-white shadow disabled:opacity-50`}
              >
                {loading ? 'Verifying…' : (<>Verify <ArrowRight className="h-4 w-4" /></>)}
              </button>
            </div>
          </form>
        )}

        {step === 'challenge' && (
          <form onSubmit={submitChallenge} className="space-y-4">
            <div className="rounded-lg border border-pink-100 bg-pink-50 p-3 text-sm text-pink-800 dark:border-pink-900/30 dark:bg-pink-900/10 dark:text-pink-200">
              Instagram has issued a security checkpoint. Choose how you want to receive the verification code, then enter it below.
            </div>

            <Field label="Delivery method">
              <div className="flex gap-2">
                {['sms', 'email'].map((m) => (
                  <button
                    type="button"
                    key={m}
                    onClick={() => setChallengeMethod(m)}
                    disabled={loading}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm transition ${
                      challengeMethod === m
                        ? `${IG_GRADIENT} border-transparent text-white`
                        : 'border-gray-200 bg-white text-gray-700 hover:border-pink-200 dark:border-dark-600 dark:bg-dark-700 dark:text-gray-200'
                    }`}
                  >
                    {m.toUpperCase()}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Verification code">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={loading}
                className="block w-full rounded-lg border border-gray-200 bg-white p-2.5 text-center text-lg tracking-widest focus:border-pink-500 focus:outline-none focus:ring-2 focus:ring-pink-200 dark:border-dark-600 dark:bg-dark-700 dark:text-white"
                placeholder="••••••"
              />
            </Field>

            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={resend}
                disabled={loading}
                className="flex items-center gap-1 rounded-lg border border-pink-200 bg-pink-50 px-3 py-2 text-sm text-pink-700 transition hover:bg-pink-100 disabled:opacity-50 dark:border-pink-900/30 dark:bg-pink-900/10 dark:text-pink-200"
              >
                <RefreshCw className="h-4 w-4" /> Resend
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={cancel}
                  disabled={loading}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-dark-600 dark:text-gray-300 dark:hover:bg-dark-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className={`flex items-center gap-2 rounded-lg ${IG_GRADIENT} px-5 py-2 text-sm font-semibold text-white shadow disabled:opacity-50`}
                >
                  {loading ? 'Verifying…' : (<>Verify <ArrowRight className="h-4 w-4" /></>)}
                </button>
              </div>
            </div>
          </form>
        )}

        {step === 'done' && (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <div className="text-lg font-semibold text-gray-900 dark:text-white">
              Instagram session ready
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {createdSession?.username
                ? <>Logged in as <strong>@{createdSession.username}</strong>. You can now run scrape jobs from this account.</>
                : 'You can now run scrape jobs from this account.'}
            </div>
            <div className="flex justify-center gap-2">
              <button
                onClick={() => navigate('/instagram/sessions')}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 transition hover:bg-gray-50 dark:border-dark-600 dark:text-gray-200 dark:hover:bg-dark-700"
              >
                View sessions
              </button>
              <button
                onClick={() => navigate('/instagram/scrape')}
                className={`rounded-lg ${IG_GRADIENT} px-4 py-2 text-sm font-semibold text-white shadow`}
              >
                Start scraping
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
