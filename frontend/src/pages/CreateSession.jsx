import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Phone,
  KeyRound,
  ShieldCheck,
  Send,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Eye,
  EyeOff,
  X,
  RefreshCcw,
  Download,
  Copy,
  ArrowRight,
  Network,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../components/common/Toast';
import {
  createSessionStart,
  createSessionVerify,
  createSessionPassword,
  createSessionResend,
  createSessionCancel,
  downloadSession,
} from '../api/sessions';
import { listMyProxies } from '../api/userProxies';
import { parseApiError } from '../utils/formatters';

const STEPS = [
  { id: 'phone', label: 'Phone', icon: Phone },
  { id: 'code', label: 'OTP', icon: KeyRound },
  { id: 'password', label: '2FA', icon: ShieldCheck },
  { id: 'done', label: 'Ready', icon: CheckCircle2 },
];

function StepDots({ current }) {
  const idx = STEPS.findIndex((s) => s.id === current);
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((s, i) => {
        const Icon = s.icon;
        const active = i === idx;
        const done = i < idx;
        const skipped = current === 'done' && s.id === 'password' && idx === 3;
        return (
          <div key={s.id} className="flex items-center gap-2">
            <div
              className={
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ' +
                (active
                  ? 'border-primary-500 bg-primary-500/10 text-primary-200'
                  : done
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : 'border-white/10 bg-white/5 text-gray-400')
              }
            >
              <Icon className="w-3.5 h-3.5" />
              <span className="font-medium">{s.label}</span>
            </div>
            {i < STEPS.length - 1 ? (
              <ArrowRight className="w-3.5 h-3.5 text-gray-600" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ErrorBanner({ message }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="break-words">{message}</div>
    </div>
  );
}

// Anti-revoke (Phase 1 §B2): a small curated list of country codes
// that map to a regionalised langCode + IANA timezone in the backend's
// COUNTRY_LANG / COUNTRY_TZ tables. The backend gracefully falls back
// to 'en'/'UTC' for anything not in this list, so it's safe to keep
// the dropdown lean.
const TG_COUNTRY_OPTIONS = [
  { code: '', label: 'Auto (no override)' },
  { code: 'in', label: 'India (en-IN, Asia/Kolkata)' },
  { code: 'us', label: 'United States (en-US, America/New_York)' },
  { code: 'gb', label: 'United Kingdom (en-GB, Europe/London)' },
  { code: 'ca', label: 'Canada (en-CA, America/Toronto)' },
  { code: 'au', label: 'Australia (en-AU, Australia/Sydney)' },
  { code: 'de', label: 'Germany (de-DE, Europe/Berlin)' },
  { code: 'fr', label: 'France (fr-FR, Europe/Paris)' },
  { code: 'es', label: 'Spain (es-ES, Europe/Madrid)' },
  { code: 'it', label: 'Italy (it-IT, Europe/Rome)' },
  { code: 'br', label: 'Brazil (pt-BR, America/Sao_Paulo)' },
  { code: 'mx', label: 'Mexico (es-MX, America/Mexico_City)' },
  { code: 'tr', label: 'Turkey (tr-TR, Europe/Istanbul)' },
  { code: 'ru', label: 'Russia (ru-RU, Europe/Moscow)' },
  { code: 'ua', label: 'Ukraine (uk-UA, Europe/Kyiv)' },
  { code: 'sa', label: 'Saudi Arabia (ar-SA, Asia/Riyadh)' },
  { code: 'ae', label: 'UAE (ar-AE, Asia/Dubai)' },
  { code: 'ir', label: 'Iran (fa-IR, Asia/Tehran)' },
  { code: 'pk', label: 'Pakistan (en-PK, Asia/Karachi)' },
  { code: 'bd', label: 'Bangladesh (bn-BD, Asia/Dhaka)' },
  { code: 'id', label: 'Indonesia (id-ID, Asia/Jakarta)' },
  { code: 'ph', label: 'Philippines (en-PH, Asia/Manila)' },
  { code: 'th', label: 'Thailand (th-TH, Asia/Bangkok)' },
  { code: 'vn', label: 'Vietnam (vi-VN, Asia/Ho_Chi_Minh)' },
  { code: 'jp', label: 'Japan (ja-JP, Asia/Tokyo)' },
  { code: 'kr', label: 'South Korea (ko-KR, Asia/Seoul)' },
  { code: 'sg', label: 'Singapore (en-SG, Asia/Singapore)' },
  { code: 'my', label: 'Malaysia (ms-MY, Asia/Kuala_Lumpur)' },
];

const TG_PLATFORM_OPTIONS = [
  { code: '', label: 'Auto (any device profile)' },
  { code: 'android', label: 'Android (Telegram Android)' },
  { code: 'ios', label: 'iOS (Telegram iOS)' },
  { code: 'desktop', label: 'Desktop (Telegram Desktop)' },
  { code: 'web', label: 'Web (Telegram Web Z/K)' },
];

function PhoneStep({
  phone, setPhone, country, setCountry, platform, setPlatform,
  proxyId, setProxyId, proxies, proxyState,
  useProxy, setUseProxy,
  onSubmit, busy,
}) {
  const noProxies = proxyState === 'ready' && proxies.length === 0;
  const trialBlocked = proxyState === 'trial_blocked';
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-4"
    >
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">
          Phone number (international format)
        </label>
        <div className="relative">
          <Phone className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            autoFocus
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+14155551234"
            className="w-full rounded-lg border border-white/10 bg-dark-900 pl-9 pr-3 py-2.5 text-sm text-white placeholder:text-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
        </div>
        <p className="mt-1.5 text-[11px] text-gray-500">
          Telegram will send a one-time login code to this number. The panel
          relays the code, never stores or shows it to other users.
        </p>
      </div>

      {/* Anti-revoke (Phase 1 §B2 + §B1): country + platform pinning */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">
            Country (sets locale + timezone)
          </label>
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2.5 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          >
            {TG_COUNTRY_OPTIONS.map((o) => (
              <option key={o.code} value={o.code}>{o.label}</option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] text-gray-500">
            Tells Telegram a consistent locale matching the proxy region.
          </p>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">
            Device profile (pinned for life of session)
          </label>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2.5 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          >
            {TG_PLATFORM_OPTIONS.map((o) => (
              <option key={o.code} value={o.code}>{o.label}</option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] text-gray-500">
            Pins device_model + system_version + app_version.
          </p>
        </div>
      </div>

      {/* BYO Proxy (Phase 3 §5.2): every account can pin an egress
          proxy. Phase 3 made this mandatory; we now offer an opt-out
          tickbox so an operator can deliberately create a session
          that egresses direct from the panel host (useful when the
          panel itself runs on a residential / mobile IP). The picker
          stays exactly as before when "Use a proxy" is on. */}
      <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2.5">
        <label className="flex items-start gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={useProxy}
            onChange={(e) => setUseProxy(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-white/20 bg-dark-900 text-primary-500 focus:ring-primary-500 focus:ring-offset-0"
          />
          <span className="text-xs text-gray-300">
            <span className="font-medium text-white inline-flex items-center gap-1.5">
              <Network className="w-3.5 h-3.5" /> Use a proxy for this session
            </span>
            <span className="block mt-0.5 text-[11px] text-gray-500">
              Recommended. When off, the session connects direct from
              the panel host — faster to set up, but every Telegram
              call for this account will use the panel&apos;s public IP.
            </span>
          </span>
        </label>
      </div>

      {useProxy ? (
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5 flex items-center gap-2">
          <Network className="w-3.5 h-3.5" />
          Egress proxy <span className="text-red-400">*</span>
        </label>
        {trialBlocked ? (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
            Bring-your-own proxy is a paid feature. <a href="/billing" className="underline">Upgrade</a> to add a proxy and create accounts.
          </div>
        ) : noProxies ? (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
            You haven&apos;t added any proxies yet. <a href="/proxies" target="_blank" rel="noopener noreferrer" className="underline">Add one in My Proxies</a> first — every Telegram account on this panel is pinned to a proxy you own.
          </div>
        ) : proxyState === 'loading' ? (
          <div className="rounded-lg border border-white/10 bg-dark-900 px-3 py-2.5 text-xs text-gray-400">
            <Loader2 className="w-3 h-3 inline animate-spin mr-2" />
            Loading your proxies…
          </div>
        ) : (
          <div className="space-y-2">
            <select
              value={proxyId || ''}
              onChange={(e) => setProxyId(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2.5 text-sm text-white focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            >
              <option value="">— Pick a proxy —</option>
              {proxies.map((p) => {
                const flag = p.country_code ? ` ${p.country_code.toUpperCase()}` : '';
                const tg = p.validated_for_telegram ? ' · TG✓' : '';
                const dead = p.is_working ? '' : ' · ⚠ not working';
                return (
                  <option key={p.id} value={p.id}>
                    {(p.label || `${p.host}:${p.port}`)}{flag} · {p.protocol.toUpperCase()}{tg}{dead}
                  </option>
                );
              })}
            </select>
            <p className="text-[11px] text-gray-500">
              The session is pinned to this proxy for life. <a href="/proxies" target="_blank" rel="noopener noreferrer" className="text-primary-400 hover:underline">+ Add new proxy…</a>
            </p>
          </div>
        )}
      </div>
      ) : (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2 text-[11px] text-yellow-200/90">
          Proxy disabled — this session will connect direct from the
          panel&apos;s public IP. Continue only if you understand the
          fingerprint trade-off.
        </div>
      )}

      <button
        type="submit"
        disabled={
          busy ||
          !phone.trim() ||
          (useProxy && (trialBlocked || noProxies || !proxyId))
        }
        className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-500 px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Send className="w-4 h-4" />
        )}
        Send login code
      </button>
    </form>
  );
}

function CodeStep({ code, setCode, onSubmit, onResend, onCancel, busy, phone, codeType }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-4"
    >
      <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-gray-400">
        Code sent to <span className="text-white font-medium">{phone}</span>
        {codeType ? (
          <span className="ml-2 inline-flex items-center rounded-full bg-primary-500/10 text-primary-200 px-2 py-0.5 text-[11px] uppercase tracking-wide">
            {codeType.replace('auth.SentCodeType', '').toLowerCase()}
          </span>
        ) : null}
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">
          OTP code
        </label>
        <input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
          placeholder="12345"
          className="w-full rounded-lg border border-white/10 bg-dark-900 px-3 py-2.5 text-base font-mono tracking-widest text-white placeholder:text-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
        />
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <button
          type="submit"
          disabled={busy || code.length < 5}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-500 px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
          Verify
        </button>
        <button
          type="button"
          onClick={onResend}
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 hover:bg-white/5 px-3 py-2.5 text-sm text-gray-300 transition disabled:opacity-50"
          title="Resend code"
        >
          <RefreshCcw className="w-4 h-4" /> Resend
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 px-3 py-2.5 text-sm transition disabled:opacity-50"
        >
          <X className="w-4 h-4" /> Cancel
        </button>
      </div>
    </form>
  );
}

function PasswordStep({ password, setPassword, onSubmit, onCancel, busy }) {
  const [show, setShow] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-4"
    >
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        This account has 2FA enabled. Enter the cloud password to finish login.
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">
          2FA cloud password
        </label>
        <div className="relative">
          <ShieldCheck className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            autoFocus
            type={show ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full rounded-lg border border-white/10 bg-dark-900 pl-9 pr-10 py-2.5 text-sm text-white placeholder:text-gray-500 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
          >
            {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-500 px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
          Submit password
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 px-3 py-2.5 text-sm transition disabled:opacity-50"
        >
          <X className="w-4 h-4" /> Cancel
        </button>
      </div>
    </form>
  );
}

function DoneStep({ result, onDownload, onRestart, onGoToSessions }) {
  const acc = result?.accountInfo || {};
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 flex items-start gap-3">
        <CheckCircle2 className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0" />
        <div className="text-sm">
          <div className="font-medium text-emerald-200">
            Session #{result.sessionId} is active and kept alive.
          </div>
          <div className="text-xs text-emerald-300/80 mt-0.5">
            The panel will heartbeat this client every minute and restore it
            automatically across backend restarts.
          </div>
        </div>
      </div>
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-gray-300 space-y-2">
        <div className="grid grid-cols-2 gap-y-2 gap-x-4">
          <span className="text-gray-500">Phone</span>
          <span className="font-mono">{result.phone}</span>
          <span className="text-gray-500">Telegram ID</span>
          <span className="font-mono">{acc.telegramId || '—'}</span>
          <span className="text-gray-500">Username</span>
          <span className="font-mono">{acc.username ? `@${acc.username}` : '—'}</span>
          <span className="text-gray-500">Name</span>
          <span>{[acc.firstName, acc.lastName].filter(Boolean).join(' ') || '—'}</span>
        </div>
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <button
          onClick={onDownload}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-500 px-4 py-2.5 text-sm font-medium text-white transition"
        >
          <Download className="w-4 h-4" /> Download session file
        </button>
        <button
          onClick={onGoToSessions}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 hover:bg-white/5 px-4 py-2.5 text-sm text-gray-200 transition"
        >
          Open Sessions
        </button>
        <button
          onClick={onRestart}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 hover:bg-white/5 px-4 py-2.5 text-sm text-gray-300 transition"
        >
          Create another
        </button>
      </div>
    </div>
  );
}

export default function CreateSession() {
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('');
  const [platform, setPlatform] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [tempId, setTempId] = useState(null);
  const [codeType, setCodeType] = useState(null);
  const [result, setResult] = useState(null);
  const tempIdRef = useRef(null);
  // BYO Proxy (Phase 3): list user's proxies + selection.
  const [proxyId, setProxyId] = useState('');
  const [proxies, setProxies] = useState([]);
  const [proxyState, setProxyState] = useState('loading'); // loading | ready | trial_blocked | error
  // Proxy-optional: tickbox to opt out of binding a proxy at create
  // time. Defaults to ON so existing flows work unchanged.
  const [useProxy, setUseProxy] = useState(true);

  const loadProxies = useCallback(async () => {
    setProxyState('loading');
    try {
      const r = await listMyProxies();
      const rows = r.data?.data?.proxies || [];
      setProxies(rows);
      // Pre-select the first working + TG-validated proxy if any.
      const auto = rows.find((p) => p.is_working && p.validated_for_telegram)
        || rows.find((p) => p.is_working)
        || rows[0];
      if (auto) setProxyId(String(auto.id));
      setProxyState('ready');
    } catch (e) {
      const code = e?.response?.data?.error?.code || e?.response?.data?.code;
      if (code === 'TRIAL_FEATURE_NOT_ALLOWED') setProxyState('trial_blocked');
      else setProxyState('error');
    }
  }, []);

  useEffect(() => { loadProxies(); }, [loadProxies]);

  // Tear down any pending creation flow if the user navigates away
  // mid-flow. We rely on the backend's TTL reaper as a backstop.
  useEffect(() => {
    return () => {
      const t = tempIdRef.current;
      if (t) {
        createSessionCancel({ tempId: t }).catch(() => {});
      }
    };
  }, []);

  const reset = () => {
    setStep('phone');
    setBusy(false);
    setError(null);
    setPhone('');
    setCode('');
    setPassword('');
    setTempId(null);
    setCodeType(null);
    setResult(null);
    tempIdRef.current = null;
  };

  const handleStart = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await createSessionStart({
        phone,
        country: country || undefined,
        platform: platform || undefined,
        // Only forward proxyId when the operator opted in. The
        // backend treats `useProxy === false` as a hard opt-out and
        // ignores proxyId in that case anyway.
        proxyId: useProxy && proxyId ? Number(proxyId) : undefined,
        useProxy,
      });
      const data = r.data?.data || r.data;
      setTempId(data.tempId);
      tempIdRef.current = data.tempId;
      setCodeType(data.codeType);
      setStep('code');
      toast.info(`Code sent to ${data.phone}`);
    } catch (e) {
      const code = e?.response?.data?.error?.code || e?.response?.data?.code;
      if (code === 'NO_USER_PROXY') {
        setError('You need at least one working proxy in My Proxies before creating a session.');
      } else {
        setError(parseApiError(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await createSessionVerify({ tempId, code });
      const data = r.data?.data || r.data;
      if (data.status === 'awaiting_password') {
        setStep('password');
        toast.info('2FA password required');
      } else if (data.status === 'active') {
        setResult(data);
        setStep('done');
        tempIdRef.current = null;
        toast.success(`Session #${data.sessionId} created`);
      }
    } catch (e) {
      setError(parseApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const handlePassword = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await createSessionPassword({ tempId, password });
      const data = r.data?.data || r.data;
      setResult(data);
      setStep('done');
      tempIdRef.current = null;
      toast.success(`Session #${data.sessionId} created`);
    } catch (e) {
      setError(parseApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleResend = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await createSessionResend({ tempId });
      const data = r.data?.data || r.data;
      setCodeType(data.codeType);
      toast.info('Code resent');
    } catch (e) {
      setError(parseApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    setBusy(true);
    try {
      if (tempId) await createSessionCancel({ tempId });
    } catch (_) {}
    reset();
    toast.info('Cancelled');
  };

  const handleDownload = async () => {
    if (!result?.sessionId) return;
    try {
      const fileName = `${(result.phone || 'session').replace(/[^A-Za-z0-9+_-]/g, '')}.json`;
      await downloadSession(result.sessionId, fileName);
    } catch (e) {
      toast.error(parseApiError(e));
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Create Session</h1>
        <p className="text-sm text-gray-400 mt-1">
          Log in a brand-new Telegram account by phone + OTP. The resulting
          session is persisted, kept alive, and downloadable.
        </p>
      </div>

      <div className="rounded-2xl border border-white/10 bg-dark-800/60 p-4">
        <StepDots current={step} />
      </div>

      <div className="rounded-2xl border border-white/10 bg-dark-800/60 p-6 max-w-xl">
        <ErrorBanner message={error} />
        <div className="mt-4">
          {step === 'phone' && (
            <PhoneStep
              phone={phone}
              setPhone={setPhone}
              country={country}
              setCountry={setCountry}
              platform={platform}
              setPlatform={setPlatform}
              proxyId={proxyId}
              setProxyId={setProxyId}
              proxies={proxies}
              proxyState={proxyState}
              useProxy={useProxy}
              setUseProxy={setUseProxy}
              onSubmit={handleStart}
              busy={busy}
            />
          )}
          {step === 'code' && (
            <CodeStep
              code={code}
              setCode={setCode}
              onSubmit={handleVerify}
              onResend={handleResend}
              onCancel={handleCancel}
              busy={busy}
              phone={phone}
              codeType={codeType}
            />
          )}
          {step === 'password' && (
            <PasswordStep
              password={password}
              setPassword={setPassword}
              onSubmit={handlePassword}
              onCancel={handleCancel}
              busy={busy}
            />
          )}
          {step === 'done' && result && (
            <DoneStep
              result={result}
              onDownload={handleDownload}
              onRestart={reset}
              onGoToSessions={() => navigate('/sessions')}
            />
          )}
        </div>
      </div>
    </div>
  );
}
