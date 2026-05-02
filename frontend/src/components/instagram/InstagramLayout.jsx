/**
 * InstagramLayout — institutional-grade chrome for /instagram/* routes.
 *
 * Designed from scratch to share zero visual DNA with the Telegram
 * panel:
 *   - "IG Studio" obsidian base with pink/orange aurora gradients,
 *   - dark glass sidebar with section headers and gradient pill for
 *     the active link,
 *   - frosted top bar (brand chip, command-bar style search, platform
 *     switcher, notifications, user pill),
 *   - dedicated mobile bottom dock + slide-in drawer with safe-area
 *     padding so phones never overflow horizontally,
 *   - admin link and IG Admin entry point that are visually distinct
 *     from the user routes.
 *
 * Telegram-only features (Direct messages, Groups, Threads, Get OTP)
 * are deliberately absent from the IG sidebar — they remain in the
 * Telegram panel where they actually work.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  UserPlus,
  Search,
  List as ListIcon,
  BarChart3,
  Network,
  Fingerprint,
  UserCog,
  Shield,
  ShieldCheck,
  CreditCard,
  Settings as SettingsIcon,
  LogOut,
  Menu,
  X,
  Bell,
  ChevronLeft,
  ChevronRight,
  Crown,
  Send,
  Camera,
  Sparkles,
  Upload,
  Command,
  Activity,
  Compass,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { usePlatform, useCapabilities } from '../../context/PlatformContext';

/* -------------------------------------------------------------------------- */
/* Navigation model                                                           */
/* -------------------------------------------------------------------------- */

// Each entry is shown only when the active platform exposes the
// `capability` (or the entry is platform-agnostic, capability=null).
// `dock` flags the entries surfaced in the mobile bottom dock.
const IG_NAV = [
  { path: 'dashboard',         label: 'Dashboard',     icon: LayoutDashboard, capability: null,                section: 'main',   dock: true },
  { path: 'sessions',          label: 'Accounts',      icon: Users,           capability: 'sessions_list',     section: 'main',   dock: true },
  { path: 'create-session',    label: 'Add account',   icon: UserPlus,        capability: 'sessions_create',   section: 'main' },
  { path: 'upload-session',    label: 'Upload session',icon: Upload,          capability: 'sessions_create',   section: 'main' },
  { path: 'scrape',            label: 'Scraping',      icon: Search,          capability: 'scrape_any',        section: 'main',   dock: true },
  { path: 'lists',             label: 'Saved lists',   icon: ListIcon,        capability: 'lists',             section: 'engage' },
  { path: 'reports',           label: 'Reports',       icon: BarChart3,       capability: 'reports',           section: 'engage', dock: true },
  { path: 'proxies',           label: 'Proxies',       icon: Network,         capability: 'proxies',           section: 'safety' },
  { path: 'anti-detect',       label: 'Identity',      icon: Fingerprint,     capability: 'identity_device',   section: 'safety' },
  { path: 'privacy',           label: 'Privacy',       icon: Shield,          capability: 'privacy_set',       section: 'safety' },
  { path: 'change-2fa',        label: '2FA',           icon: ShieldCheck,     capability: 'twofa_change',      section: 'safety' },
  { path: 'account-settings',  label: 'Account',       icon: UserCog,         capability: 'account_settings',  section: 'system' },
  { path: 'billing',           label: 'Billing',       icon: CreditCard,      capability: null,                section: 'system' },
  { path: 'settings',          label: 'Settings',      icon: SettingsIcon,    capability: null,                section: 'system', dock: true },
];

const SECTION_LABELS = {
  main:   { label: 'Workspace', icon: Compass },
  engage: { label: 'Engage',    icon: Activity },
  safety: { label: 'Safety',    icon: Shield },
  system: { label: 'System',    icon: SettingsIcon },
};

/* -------------------------------------------------------------------------- */
/* Platform switcher pill                                                     */
/* -------------------------------------------------------------------------- */

