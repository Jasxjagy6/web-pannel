import { Link, useLocation } from 'react-router-dom';
import {
  Sparkles,
  Hammer,
  Compass,
  ArrowLeft,
  ChevronRight,
} from 'lucide-react';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

const WORKING_FEATURES = [
  { path: '/instagram/dashboard',      label: 'Dashboard',
    desc: 'Live KPI tiles, scrape & DM throughput, account health rollup.' },
  { path: '/instagram/sessions',       label: 'Accounts',
    desc: 'Manage your Instagram session pool, proxies and warm-up state.' },
  { path: '/instagram/create-session', label: 'Add account',
    desc: 'Add an Instagram account via interactive login (mobile API).' },
  { path: '/instagram/upload-session', label: 'Upload session',
    desc: 'Bring an existing cookie / session blob into the panel.' },
  { path: '/instagram/scrape',         label: 'Scraping',
    desc: 'Run followers / following / likers scrapes with anti-ban pacing.' },
];

export default function WorkInProgress({ feature, description }) {
  const location = useLocation();
  // Pretty-print the feature name from the URL if not provided.
  const fallbackName = (() => {
    const seg = (location.pathname || '').split('/').filter(Boolean).slice(1).join(' / ') || 'this section';
    return seg
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  })();
  const title = feature || fallbackName;

  return (
    <div className="min-h-[calc(100vh-9rem)] flex flex-col gap-6">
      {/* Hero card */}
      <div
        className={[
          'relative overflow-hidden rounded-2xl ring-1 ring-white/15',
          'shadow-2xl shadow-pink-900/30',
          IG_GRADIENT,
          'p-6 sm:p-8',
        ].join(' ')}
      >
        {/* Subtle aurora overlay */}
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            background:
              'radial-gradient(ellipse at 0% 0%, rgba(255,255,255,0.18) 0%, transparent 55%),' +
              'radial-gradient(ellipse at 100% 100%, rgba(0,0,0,0.18) 0%, transparent 55%)',
          }}
          aria-hidden="true"
        />
        <div className="relative flex items-start gap-4">
          <div className="flex h-12 w-12 sm:h-14 sm:w-14 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/30 shrink-0">
            <Hammer className="h-6 w-6 sm:h-7 sm:w-7 text-white" />
          </div>
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white ring-1 ring-white/30">
              <Sparkles className="h-3 w-3" />
              Work in progress
            </div>
            <h1 className="mt-2 text-xl sm:text-2xl font-bold text-white tracking-tight">
              {title}
            </h1>
            <p className="mt-2 max-w-2xl text-sm sm:text-base text-white/90 leading-relaxed">
              {description ||
                `${title} is part of the next Instagram release. The chrome is in place but the underlying provider work is still being hardened. ` +
                `Until it ships, we're keeping it in the sidebar so the layout stays consistent across both panels — but the action buttons are intentionally inert.`}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                to="/instagram/dashboard"
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-2 text-sm font-semibold text-white ring-1 ring-white/30 hover:bg-white/25 transition"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Dashboard
              </Link>
              <Link
                to="/instagram/sessions"
                className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-[#dc2743] hover:bg-pink-50 transition"
              >
                Manage accounts
                <ChevronRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* What's actually live */}
      <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-4 sm:p-6 ring-1 ring-white/10">
        <div className="flex items-center gap-2 mb-3">
          <Compass className="h-4 w-4 text-pink-300" />
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-pink-100/80">
            What's live in IG Studio
          </h2>
        </div>
        <p className="text-sm text-pink-100/85 mb-4 max-w-3xl">
          The five sections below are fully wired to the Instagram provider with
          the Phase 1 / 2 / 3 anti-ban pipeline (proxy enforcement, session
          fingerprint pinning, active-hours gating, warm-up ladder, detection
          telemetry, risk-score gating). Use these for real workflows today.
        </p>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {WORKING_FEATURES.map((f) => (
            <li key={f.path}>
              <Link
                to={f.path}
                className="group flex h-full flex-col gap-1.5 rounded-xl border border-white/10 bg-[#1a0a1f]/60 px-4 py-3 text-pink-50 hover:bg-[#1a0a1f]/85 hover:border-pink-300/50 transition"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-pink-100">
                    {f.label}
                  </span>
                  <ChevronRight className="h-4 w-4 text-pink-300/60 group-hover:text-pink-100 transition" />
                </div>
                <p className="text-xs text-pink-200/70 leading-relaxed">
                  {f.desc}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-xs text-pink-200/60 px-1">
        Tip: this page is shown for any sidebar option that hasn't graduated
        from the Telegram panel yet. Filing a feature request in the admin
        panel helps prioritize what we ship next for IG.
      </p>
    </div>
  );
}
