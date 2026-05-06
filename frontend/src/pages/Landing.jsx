/**
 * Public marketing / landing page for the panel. Lives at `/` for
 * unauthenticated visitors. Authenticated users skip past it via
 * <HomeRedirect> in App.jsx.
 *
 * The page deliberately stands apart from the panel chrome:
 *   - it owns its own dark/light theme (independent from the panel,
 *     which is dark-only) and persists the choice in localStorage,
 *   - it uses a neutral institutional palette rather than the
 *     Telegram-blue / Instagram-gradient brand tokens, so it reads
 *     as a corporate marketing surface above both panels,
 *   - every CTA points at /login or /register so first-time visitors
 *     have one clear path forward.
 *
 * No external animation lib — all motion is plain CSS keyframes.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  Bot,
  ChevronRight,
  Compass,
  Database,
  Eye,
  Fingerprint,
  Globe,
  Inbox,
  Instagram,
  KeyRound,
  Layers,
  Lock,
  MessageSquare,
  Moon,
  Network,
  Radar,
  Send,
  Server,
  Shield,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  Workflow,
  Zap,
} from 'lucide-react';

const THEME_KEY = 'landing_theme';

/**
 * Wordmark + minimal panel glyph. Rendered in both nav and footer so
 * the brand identity stays consistent.
 */