function PlatformSwitch({ size = 'md' }) {
  const { platform, setPlatform, isEnabled } = usePlatform();
  const sizing = size === 'sm'
    ? { btn: 'px-2.5 py-1 text-[11px]', icon: 'h-3 w-3' }
    : { btn: 'px-3 py-1.5 text-xs',     icon: 'h-3.5 w-3.5' };
  return (
    <div
      role="tablist"
      aria-label="Active panel"
      className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1 backdrop-blur-md"
    >
      {[
        { p: 'telegram',  Icon: Send,   label: 'Telegram',  cls: 'from-[#229ED9] to-[#0088cc]' },
        { p: 'instagram', Icon: Camera, label: 'Instagram', cls: 'from-[#f09433] via-[#dc2743] to-[#bc1888]' },
      ].map(({ p, Icon, label, cls }) => {
        const enabled = isEnabled(p);
        const active = platform === p;
        return (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={!enabled}
            onClick={() => {
              if (active) return;
              try {
                window.dispatchEvent(new CustomEvent('panel:platform-switch', { detail: { target: p } }));
              } catch (_) { /* SSR */ }
              setPlatform(p);
            }}
            className={[
              'inline-flex items-center gap-1.5 rounded-full font-semibold transition-all duration-200',
              sizing.btn,
              active
                ? `bg-gradient-to-r ${cls} text-white shadow-md ring-1 ring-white/30`
                : enabled
                  ? 'text-pink-100/85 hover:bg-white/10'
                  : 'cursor-not-allowed text-pink-300/40',
            ].join(' ')}
          >
            <Icon className={sizing.icon} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sidebar item                                                               */
/* -------------------------------------------------------------------------- */

function NavItem({ to, label, icon: Icon, active, collapsed, gradient }) {
  return (
    <Link
      to={to}
      className={[
        'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
        active
          ? `text-white shadow-lg shadow-pink-900/40 ring-1 ring-white/20 ${gradient || 'bg-gradient-to-r from-[#f09433] via-[#dc2743] to-[#bc1888]'}`
          : 'text-pink-100/80 hover:text-white hover:bg-white/5 ring-1 ring-transparent hover:ring-white/10',
        collapsed ? 'md:justify-center md:px-2' : '',
      ].join(' ')}
    >
      <Icon
        className={[
          'h-5 w-5 shrink-0 transition-colors',
          active ? 'text-white' : 'text-pink-200/80 group-hover:text-pink-100',
        ].join(' ')}
      />
      <span className={['truncate', collapsed ? 'md:hidden' : ''].join(' ')}>
        {label}
      </span>
      {active && !collapsed && (
        <span className="ml-auto inline-block h-1.5 w-1.5 rounded-full bg-white/90 ring-2 ring-white/30" />
      )}
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/* Sidebar                                                                    */
/* -------------------------------------------------------------------------- */

function IGSidebar({ items, grouped, isAdmin, location, platform, collapsed, setCollapsed, onClose, user, logout, mobile }) {
  const initials = user?.email ? user.email.substring(0, 2).toUpperCase() : 'IG';
  return (
    <aside
      className={[
        'flex h-full flex-col text-pink-50 shadow-2xl',
        // Dark obsidian glass with a vertical pink/orange aurora.
        'relative bg-[#0b0410]/95 backdrop-blur-xl border-r border-white/10',
        collapsed ? 'md:w-20' : 'md:w-[17rem]',
        'w-[17.5rem]',
      ].join(' ')}
    >
      {/* Aurora gradients behind the sidebar */}
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            'radial-gradient(ellipse at 0% 0%, rgba(244,114,182,0.22) 0%, transparent 55%),' +
            'radial-gradient(ellipse at 100% 100%, rgba(245,158,11,0.18) 0%, transparent 55%)',
        }}
        aria-hidden="true"
      />

      {/* Header / logo */}
      <div className="relative flex items-center gap-3 px-4 h-16 border-b border-white/10">
        {!collapsed && (
          <>
            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] ring-1 ring-white/20 shrink-0 shadow-lg shadow-pink-900/40">
              <Camera className="h-5 w-5 text-white" />
              <span className="absolute -bottom-1 -right-1 inline-flex h-3 w-3 items-center justify-center rounded-full bg-emerald-400 ring-2 ring-[#0b0410]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold tracking-tight truncate">
                IG <span className="bg-gradient-to-r from-pink-300 via-rose-200 to-amber-200 bg-clip-text text-transparent">Studio</span>
              </div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-pink-200/70">
                Institutional · v9
              </div>
            </div>
          </>
        )}
        {mobile ? (
          <button
            onClick={onClose}
            className="md:hidden ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 transition"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={() => setCollapsed((c) => !c)}
            className={[
              'hidden md:inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 transition',
              collapsed ? 'mx-auto' : '',
            ].join(' ')}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="relative flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {isAdmin && (
          <NavItem
            to="/instagram/admin"
            label="Admin"
            icon={Crown}
            active={location.pathname.startsWith('/instagram/admin')}
            collapsed={collapsed}
            gradient="bg-gradient-to-r from-amber-500 via-rose-500 to-pink-600"
          />
        )}

        {Object.entries(grouped).map(([section, list]) => {
          if (!list.length) return null;
          const meta = SECTION_LABELS[section] || SECTION_LABELS.main;
          const SectionIcon = meta.icon;
          return (
            <div key={section}>
              {!collapsed && (
                <div className="flex items-center gap-2 px-3 mb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-pink-200/60">
                  <SectionIcon className="h-3 w-3 text-pink-300/70" />
                  {meta.label}
                </div>
              )}
              {collapsed && (
                <div className="md:flex hidden justify-center mb-2">
                  <span className="h-px w-6 bg-white/15" />
                </div>
              )}
              <div className="space-y-1">
                {list.map(({ path, label, icon: Icon }) => {
                  const fullPath = `/${platform}/${path}`;
                  const isActive = location.pathname === fullPath;
                  return (
                    <NavItem
                      key={fullPath}
                      to={fullPath}
                      label={label}
                      icon={Icon}
                      active={isActive}
                      collapsed={collapsed}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}

        {!isAdmin && !items.length && (
          <p className="mx-2 mt-4 rounded-xl bg-white/5 p-3 text-xs text-pink-100/85 ring-1 ring-white/10">
            Awaiting admin approval. Features unlock once your account is approved.
          </p>
        )}
      </nav>

      {/* User card */}
      <div className="relative border-t border-white/10 p-3">
        <div className={`flex items-center ${collapsed ? 'md:justify-center' : 'gap-3'}`}>
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] text-xs font-bold ring-2 ring-white/15">
            {initials}
          </div>
          <div className={`flex-1 min-w-0 ${collapsed ? 'md:hidden' : ''}`}>
            <p className="flex items-center gap-1.5 text-sm font-semibold truncate">
              {user?.email?.split('@')[0] || 'User'}
              {user?.role === 'admin' && (
                <Crown className="h-3.5 w-3.5 text-amber-300" />
              )}
            </p>
            <p className="text-[11px] text-pink-200/70 truncate">{user?.email || ''}</p>
          </div>
          <button
            onClick={logout}
            className={[
              'inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/5 text-pink-100 hover:bg-rose-500/20 hover:text-rose-200 transition ring-1 ring-white/10',
              collapsed ? 'md:hidden' : '',
            ].join(' ')}
            title="Logout"
            aria-label="Logout"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* Bottom dock (mobile)                                                       */
/* -------------------------------------------------------------------------- */

function BottomDock({ items, platform, location, onMore }) {
  return (
    <nav
      className="ig-bottom-dock md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#0b0410]/95 backdrop-blur-xl"
      aria-label="Primary"
    >
      <div className="grid grid-cols-5 px-1">
        {items.slice(0, 4).map(({ path, label, icon: Icon }) => {
          const fullPath = `/${platform}/${path}`;
          const isActive = location.pathname === fullPath;
          return (
            <Link
              key={fullPath}
              to={fullPath}
              className={[
                'flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
                isActive
                  ? 'text-pink-100'
                  : 'text-pink-200/60 hover:text-pink-100',
              ].join(' ')}
            >
              <span
                className={[
                  'flex h-8 w-8 items-center justify-center rounded-xl',
                  isActive
                    ? 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] text-white shadow-md shadow-pink-900/40'
                    : '',
                ].join(' ')}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="truncate max-w-[60px]">{label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={onMore}
          className="flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium text-pink-200/70 hover:text-pink-100"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/5 ring-1 ring-white/10">
            <Menu className="h-4 w-4" />
          </span>
          <span>More</span>
        </button>
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

export default function InstagramLayout({ children, title }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout, isAdmin, isApproved } = useAuth();
  const { platform } = usePlatform();
  const capabilities = useCapabilities();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close drawer on route change.
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  const items = useMemo(() => {
    const list = [];
    if (isAdmin || isApproved) {
      for (const item of IG_NAV) {
        if (item.capability == null || !capabilities) {
          list.push(item);
          continue;
        }
        if (capabilities[item.capability]) list.push(item);
      }
    }
    return list;
  }, [isAdmin, isApproved, capabilities]);

  const grouped = useMemo(() => {
    const g = { main: [], engage: [], safety: [], system: [] };
    for (const it of items) (g[it.section] || g.main).push(it);
    return g;
  }, [items]);

  const dockItems = useMemo(() => items.filter((i) => i.dock).slice(0, 4), [items]);
  const initials = user?.email ? user.email.substring(0, 2).toUpperCase() : 'IG';

  const sidebarProps = {
    items, grouped, isAdmin, location, platform,
    collapsed, setCollapsed,
    onClose: () => setMobileOpen(false),
    user, logout,
  };

  return (
    <div className="ig-panel-bg flex h-screen w-full overflow-hidden text-pink-50">
      {/* Desktop sidebar */}
      <div className="hidden md:flex shrink-0">
        <IGSidebar {...sidebarProps} mobile={false} />
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}
      <div
        className={[
          'md:hidden fixed inset-y-0 left-0 z-[60] transition-transform duration-300 ease-in-out',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        <IGSidebar {...sidebarProps} mobile />
      </div>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0b0410]/75 backdrop-blur-xl">
          <div className="flex items-center justify-between gap-2 px-3 sm:px-5 h-16 min-w-0">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <button
                onClick={() => {
                  if (window.matchMedia('(max-width: 767px)').matches) setMobileOpen((p) => !p);
                  else setCollapsed((p) => !p);
                }}
                className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-white/5 text-pink-100 hover:bg-white/10 ring-1 ring-white/10"
                aria-label="Toggle menu"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="hidden sm:flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/5 ring-1 ring-white/10">
                <Sparkles className="h-3.5 w-3.5 text-pink-300" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-pink-100/85">
                  IG Studio
                </span>
              </div>
              <div className="flex items-center gap-2 min-w-0">
                <span className="hidden sm:inline-block h-4 w-px bg-white/15" />
                <h1 className="text-[15px] sm:text-base font-semibold truncate text-pink-50">
                  {title || 'Instagram Panel'}
                </h1>
              </div>
            </div>

            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              {/* Cosmetic command-bar — frosted, scrollable on tap. */}
              <button
                type="button"
                onClick={() => navigate(`/${platform}/scrape`)}
                className="hidden lg:inline-flex items-center gap-2 rounded-lg bg-white/5 ring-1 ring-white/10 px-3 py-1.5 text-[11px] text-pink-100/70 hover:bg-white/10"
              >
                <Search className="h-3.5 w-3.5" />
                <span>Search Instagram targets</span>
                <span className="ml-2 inline-flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-mono text-pink-100/80">
                  <Command className="h-3 w-3" /> K
                </span>
              </button>

              <div className="block sm:hidden">
                <PlatformSwitch size="sm" />
              </div>
              <div className="hidden sm:block">
                <PlatformSwitch />
              </div>

              <button
                className="inline-flex relative items-center justify-center h-9 w-9 rounded-lg bg-white/5 text-pink-100 hover:bg-white/10 ring-1 ring-white/10"
                title="Notifications"
                aria-label="Notifications"
              >
                <Bell className="h-4 w-4" />
                <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-pink-400 ring-2 ring-[#0b0410]" />
              </button>

              <div className="hidden sm:flex items-center gap-2 pl-2 border-l border-white/10">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] text-white text-xs font-bold ring-2 ring-white/15">
                  {initials}
                </div>
                <div className="hidden md:block min-w-0">
                  <p className="text-sm font-semibold leading-tight truncate max-w-[140px]">
                    {user?.email?.split('@')[0] || 'User'}
                  </p>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-pink-200/70 leading-tight">
                    {user?.role === 'admin' ? 'Admin · IG' : 'Operator · IG'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* Page body — extra bottom padding on mobile so the dock never
            hides the last action button. */}
        <main className="ig-fade-up flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 pb-24 md:pb-6 min-w-0">
          <div className="mx-auto w-full max-w-[1400px] min-w-0">
            {children}
          </div>
        </main>
      </div>

      <BottomDock
        items={dockItems}
        platform={platform}
        location={location}
        onMore={() => setMobileOpen(true)}
      />
    </div>
  );
}
