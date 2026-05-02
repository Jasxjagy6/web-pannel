import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CreditCard, Sparkles, Loader2, RefreshCw, ShieldCheck, Wallet,
  CheckCircle2, AlertTriangle, Clock, ArrowRight, Bitcoin, Copy,
  History, ExternalLink, Hourglass, X,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { usePlatform, PLATFORM_LABELS } from '@/context/PlatformContext';
import {
  getBillingStatus, getBillingConfig, startTrial as apiStartTrial,
  createCheckout, listMyInvoices, refreshInvoice,
} from '@/api/billing';
import { useToast } from '@/components/common/Toast';
import { parseApiError, formatDateTime, formatRelativeTime } from '@/utils/formatters';

const FEATURE_LABELS = {
  dashboard: 'Dashboard',
  sessions: 'Sessions',
  scrape: 'Scrape',
  messaging: 'Messaging',
  groups: 'Groups',
  lists: 'Lists',
  reports: 'Reports',
  get_otp: 'Get OTP',
  change_2fa: 'Change 2FA',
  proxies: 'Proxies',
  anti_detect: 'Anti-Detect',
  privacy: 'Privacy',
};

function fmtCountdown(target) {
  if (!target) return '—';
  const ms = new Date(target).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hrs = Math.floor((s % 86400) / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (days > 0) return `${days}d ${hrs}h ${min}m`;
  if (hrs > 0) return `${hrs}h ${min}m ${sec}s`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

const STATUS_COLORS = {
  paid:      'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  pending:   'bg-amber-500/15 text-amber-300 border-amber-500/30',
  failed:    'bg-rose-500/15 text-rose-300 border-rose-500/30',
  expired:   'bg-dark-700/50 text-dark-300 border-dark-600',
  cancelled: 'bg-dark-700/50 text-dark-300 border-dark-600',
  refunded:  'bg-blue-500/15 text-blue-300 border-blue-500/30',
};

export default function Billing() {
  const toast = useToast();
  const navigate = useNavigate();
  const { refreshProfile } = useAuth();
  const { platform } = usePlatform();

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [trialBusy, setTrialBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState({ telegram: false, instagram: false, bundle: false });
  const [pendingInvoice, setPendingInvoice] = useState(null);

  const [invoices, setInvoices] = useState([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);

  // Per-platform billing config cards (TG / IG / bundle).
  const [tgCfg, setTgCfg] = useState(null);
  const [igCfg, setIgCfg] = useState(null);

  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => (n + 1) % 1000), 1000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    try {
      const [statusR, tgR, igR] = await Promise.all([
        getBillingStatus(platform),
        getBillingConfig('telegram').catch(() => null),
        getBillingConfig('instagram').catch(() => null),
      ]);
      setStatus(statusR.data?.data || null);
      setTgCfg(tgR?.data?.data || null);
      setIgCfg(igR?.data?.data || null);
    } catch (e) {
      toast.error(parseApiError(e), 'Failed to load billing status');
    } finally {
      setLoading(false);
    }
  }, [toast, platform]);

  const loadInvoices = useCallback(async () => {
    setInvoicesLoading(true);
    try {
      const r = await listMyInvoices({ limit: 20 });
      setInvoices(r.data?.data?.invoices || []);
    } catch (e) {
      // history is non-critical
    } finally {
      setInvoicesLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadInvoices();
  }, [load, loadInvoices]);

  // Auto-refresh status every 10s while a payment is pending so a paid
  // invoice flips the page to "active" without a manual reload.
  useEffect(() => {
    if (!pendingInvoice) return;
    const interval = setInterval(async () => {
      try {
        await refreshInvoice(pendingInvoice.id);
        await load();
        await loadInvoices();
      } catch { /* ignore */ }
    }, 10000);
    return () => clearInterval(interval);
  }, [pendingInvoice, load, loadInvoices]);

  const config = status?.config || {};
  const ent = status?.entitlement || { allowed: false, mode: 'none' };
  const sub = status?.user?.subscription || {};
  const trial = status?.user?.trial || {};

  const priceUsd = Number(config['billing.subscription_price_usd'] || 0);
  const periodDays = Number(config['billing.subscription_period_days'] || 30);
  const trialEnabled = !!config['billing.trial_enabled'];
  const trialMin = Number(config['billing.trial_duration_minutes'] || 5);
  const trialFeatures = Array.isArray(config['billing.trial_allowed_features'])
    ? config['billing.trial_allowed_features']
    : [];

  const isAdmin = status?.user?.role === 'admin';
  const subActive = sub.status === 'active' && sub.expiresAt && new Date(sub.expiresAt) > new Date();
  const trialActive = trial.expiresAt && new Date(trial.expiresAt) > new Date();
  const trialUsed = !!trial.used;

  const onTrial = async (whichPlatform = platform) => {
    setTrialBusy(true);
    try {
      await apiStartTrial(whichPlatform);
      toast.success(`Free trial activated for ${PLATFORM_LABELS[whichPlatform] || whichPlatform}`);
      await load();
      await refreshProfile();
    } catch (e) {
      toast.error(parseApiError(e), 'Could not start trial');
    } finally {
      setTrialBusy(false);
    }
  };

  /**
   * Open OxaPay checkout for the given billing rail:
   *   { platform: 'telegram' }                 → TG-only
   *   { platform: 'instagram' }                → IG-only
   *   { platform: 'telegram', bundle: 'bundle' } → bundle (TG + IG)
   */
  const onCheckout = async (opts = {}) => {
    const railKey = opts.bundle === 'bundle' ? 'bundle' : (opts.platform || platform);
    setCheckoutBusy((s) => ({ ...s, [railKey]: true }));
    try {
      const r = await createCheckout({
        platform: opts.platform || platform,
        bundle: opts.bundle || 'none',
      });
      const inv = r.data?.data?.invoice;
      if (!inv?.paymentUrl) throw new Error('No payment URL returned');
      setPendingInvoice(inv);
      window.open(inv.paymentUrl, '_blank', 'noopener,noreferrer');
      await loadInvoices();
    } catch (e) {
      toast.error(parseApiError(e), 'Could not create invoice');
    } finally {
      setCheckoutBusy((s) => ({ ...s, [railKey]: false }));
    }
  };

  const onRefreshInvoice = async (id) => {
    try {
      await refreshInvoice(id);
      await load();
      await loadInvoices();
    } catch (e) {
      toast.error(parseApiError(e), 'Refresh failed');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-10 text-dark-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading billing…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Billing &amp; Subscription</h1>
          <p className="mt-1 text-sm text-dark-400">
            Activate your subscription with crypto via OxaPay or test the app with a free trial.
          </p>
        </div>
        <button
          onClick={() => { load(); loadInvoices(); }}
          className="inline-flex items-center gap-2 self-start rounded-xl border border-dark-700 bg-dark-800/70 px-3 py-2 text-sm font-medium text-dark-200 hover:border-dark-600 hover:bg-dark-800"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {/* Current state hero */}
      <CurrentStateCard
        ent={ent}
        sub={sub}
        trial={trial}
        subActive={subActive}
        trialActive={trialActive}
        isAdmin={isAdmin}
        priceUsd={priceUsd}
        periodDays={periodDays}
        onGoApp={() => navigate(`/${platform}/dashboard`)}
      />

      {/* Pending payment banner */}
      {pendingInvoice && !subActive && (
        <PendingInvoiceBanner
          inv={pendingInvoice}
          onRefresh={() => onRefreshInvoice(pendingInvoice.id)}
          onClose={() => setPendingInvoice(null)}
        />
      )}

      {/* Per-platform plan grid + bundle. Each rail has its own price,
          period, and trial state — entitlement is independent on each
          platform so the user can subscribe to TG only, IG only, or both. */}
      {!isAdmin && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <PlatformPlanCard
            platform="telegram"
            cfg={tgCfg}
            busy={!!checkoutBusy.telegram}
            trialBusy={trialBusy}
            statusUser={status?.user}
            onCheckout={onCheckout}
            onTrial={onTrial}
          />
          <PlatformPlanCard
            platform="instagram"
            cfg={igCfg}
            busy={!!checkoutBusy.instagram}
            trialBusy={trialBusy}
            statusUser={status?.user}
            onCheckout={onCheckout}
            onTrial={onTrial}
          />
          <BundlePlanCard
            tgCfg={tgCfg}
            igCfg={igCfg}
            busy={!!checkoutBusy.bundle}
            onCheckout={onCheckout}
          />
        </div>
      )}

      {/* Invoice history */}
      <InvoiceHistory
        invoices={invoices}
        loading={invoicesLoading}
        onRefresh={onRefreshInvoice}
      />
    </div>
  );
}

function CurrentStateCard({
  ent, sub, trial, subActive, trialActive, isAdmin, priceUsd, periodDays, onGoApp,
}) {
  let title; let body; let icon = ShieldCheck; let tone = 'primary';
  if (isAdmin) {
    title = 'You are an administrator';
    body = 'Admin accounts bypass subscription gating and can use every feature.';
    icon = ShieldCheck;
    tone = 'primary';
  } else if (subActive) {
    title = 'Subscription active';
    body = `Your premium subscription expires ${formatDateTime(sub.expiresAt)} (${fmtCountdown(sub.expiresAt)} left).`;
    icon = CheckCircle2;
    tone = 'success';
  } else if (trialActive) {
    title = 'Free trial running';
    body = `Your trial expires in ${fmtCountdown(trial.expiresAt)} — pay $${priceUsd.toFixed(2)} for ${periodDays} days of full access before then to avoid interruption.`;
    icon = Sparkles;
    tone = 'amber';
  } else {
    title = 'Subscription required';
    body = `You need an active subscription ($${priceUsd.toFixed(2)} / ${periodDays} days) to use the panel. ${trial.used ? 'Your free trial has been used.' : 'A short free trial is available below.'}`;
    icon = AlertTriangle;
    tone = 'rose';
  }

  const Icon = icon;
  const toneClass = {
    success: 'border-emerald-500/30 from-emerald-500/15 to-emerald-500/5 text-emerald-200',
    primary: 'border-primary-500/30 from-primary-600/15 to-primary-600/5 text-primary-200',
    amber:   'border-amber-500/30 from-amber-500/15 to-amber-500/5 text-amber-200',
    rose:    'border-rose-500/30 from-rose-500/15 to-rose-500/5 text-rose-200',
  }[tone];

  return (
    <div className={`rounded-2xl border bg-gradient-to-br p-5 backdrop-blur-sm ${toneClass}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white/5">
            <Icon className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            <p className="mt-1 max-w-2xl text-sm text-white/80">{body}</p>
            {ent?.mode && (
              <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80">
                <span className="font-mono text-[11px] uppercase tracking-wider">Access mode</span>
                <span className="font-medium capitalize">{ent.mode}</span>
              </div>
            )}
          </div>
        </div>
        {(subActive || trialActive || isAdmin) && (
          <button
            onClick={onGoApp}
            className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
          >
            Open dashboard <ArrowRight className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function PlanCard({ title, tagline, price, currency, features, ctaLabel, ctaIcon: CtaIcon = Wallet, ctaSpin, onCta, highlight, disabled }) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border p-6 transition-shadow ${
        highlight
          ? 'border-primary-500/40 bg-gradient-to-br from-primary-600/10 via-dark-900/60 to-blue-600/5 shadow-[0_0_60px_rgba(59,130,246,0.15)]'
          : 'border-dark-700 bg-dark-900/60'
      }`}
    >
      {highlight && (
        <div className="absolute right-0 top-0 rounded-bl-2xl bg-gradient-to-r from-primary-600 to-blue-600 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
          Recommended
        </div>
      )}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-600/20">
          <CreditCard className="h-5 w-5 text-primary-300" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-white">{title}</h3>
          <p className="text-xs text-dark-400">{tagline}</p>
        </div>
      </div>
      <div className="mt-5 flex items-baseline gap-2">
        <span className="text-4xl font-bold text-white">${Number(price).toFixed(2)}</span>
        <span className="text-sm text-dark-400">{currency}</span>
      </div>
      <ul className="mt-5 space-y-2">
        {features.map((f) => (
          <li key={f} className="flex items-center gap-2 text-sm text-dark-200">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" /> {f}
          </li>
        ))}
      </ul>
      <button
        disabled={disabled}
        onClick={onCta}
        className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary-600 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-600/25 transition hover:from-primary-500 hover:to-blue-500 disabled:opacity-50"
      >
        <CtaIcon className={`h-4 w-4 ${ctaSpin ? 'animate-spin' : ''}`} />
        {ctaLabel}
      </button>
      <p className="mt-3 text-center text-[11px] text-dark-500">
        Secure crypto checkout · BTC, ETH, USDT &amp; more · Powered by OxaPay
      </p>
    </div>
  );
}

function TrialCard({ enabled, durationMinutes, allowedFeatures, used, active, expiresAt, busy, onStart }) {
  const labels = (allowedFeatures || []).map((k) => FEATURE_LABELS[k] || k);
  return (
    <div className="rounded-2xl border border-dark-700 bg-dark-900/60 p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/15">
          <Sparkles className="h-5 w-5 text-amber-300" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-white">Free trial</h3>
          <p className="text-xs text-dark-400">No card required · One-time</p>
        </div>
      </div>
      <div className="mt-5 flex items-baseline gap-2">
        <span className="text-4xl font-bold text-white">{durationMinutes}</span>
        <span className="text-sm text-dark-400">minute{durationMinutes !== 1 ? 's' : ''}</span>
      </div>
      <p className="mt-3 text-xs text-dark-400">
        {enabled
          ? `Try the platform for ${durationMinutes} minute${durationMinutes !== 1 ? 's' : ''} with these features unlocked:`
          : 'Free trial is currently disabled by the administrator.'}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {labels.length > 0 ? labels.map((l) => (
          <span key={l} className="rounded-full border border-dark-700 bg-dark-800/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-dark-300">{l}</span>
        )) : (
          <span className="text-[11px] text-dark-500">No features whitelisted by admin.</span>
        )}
      </div>
      <button
        disabled={!enabled || used || busy || active}
        onClick={onStart}
        className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm font-semibold text-amber-200 hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {active ? `Trial running · ${fmtCountdown(expiresAt)} left`
          : used ? 'Trial already used'
          : !enabled ? 'Trial disabled'
          : `Start ${durationMinutes}-minute trial`}
      </button>
    </div>
  );
}

function PendingInvoiceBanner({ inv, onRefresh, onClose }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    if (!inv.paymentUrl) return;
    navigator.clipboard?.writeText(inv.paymentUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 backdrop-blur-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <Hourglass className="h-5 w-5 shrink-0 text-amber-300" />
          <div>
            <p className="text-sm font-semibold text-amber-100">Awaiting payment confirmation</p>
            <p className="mt-1 text-xs text-amber-200/80">
              Invoice #{inv.id} · ${Number(inv.amountUsd).toFixed(2)} {inv.currency}.
              We'll auto-refresh every 10 seconds. Confirmations on the blockchain can take a few minutes.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {inv.paymentUrl && (
            <a
              href={inv.paymentUrl}
              target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/20"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open OxaPay
            </a>
          )}
          {inv.paymentUrl && (
            <button
              onClick={onCopy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/15"
            >
              <Copy className="h-3.5 w-3.5" /> {copied ? 'Copied' : 'Copy link'}
            </button>
          )}
          <button
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/15"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Check status
          </button>
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-transparent px-2 py-1.5 text-xs text-amber-100 hover:bg-amber-500/10"
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function InvoiceHistory({ invoices, loading, onRefresh }) {
  return (
    <div className="rounded-2xl border border-dark-800 bg-dark-900/60 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-dark-800 p-4">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-dark-400" />
          <h3 className="text-sm font-semibold text-white">Payment history</h3>
        </div>
        <span className="text-xs text-dark-500">{invoices.length} invoice{invoices.length !== 1 ? 's' : ''}</span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center p-10 text-dark-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : invoices.length === 0 ? (
        <div className="p-8 text-center text-sm text-dark-500">No invoices yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wider text-dark-500">
              <tr className="border-b border-dark-800">
                <th className="p-3">Created</th>
                <th className="p-3">Amount</th>
                <th className="p-3">Status</th>
                <th className="p-3">OxaPay track</th>
                <th className="p-3">Granted until</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-dark-800/60 hover:bg-dark-800/40">
                  <td className="p-3 text-xs text-dark-300">
                    <div>{formatDateTime(inv.created_at)}</div>
                    <div className="text-[11px] text-dark-500">{formatRelativeTime(inv.created_at)}</div>
                  </td>
                  <td className="p-3 font-medium text-white">
                    ${Number(inv.amount_usd).toFixed(2)} {inv.currency}
                  </td>
                  <td className="p-3">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_COLORS[inv.status] || STATUS_COLORS.pending}`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-[11px] text-dark-400">
                    {inv.oxapay_track_id ? inv.oxapay_track_id.slice(0, 14) + '…' : '—'}
                  </td>
                  <td className="p-3 text-xs text-dark-300">
                    {inv.granted_until ? formatDateTime(inv.granted_until) : '—'}
                  </td>
                  <td className="p-3 text-right">
                    <div className="inline-flex gap-1">
                      {inv.payment_url && inv.status === 'pending' && (
                        <a
                          href={inv.payment_url}
                          target="_blank" rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-lg border border-dark-700 bg-dark-800/70 px-2 py-1 text-[11px] text-dark-200 hover:bg-dark-800"
                          title="Open invoice"
                        >
                          <ExternalLink className="h-3 w-3" /> Open
                        </a>
                      )}
                      {inv.status === 'pending' && (
                        <button
                          onClick={() => onRefresh(inv.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-dark-700 bg-dark-800/70 px-2 py-1 text-[11px] text-dark-200 hover:bg-dark-800"
                          title="Refresh from OxaPay"
                        >
                          <RefreshCw className="h-3 w-3" /> Refresh
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Per-platform plan card. Renders the price, period, "Pay with crypto"
 * CTA, and a small "Start free trial" link if the user hasn't used the
 * trial on this platform yet.
 *
 * The active subscription / trial state for THIS platform is sourced
 * from the multi-platform entitlement map on `status.user.subscriptions`
 * (post-v9 backend). Falls back gracefully when only the legacy single
 * subscription mirror is present.
 */
function PlatformPlanCard({ platform, cfg, busy, trialBusy, statusUser, onCheckout, onTrial }) {
  if (!cfg) {
    return (
      <div className="rounded-2xl border border-dark-700/70 bg-dark-900/60 p-5 text-sm text-dark-400">
        Loading {PLATFORM_LABELS[platform]}…
      </div>
    );
  }
  const subsByPlatform = statusUser?.subscriptions || {};
  const sub = subsByPlatform[platform] || (platform === 'telegram' ? statusUser?.subscription : null) || {};
  const trial = sub.trial || (platform === 'telegram' ? statusUser?.trial : null) || {};
  const subActive = sub.status === 'active' && sub.expiresAt && new Date(sub.expiresAt) > new Date();
  const trialActive = trial?.expiresAt && new Date(trial.expiresAt) > new Date();
  const trialUsed = !!trial?.used;

  const isTG = platform === 'telegram';
  return (
    <div
      className={`relative flex flex-col gap-4 rounded-2xl border p-6 ${
        subActive
          ? 'border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 to-transparent'
          : isTG
            ? 'border-sky-500/30 bg-gradient-to-br from-sky-500/10 to-transparent'
            : 'border-pink-500/30 bg-gradient-to-br from-pink-500/15 to-transparent'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-white shadow ${
            isTG ? 'bg-sky-500' : 'bg-gradient-to-br from-fuchsia-500 to-orange-400'
          }`}
        >
          {isTG ? '✈' : '📷'}
        </span>
        <h3 className="text-base font-semibold text-white">{PLATFORM_LABELS[platform]} Panel</h3>
      </div>

      <div>
        <span className="text-3xl font-bold text-white">${Number(cfg.priceUsd).toFixed(2)}</span>
        <span className="ml-1 text-sm text-dark-300">/ {cfg.periodDays}-day plan</span>
      </div>

      {subActive ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
          Active — {fmtCountdown(sub.expiresAt)} remaining
        </div>
      ) : trialActive ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <Sparkles className="mr-1 inline h-3.5 w-3.5" />
          Trial active — {fmtCountdown(trial.expiresAt)}
        </div>
      ) : null}

      <button
        onClick={() => onCheckout({ platform })}
        disabled={busy}
        className={`mt-auto inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow transition disabled:opacity-50 ${
          isTG
            ? 'bg-sky-600 hover:bg-sky-700'
            : 'bg-gradient-to-r from-fuchsia-600 via-rose-500 to-orange-400 hover:opacity-90'
        }`}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bitcoin className="h-4 w-4" />}
        {busy ? 'Creating invoice…' : `Pay $${Number(cfg.priceUsd).toFixed(2)} with crypto`}
      </button>

      {cfg.trial?.enabled && !trialActive && !trialUsed && !subActive && (
        <button
          onClick={() => onTrial(platform)}
          disabled={trialBusy}
          className="text-xs text-dark-300 hover:text-white disabled:opacity-50"
        >
          {trialBusy ? 'Starting…' : `Start free ${cfg.trial.durationMinutes}-min trial →`}
        </button>
      )}
      {trialUsed && !trialActive && !subActive && (
        <p className="text-xs text-dark-500">Free trial already used on this platform.</p>
      )}
    </div>
  );
}

/**
 * Bundle card — single payment unlocks both Telegram and Instagram for the
 * shared bundle period. Rendered next to the per-platform cards so the
 * user can compare $TG + $IG to $bundle at a glance.
 */
function BundlePlanCard({ tgCfg, igCfg, busy, onCheckout }) {
  const bundle = tgCfg?.bundle || igCfg?.bundle;
  if (!bundle?.enabled) {
    return (
      <div className="rounded-2xl border border-dark-700/70 bg-dark-900/60 p-5 text-sm text-dark-400">
        Bundle plan disabled.
      </div>
    );
  }
  const tgPrice = Number(tgCfg?.priceUsd || 0);
  const igPrice = Number(igCfg?.priceUsd || 0);
  const bundlePrice = Number(bundle.priceUsd || 0);
  const savings = Math.max(0, tgPrice + igPrice - bundlePrice);
  return (
    <div className="relative flex flex-col gap-4 rounded-2xl border border-violet-500/30 bg-gradient-to-br from-violet-600/15 via-violet-500/5 to-fuchsia-500/10 p-6 ring-1 ring-violet-500/20">
      <div className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full bg-violet-500/20 px-2 py-0.5 text-[11px] font-medium text-violet-200">
        <Sparkles className="h-3 w-3" /> Best value
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-fuchsia-500 text-white shadow">
          ⚡
        </span>
        <h3 className="text-base font-semibold text-white">Telegram + Instagram bundle</h3>
      </div>
      <div>
        <span className="text-3xl font-bold text-white">${bundlePrice.toFixed(2)}</span>
        <span className="ml-1 text-sm text-dark-300">/ {bundle.periodDays}-day plan</span>
        {savings > 0 && (
          <span className="ml-2 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[11px] font-semibold text-emerald-200">
            Save ${savings.toFixed(2)}
          </span>
        )}
      </div>
      <ul className="space-y-1.5 text-xs text-dark-200">
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          Full Telegram panel access
        </li>
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          Full Instagram panel access
        </li>
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          One invoice, one payment
        </li>
      </ul>
      <button
        onClick={() => onCheckout({ platform: 'telegram', bundle: 'bundle' })}
        disabled={busy}
        className="mt-auto inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-500 px-4 py-2.5 text-sm font-semibold text-white shadow hover:opacity-90 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bitcoin className="h-4 w-4" />}
        {busy ? 'Creating invoice…' : `Pay $${bundlePrice.toFixed(2)} for both`}
      </button>
    </div>
  );
}