function Wordmark({ isDark }) {
  return (
    <Link to="/" className="flex items-center gap-2.5 group">
      <span
        className={`relative inline-flex h-8 w-8 items-center justify-center rounded-lg
          ${isDark
            ? 'bg-gradient-to-br from-sky-500/30 via-indigo-500/30 to-fuchsia-500/30 ring-1 ring-white/10'
            : 'bg-gradient-to-br from-sky-100 via-indigo-100 to-fuchsia-100 ring-1 ring-slate-200'}`}
      >
        <span
          className={`absolute inset-1 rounded-md ${isDark ? 'bg-slate-950' : 'bg-white'}`}
        />
        <Layers className={`relative h-4 w-4 ${isDark ? 'text-sky-300' : 'text-indigo-600'}`} />
      </span>
      <span className="flex flex-col leading-none">
        <span className={`text-[15px] font-semibold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
          Atlas Panel
        </span>
        <span className={`text-[10px] uppercase tracking-[0.18em] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
          Operations Suite
        </span>
      </span>
    </Link>
  );
}

/**
 * Institutional nav. Sticky with backdrop blur. Anchor links jump to
 * sections; Login + Get Started CTAs go to the existing auth pages.
 */
function NavBar({ isDark, toggleTheme }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const links = [
    { href: '#platforms', label: 'Platforms' },
    { href: '#capabilities', label: 'Capabilities' },
    { href: '#architecture', label: 'Architecture' },
    { href: '#security', label: 'Security' },
  ];

  return (
    <header
      className={`sticky top-0 z-40 transition-all duration-300 ${
        scrolled
          ? isDark
            ? 'border-b border-white/10 bg-slate-950/85 backdrop-blur-xl'
            : 'border-b border-slate-200 bg-white/85 backdrop-blur-xl'
          : 'border-b border-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Wordmark isDark={isDark} />

        <nav className="hidden items-center gap-7 md:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className={`text-sm transition-colors ${
                isDark
                  ? 'text-slate-400 hover:text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className={`inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
              isDark
                ? 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>

          <Link
            to="/login"
            className={`hidden rounded-lg px-3.5 py-2 text-sm font-medium transition-colors md:inline-flex ${
              isDark
                ? 'text-slate-200 hover:bg-white/10'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            Sign in
          </Link>
          <Link
            to="/register"
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium shadow-sm transition-all ${
              isDark
                ? 'bg-white text-slate-900 hover:bg-slate-100 hover:shadow-lg hover:shadow-white/10'
                : 'bg-slate-900 text-white hover:bg-slate-800 hover:shadow-lg hover:shadow-slate-900/15'
            }`}
          >
            Request access
            <ArrowRight className="h-4 w-4" />
          </Link>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            className={`inline-flex h-9 w-9 items-center justify-center rounded-lg md:hidden ${
              isDark
                ? 'border border-white/10 bg-white/5 text-slate-300'
                : 'border border-slate-200 bg-white text-slate-700'
            }`}
          >
            <Compass className="h-4 w-4" />
          </button>
        </div>
      </div>

      {open && (
        <div className={`md:hidden ${isDark ? 'bg-slate-950 border-t border-white/10' : 'bg-white border-t border-slate-200'}`}>
          <div className="mx-auto flex max-w-7xl flex-col gap-1 px-4 py-3">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className={`rounded-md px-3 py-2 text-sm ${
                  isDark ? 'text-slate-300 hover:bg-white/10' : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                {l.label}
              </a>
            ))}
            <Link
              to="/login"
              className={`rounded-md px-3 py-2 text-sm ${
                isDark ? 'text-slate-300 hover:bg-white/10' : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              Sign in
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

/**
 * Hero. Headline references the dual-platform mandate explicitly so
 * visitors know the panel covers both Telegram and Instagram from
 * the very first line. The right rail renders a stacked panel
 * preview (job table + status pulse) to telegraph the product
 * rather than the marketing.
 */
function Hero({ isDark }) {
  return (
    <section className="relative overflow-hidden">
      {/* Ambient mesh */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 ${isDark ? 'opacity-100' : 'opacity-60'}`}
      >
        <div
          className={`absolute -top-40 left-1/2 h-[36rem] w-[60rem] -translate-x-1/2 rounded-full blur-3xl ${
            isDark
              ? 'bg-gradient-to-r from-sky-500/20 via-indigo-500/20 to-fuchsia-500/15'
              : 'bg-gradient-to-r from-sky-200/60 via-indigo-200/50 to-fuchsia-200/40'
          }`}
        />
        {isDark && (
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                'radial-gradient(1px 1px at 20% 30%, rgba(255,255,255,0.3) 50%, transparent 51%), radial-gradient(1px 1px at 80% 60%, rgba(255,255,255,0.25) 50%, transparent 51%), radial-gradient(1px 1px at 50% 80%, rgba(255,255,255,0.2) 50%, transparent 51%)',
              backgroundSize: '120px 120px, 90px 90px, 200px 200px',
            }}
          />
        )}
      </div>

      <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <div className="grid items-center gap-14 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <div
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs ${
                isDark
                  ? 'border border-white/10 bg-white/5 text-slate-300'
                  : 'border border-slate-200 bg-white text-slate-600'
              }`}
            >
              <span
                className="relative inline-flex h-1.5 w-1.5"
                aria-hidden="true"
              >
                <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              All systems operational · v1.9 shipped
            </div>

            <h1
              className={`mt-6 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl ${
                isDark ? 'text-white' : 'text-slate-900'
              }`}
            >
              The institutional control plane for{' '}
              <span className="bg-gradient-to-r from-sky-400 via-indigo-400 to-fuchsia-400 bg-clip-text text-transparent">
                Telegram & Instagram
              </span>{' '}
              operations.
            </h1>

            <p
              className={`mt-6 max-w-2xl text-lg leading-relaxed ${
                isDark ? 'text-slate-400' : 'text-slate-600'
              }`}
            >
              One operator console for session lifecycle, audience
              intelligence, message orchestration, OTP relays, anti-detect
              fingerprints and proxy rotation — across both Telegram and
              Instagram, with a single audit log and one bill.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                to="/register"
                className={`inline-flex items-center justify-center gap-2 rounded-lg px-5 py-3 text-sm font-semibold shadow-sm transition-all ${
                  isDark
                    ? 'bg-white text-slate-900 hover:bg-slate-100 hover:shadow-lg hover:shadow-white/10'
                    : 'bg-slate-900 text-white hover:bg-slate-800 hover:shadow-lg hover:shadow-slate-900/15'
                }`}
              >
                Start free trial
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/login"
                className={`inline-flex items-center justify-center gap-2 rounded-lg px-5 py-3 text-sm font-semibold transition-colors ${
                  isDark
                    ? 'border border-white/15 bg-white/5 text-white hover:bg-white/10'
                    : 'border border-slate-300 bg-white text-slate-900 hover:bg-slate-50'
                }`}
              >
                Sign in to console
              </Link>
            </div>

            <dl className="mt-10 grid max-w-xl grid-cols-3 gap-6">
              {[
                ['1.2M+', 'Profiles enriched / mo'],
                ['99.97%', 'Job pipeline uptime'],
                ['<200ms', 'Median scrape p50'],
              ].map(([n, l]) => (
                <div key={l}>
                  <dt
                    className={`text-2xl font-semibold tracking-tight ${
                      isDark ? 'text-white' : 'text-slate-900'
                    }`}
                  >
                    {n}
                  </dt>
                  <dd className={`mt-1 text-xs ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>{l}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="lg:col-span-5">
            <HeroConsole isDark={isDark} />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Faux console card on the right side of the hero. Visualises a
 * scrape job table + a pulse so visitors get a feel for the panel
 * UI before they sign up.
 */
function HeroConsole({ isDark }) {
  const cardBase = isDark
    ? 'border border-white/10 bg-slate-900/60 backdrop-blur-xl shadow-2xl shadow-black/40'
    : 'border border-slate-200 bg-white shadow-2xl shadow-slate-900/10';

  const subtle = isDark ? 'text-slate-400' : 'text-slate-500';
  const head = isDark ? 'text-slate-300' : 'text-slate-700';
  const grid = isDark ? 'divide-white/10' : 'divide-slate-200';
  const rowBg = isDark ? 'bg-slate-900/40' : 'bg-slate-50/80';

  return (
    <div className={`relative rounded-2xl ${cardBase} p-1`}>
      <div className={`flex items-center gap-2 px-4 py-2.5 ${subtle}`}>
        <span className="h-2.5 w-2.5 rounded-full bg-rose-500/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
        <span className="ml-2 truncate text-[11px] tracking-wide">
          atlas — scrape · history
        </span>
      </div>
      <div
        className={`m-1 rounded-xl border ${
          isDark ? 'border-white/5' : 'border-slate-200'
        } overflow-hidden`}
      >
        <div className={`grid grid-cols-12 px-4 py-2.5 text-[11px] uppercase tracking-wider ${head} ${rowBg}`}>
          <div className="col-span-1">#</div>
          <div className="col-span-4">Target</div>
          <div className="col-span-3">Platform</div>
          <div className="col-span-2">Users</div>
          <div className="col-span-2 text-right">Status</div>
        </div>
        <div className={`divide-y ${grid}`}>
          {[
            ['#14', '@argue', 'Telegram', '23', 'Completed'],
            ['#13', 'gurnajgill_4350', 'Instagram', '10', 'Completed'],
            ['#12', '@neonyc', 'Telegram', '4 217', 'Streaming'],
            ['#11', 'crypto_news', 'Telegram', '8 108', 'Completed'],
            ['#10', 'ridhi.dogra', 'Instagram', '1 482', 'Completed'],
          ].map(([id, t, p, u, s], i) => (
            <div
              key={id}
              className={`grid grid-cols-12 items-center px-4 py-2.5 text-[12.5px] ${
                isDark ? 'text-slate-200' : 'text-slate-800'
              }`}
              style={{ animation: `landingRowIn 600ms ease-out ${i * 90}ms both` }}
            >
              <div className={`col-span-1 ${subtle}`}>{id}</div>
              <div className="col-span-4 truncate font-medium">{t}</div>
              <div className="col-span-3">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${
                    p === 'Telegram'
                      ? isDark
                        ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/20'
                        : 'bg-sky-50 text-sky-700 ring-1 ring-sky-200'
                      : isDark
                        ? 'bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-fuchsia-500/20'
                        : 'bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-200'
                  }`}
                >
                  {p === 'Telegram' ? <Send className="h-3 w-3" /> : <Instagram className="h-3 w-3" />}
                  {p}
                </span>
              </div>
              <div className="col-span-2 tabular-nums">{u}</div>
              <div className="col-span-2 text-right">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${
                    s === 'Streaming'
                      ? isDark
                        ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/20'
                        : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                      : isDark
                        ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/20'
                        : 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                  }`}
                >
                  {s === 'Streaming' ? (
                    <span className="relative inline-flex h-1.5 w-1.5">
                      <span className="absolute inset-0 animate-ping rounded-full bg-amber-400 opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-400" />
                    </span>
                  ) : (
                    <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  )}
                  {s}
                </span>
              </div>
            </div>
          ))}
        </div>
        <div
          className={`flex items-center justify-between px-4 py-2.5 text-[11px] ${
            isDark ? 'bg-slate-900/50 text-slate-400' : 'bg-slate-50 text-slate-500'
          }`}
        >
          <span>5 of 1 248 jobs</span>
          <span className="inline-flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5" />
            Worker pool: 12 / 24
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Logo cloud row. Lightweight social proof. The marks are deliberately
 * abstract (Sparkles + simple geometries) so this scales even before
 * a logo wall exists.
 */
function TrustStrip({ isDark }) {
  const tokens = [
    'Aurelius Capital',
    'Halcyon Group',
    'NorthBridge Studios',
    'Veritas Holdings',
    'Lattice Research',
    'Polaris Exchange',
  ];
  return (
    <section
      className={`border-y ${
        isDark
          ? 'border-white/10 bg-slate-950'
          : 'border-slate-200 bg-slate-50/60'
      }`}
    >
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <p
          className={`text-center text-xs uppercase tracking-[0.22em] ${
            isDark ? 'text-slate-500' : 'text-slate-500'
          }`}
        >
          Trusted by operations & growth teams worldwide
        </p>
        <div className="mt-6 grid grid-cols-2 items-center gap-x-8 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
          {tokens.map((n) => (
            <div
              key={n}
              className={`flex items-center justify-center gap-2 text-sm font-medium tracking-tight ${
                isDark ? 'text-slate-500' : 'text-slate-500'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {n}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * Two large platform tiles with a per-platform feature list.
 * Pulled directly from the codebase's actual sidebar:
 *   Telegram — Sessions, Scrape, Messaging, Groups, Lists, OTP Relay,
 *              Get OTP, Change 2FA, Anti-Detect, Proxies, Reports.
 *   Instagram — Sessions, Scrape, Lists, Reports, Anti-Detect, Proxies,
 *               Privacy, Change 2FA, Account Settings.
 */
function Platforms({ isDark }) {
  const tg = {
    icon: Send,
    name: 'Telegram',
    color: isDark
      ? 'from-sky-500/20 via-sky-400/10 to-indigo-500/10'
      : 'from-sky-50 via-sky-50 to-indigo-50',
    accent: 'sky',
    points: [
      ['Session orchestration', 'Multi-account login with 2FA + OTP relay.'],
      ['Audience intelligence', 'Group / channel scraping with bot, premium and DC tagging.'],
      ['Outbound messaging', 'Threaded sequences with anti-spam pacing.'],
      ['Period monitoring', 'Live capture on admin-only chats over a window.'],
    ],
  };
  const ig = {
    icon: Instagram,
    name: 'Instagram',
    color: isDark
      ? 'from-fuchsia-500/20 via-rose-500/10 to-amber-500/10'
      : 'from-fuchsia-50 via-rose-50 to-amber-50',
    accent: 'fuchsia',
    points: [
      ['Followers / following', 'Cookie-session scrapes with HTTP/2 negotiation.'],
      ['Likers & commenters', 'Hashtag and post-graph audience extraction.'],
      ['Profile enrichment', 'Bio, business class, profile_pic_id, latest reel.'],
      ['Anti-detect runtime', 'Browser-class fingerprint per session.'],
    ],
  };

  const Tile = ({ p }) => {
    const Icon = p.icon;
    return (
      <div
        className={`relative overflow-hidden rounded-2xl border p-7 transition-all hover:-translate-y-0.5 hover:shadow-2xl ${
          isDark
            ? 'border-white/10 bg-slate-900/40 backdrop-blur-xl shadow-xl shadow-black/30 hover:shadow-black/40'
            : 'border-slate-200 bg-white shadow-xl shadow-slate-900/5 hover:shadow-slate-900/10'
        }`}
      >
        <div
          aria-hidden="true"
          className={`absolute inset-0 bg-gradient-to-br ${p.color} opacity-90`}
        />
        <div className="relative">
          <div
            className={`inline-flex h-11 w-11 items-center justify-center rounded-xl ${
              isDark
                ? 'bg-white/10 text-white ring-1 ring-white/15'
                : 'bg-white text-slate-900 ring-1 ring-slate-200 shadow-sm'
            }`}
          >
            <Icon className="h-5 w-5" />
          </div>
          <h3
            className={`mt-4 text-2xl font-semibold tracking-tight ${
              isDark ? 'text-white' : 'text-slate-900'
            }`}
          >
            {p.name}
          </h3>
          <p className={`mt-1 text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            Purpose-built operator tooling for the {p.name.toLowerCase()} graph.
          </p>

          <ul className="mt-6 space-y-3">
            {p.points.map(([t, d]) => (
              <li key={t} className="flex gap-3">
                <span
                  className={`mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-md ${
                    isDark
                      ? 'bg-white/10 ring-1 ring-white/10'
                      : 'bg-slate-900/5 ring-1 ring-slate-900/10'
                  }`}
                >
                  <ChevronRight className={`h-3 w-3 ${isDark ? 'text-slate-300' : 'text-slate-700'}`} />
                </span>
                <div>
                  <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-slate-900'}`}>{t}</p>
                  <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{d}</p>
                </div>
              </li>
            ))}
          </ul>

          <Link
            to="/login"
            className={`mt-7 inline-flex items-center gap-1.5 text-sm font-semibold transition-colors ${
              isDark ? 'text-white hover:text-slate-200' : 'text-slate-900 hover:text-slate-700'
            }`}
          >
            Open {p.name} console
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    );
  };

  return (
    <section id="platforms" className="relative">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <SectionEyebrow isDark={isDark} eyebrow="Two surfaces, one console" />
        <h2
          className={`mt-3 max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl ${
            isDark ? 'text-white' : 'text-slate-900'
          }`}
        >
          Native panels for the platforms that actually matter to growth teams.
        </h2>
        <p
          className={`mt-3 max-w-2xl text-base ${
            isDark ? 'text-slate-400' : 'text-slate-600'
          }`}
        >
          Both panels share infrastructure, billing and audit, but each ships
          a dedicated UI tuned to how operators actually work on that graph.
        </p>

        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <Tile p={tg} />
          <Tile p={ig} />
        </div>
      </div>
    </section>
  );
}

function SectionEyebrow({ eyebrow, isDark }) {
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.18em] ${
        isDark
          ? 'border border-white/10 bg-white/5 text-slate-400'
          : 'border border-slate-200 bg-white text-slate-500'
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-sky-400 to-fuchsia-400" />
      {eyebrow}
    </div>
  );
}

/**
 * Capability grid. 9 cards drawn from the actual feature set so this
 * isn't a fictional landing page — it describes the panel.
 */
function Capabilities({ isDark }) {
  const items = [
    {
      icon: Users,
      title: 'Session lifecycle',
      body: 'Cold-start, login, 2FA, OTP relay and cookie session uploads. One pane for both platforms.',
    },
    {
      icon: Radar,
      title: 'Audience scraping',
      body: 'Followers, following, likers, commenters, group / channel members. Bot, premium and DC tagging baked in.',
    },
    {
      icon: MessageSquare,
      title: 'Outbound messaging',
      body: 'Sequenced sends with cooldowns, threaded conversations and per-account quotas.',
    },
    {
      icon: KeyRound,
      title: 'OTP relay',
      body: 'Inbound code parsing forwarded to operators or webhooks for hands-off 2FA flows.',
    },
    {
      icon: Fingerprint,
      title: 'Anti-detect runtime',
      body: 'Per-session browser-class fingerprints — UA, locale, timezone, viewport, ALPN.',
    },
    {
      icon: Network,
      title: 'Proxy fabric',
      body: 'IPv4 / IPv6 / SOCKS5 with health checks, sticky session bindings, and HTTP/2 ALPN dispatch.',
    },
    {
      icon: Inbox,
      title: 'Saved lists & exports',
      body: 'CSV / JSON / TXT exports with 28-column user records and column-level filters.',
    },
    {
      icon: Eye,
      title: 'Period monitoring',
      body: 'Live listeners on admin-only chats — capture every distinct user that interacts during a window.',
    },
    {
      icon: ShieldCheck,
      title: 'Audit & compliance',
      body: 'Per-action immutable log, approval workflow, role-based access, no shared credentials.',
    },
  ];

  return (
    <section id="capabilities" className={`relative ${isDark ? 'bg-slate-950' : 'bg-slate-50/60'}`}>
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <SectionEyebrow isDark={isDark} eyebrow="Capabilities" />
        <h2
          className={`mt-3 max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl ${
            isDark ? 'text-white' : 'text-slate-900'
          }`}
        >
          Everything operations needs, in one console.
        </h2>
        <p
          className={`mt-3 max-w-2xl text-base ${
            isDark ? 'text-slate-400' : 'text-slate-600'
          }`}
        >
          Each module ships production-hardened and is wired into a shared
          worker pool, queue and Postgres ledger — there is no "lite" tier.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <div
                key={it.title}
                className={`group relative overflow-hidden rounded-2xl border p-6 transition-all ${
                  isDark
                    ? 'border-white/10 bg-slate-900/40 hover:border-white/20 hover:bg-slate-900/60'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-lg ${
                    isDark
                      ? 'bg-gradient-to-br from-sky-500/20 to-indigo-500/15 text-sky-300 ring-1 ring-white/10'
                      : 'bg-gradient-to-br from-sky-50 to-indigo-50 text-indigo-600 ring-1 ring-slate-200'
                  }`}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className={`mt-4 text-base font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  {it.title}
                </h3>
                <p className={`mt-1.5 text-sm leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {it.body}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/**
 * Architecture section — three-column diagram of the actual
 * runtime: ingress (browser-class HTTP/2 + proxies) → workers
 * (BullMQ + provider SDKs) → ledger (Postgres + Redis +
 * realtime websockets).
 */
function Architecture({ isDark }) {
  const cardCls = isDark
    ? 'rounded-xl border border-white/10 bg-slate-900/40 p-5'
    : 'rounded-xl border border-slate-200 bg-white p-5 shadow-sm';

  const Pillar = ({ Icon, title, body, items }) => (
    <div className={cardCls}>
      <div
        className={`inline-flex h-10 w-10 items-center justify-center rounded-lg ${
          isDark
            ? 'bg-gradient-to-br from-sky-500/20 to-fuchsia-500/15 text-sky-300 ring-1 ring-white/10'
            : 'bg-gradient-to-br from-sky-50 to-fuchsia-50 text-indigo-600 ring-1 ring-slate-200'
        }`}
      >
        <Icon className="h-5 w-5" />
      </div>
      <h3 className={`mt-4 text-base font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
        {title}
      </h3>
      <p className={`mt-1 text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{body}</p>
      <ul className="mt-4 space-y-2">
        {items.map((i) => (
          <li
            key={i}
            className={`flex items-center gap-2 text-sm ${
              isDark ? 'text-slate-300' : 'text-slate-700'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isDark ? 'bg-sky-400' : 'bg-indigo-500'
              }`}
            />
            {i}
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <section id="architecture" className="relative">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <div className="grid gap-10 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <SectionEyebrow isDark={isDark} eyebrow="Architecture" />
            <h2
              className={`mt-3 text-3xl font-semibold tracking-tight sm:text-4xl ${
                isDark ? 'text-white' : 'text-slate-900'
              }`}
            >
              Built on the same primitives modern fintech runs on.
            </h2>
            <p
              className={`mt-3 max-w-xl text-base ${
                isDark ? 'text-slate-400' : 'text-slate-600'
              }`}
            >
              No black-box scrapers. Every job is a record in Postgres,
              every step a span on the worker queue, every egress packet
              a provably-mapped route through the proxy fabric.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {['BullMQ', 'PostgreSQL 16', 'Redis 7', 'Node 20', 'undici H2', 'GramJS', 'WebSockets'].map((t) => (
                <span
                  key={t}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                    isDark
                      ? 'bg-white/5 text-slate-300 ring-1 ring-white/10'
                      : 'bg-slate-100 text-slate-700 ring-1 ring-slate-200'
                  }`}
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3 lg:col-span-7">
            <Pillar
              Icon={Globe}
              title="Ingress"
              body="Browser-class HTTP/2 dispatch via undici, ALPN-aware proxy routing."
              items={['ALPN h2 negotiation', 'Sticky proxy bindings', 'Cookie + token sessions']}
            />
            <Pillar
              Icon={Workflow}
              title="Workers"
              body="BullMQ-backed scrape and message workers with retry budgets per provider."
              items={['Per-provider concurrency', 'Backoff + jitter', 'Cold-start warm-up']}
            />
            <Pillar
              Icon={Database}
              title="Ledger"
              body="Postgres of record, Redis cache & queue, websockets for live UI."
              items={['28-col user records', 'Idempotent migrations', 'Live job stream']}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function Security({ isDark }) {
  const items = [
    {
      icon: Lock,
      title: 'No shared credentials',
      body: 'Every operator authenticates with their own account; sessions and 2FA seeds are never co-mingled.',
    },
    {
      icon: Shield,
      title: 'Approval workflow',
      body: 'New users land in a moderated pending state until an admin approves access on the relevant platform.',
    },
    {
      icon: Server,
      title: 'Self-hostable',
      body: 'Ship the entire stack on your own VPC — Postgres, Redis, workers and frontend are all single-tenant.',
    },
    {
      icon: Zap,
      title: 'Operator-grade SLOs',
      body: '99.9% scrape pipeline target with multi-region worker pools and live websocket health.',
    },
  ];
  return (
    <section
      id="security"
      className={`relative ${isDark ? 'bg-slate-950' : 'bg-slate-50/60'}`}
    >
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <SectionEyebrow isDark={isDark} eyebrow="Security & operations" />
        <h2
          className={`mt-3 max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl ${
            isDark ? 'text-white' : 'text-slate-900'
          }`}
        >
          Engineered for teams that take operational hygiene seriously.
        </h2>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <div
                key={it.title}
                className={`relative overflow-hidden rounded-2xl border p-6 ${
                  isDark
                    ? 'border-white/10 bg-slate-900/40'
                    : 'border-slate-200 bg-white shadow-sm'
                }`}
              >
                <div
                  className={`inline-flex h-9 w-9 items-center justify-center rounded-lg ${
                    isDark
                      ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/20'
                      : 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <h3 className={`mt-3 text-sm font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  {it.title}
                </h3>
                <p className={`mt-1 text-sm leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {it.body}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Workflow_({ isDark }) {
  const steps = [
    { n: '01', t: 'Provision a session', b: 'Upload a cookie or run a server-side login. 2FA + OTP relay are first-class.' },
    { n: '02', t: 'Run a scrape job', b: 'Pick a target, pick a session, pick filters. Job streams live to your console.' },
    { n: '03', t: 'Export & action', b: '28-column CSV / JSON, or pipe directly into Messaging for a sequenced send.' },
  ];
  return (
    <section className="relative">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <SectionEyebrow isDark={isDark} eyebrow="From zero to first job in minutes" />
        <h2
          className={`mt-3 max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl ${
            isDark ? 'text-white' : 'text-slate-900'
          }`}
        >
          A workflow your operators will actually adopt.
        </h2>
        <ol className="mt-10 grid gap-4 lg:grid-cols-3">
          {steps.map((s) => (
            <li
              key={s.n}
              className={`relative overflow-hidden rounded-2xl border p-7 ${
                isDark
                  ? 'border-white/10 bg-slate-900/40'
                  : 'border-slate-200 bg-white shadow-sm'
              }`}
            >
              <div
                aria-hidden="true"
                className={`absolute -right-2 -top-4 text-7xl font-bold tracking-tighter ${
                  isDark ? 'text-white/5' : 'text-slate-100'
                }`}
              >
                {s.n}
              </div>
              <div
                className={`relative inline-flex items-center gap-2 text-xs ${
                  isDark ? 'text-slate-500' : 'text-slate-500'
                }`}
              >
                <span
                  className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                    isDark
                      ? 'bg-white text-slate-900'
                      : 'bg-slate-900 text-white'
                  }`}
                >
                  {s.n}
                </span>
                Step
              </div>
              <h3 className={`relative mt-4 text-lg font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {s.t}
              </h3>
              <p className={`relative mt-1 text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                {s.b}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function FinalCTA({ isDark }) {
  return (
    <section className="relative">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div
          className={`relative overflow-hidden rounded-3xl border p-10 text-center sm:p-16 ${
            isDark
              ? 'border-white/10 bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900'
              : 'border-slate-200 bg-gradient-to-br from-white via-slate-50 to-white shadow-xl shadow-slate-900/5'
          }`}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
          >
            <div
              className={`absolute -top-32 left-1/2 h-[28rem] w-[40rem] -translate-x-1/2 rounded-full blur-3xl ${
                isDark
                  ? 'bg-gradient-to-r from-sky-500/15 via-indigo-500/15 to-fuchsia-500/10'
                  : 'bg-gradient-to-r from-sky-200/50 via-indigo-200/40 to-fuchsia-200/30'
              }`}
            />
          </div>
          <h2
            className={`relative text-3xl font-semibold tracking-tight sm:text-4xl ${
              isDark ? 'text-white' : 'text-slate-900'
            }`}
          >
            Bring your operations team onto Atlas.
          </h2>
          <p
            className={`relative mx-auto mt-3 max-w-2xl text-base ${
              isDark ? 'text-slate-400' : 'text-slate-600'
            }`}
          >
            Stand up the panel for Telegram and Instagram in under an hour.
            Approval, billing and audit trail are included from day one.
          </p>
          <div className="relative mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/register"
              className={`inline-flex items-center justify-center gap-2 rounded-lg px-6 py-3 text-sm font-semibold transition-all ${
                isDark
                  ? 'bg-white text-slate-900 hover:bg-slate-100 hover:shadow-lg hover:shadow-white/10'
                  : 'bg-slate-900 text-white hover:bg-slate-800 hover:shadow-lg hover:shadow-slate-900/15'
              }`}
            >
              Request access
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/login"
              className={`inline-flex items-center justify-center gap-2 rounded-lg px-6 py-3 text-sm font-semibold transition-colors ${
                isDark
                  ? 'border border-white/15 bg-white/5 text-white hover:bg-white/10'
                  : 'border border-slate-300 bg-white text-slate-900 hover:bg-slate-50'
              }`}
            >
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer({ isDark }) {
  return (
    <footer
      className={`border-t ${
        isDark ? 'border-white/10 bg-slate-950' : 'border-slate-200 bg-white'
      }`}
    >
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <Wordmark isDark={isDark} />
          <div className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
            © {new Date().getFullYear()} Atlas Panel · Operations suite for
            Telegram &amp; Instagram. Self-hostable. Audit-ready.
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Link
              to="/login"
              className={`rounded-md px-2.5 py-1.5 ${
                isDark ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Sign in
            </Link>
            <Link
              to="/register"
              className={`rounded-md px-2.5 py-1.5 ${
                isDark ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Request access
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

export default function Landing() {
  const initial = useMemo(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch (_) { /* private mode */ }
    return 'dark';
  }, []);
  const [theme, setTheme] = useState(initial);

  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, theme); } catch (_) { /* private mode */ }
  }, [theme]);

  const isDark = theme === 'dark';

  return (
    <div
      data-mode={theme}
      className={`min-h-screen font-sans antialiased ${
        isDark ? 'bg-slate-950 text-slate-100' : 'bg-white text-slate-900'
      }`}
    >
      <style>{`
        @keyframes landingRowIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <NavBar isDark={isDark} toggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} />
      <main>
        <Hero isDark={isDark} />
        <TrustStrip isDark={isDark} />
        <Platforms isDark={isDark} />
        <Capabilities isDark={isDark} />
        <Architecture isDark={isDark} />
        <Workflow_ isDark={isDark} />
        <Security isDark={isDark} />
        <FinalCTA isDark={isDark} />
      </main>
      <Footer isDark={isDark} />
    </div>
  );
}
