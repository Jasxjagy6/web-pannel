/**
 * InstagramLayout — chrome used for every /instagram/* route.
 *
 * Built from scratch so the Instagram panel does NOT share any visual
 * DNA with the Telegram panel. Pink/peach gradient sidebar, a frosted
 * top bar with a dedicated mobile platform switcher, soft pink page
 * background, and a transition overlay that plays whenever the user
 * toggles between Telegram and Instagram so the platform swap feels
 * deliberate instead of jarring.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  UserPlus,
  Search,
  MessageCircle,
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
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { usePlatform, useCapabilities } from '../../context/PlatformContext';

const IG_NAV = [
  { path: 'dashboard',         label: 'Dashboard',     icon: LayoutDashboard, capability: null,                section: 'main' },
  { path: 'sessions',          label: 'Accounts',      icon: Users,           capability: 'sessions_list',     section: 'main' },
  { path: 'create-session',    label: 'Add account',   icon: UserPlus,        capability: 'sessions_create',   section: 'main' },
  { path: 'upload-session',    label: 'Upload session',icon: Upload,          capability: 'sessions_create',   section: 'main' },
  { path: 'scrape',            label: 'Scraping',      icon: Search,          capability: 'scrape_any',        section: 'main' },
  { path: 'messaging',         label: 'Direct messages', icon: MessageCircle, capability: 'messaging_bulk',    section: 'engage' },
  { path: 'lists',             label: 'Saved lists',   icon: ListIcon,        capability: 'lists',             section: 'engage' },
  { path: 'reports',           label: 'Reports',       icon: BarChart3,       capability: 'reports',           section: 'engage' },
  { path: 'proxies',           label: 'Proxies',       icon: Network,         capability: 'proxies',           section: 'safety' },
  { path: 'anti-detect',       label: 'Identity',      icon: Fingerprint,     capability: 'identity_device',   section: 'safety' },
  { path: 'account-settings',  label: 'Account',       icon: UserCog,         capability: 'account_settings',  section: 'safety' },
  { path: 'privacy',           label: 'Privacy',       icon: Shield,          capability: 'privacy_set',       section: 'safety' },
  { path: 'change-2fa',        label: '2FA',           icon: ShieldCheck,     capability: 'twofa_change',      section: 'safety' },
  { path: 'billing',           label: 'Billing',       icon: CreditCard,      capability: null,                section: 'system' },
  { path: 'settings',          label: 'Settings',      icon: SettingsIcon,    capability: null,                section: 'system' },
];

const SECTION_LABELS = {
  main:   'Workspace',
  engage: 'Engage',
  safety: 'Safety',
  system: 'System',
};

function PlatformSwitch({ size = 'md' }) {
  const { platform, setPlatform, isEnabled } = usePlatform();
  const sizing = size === 'sm'
    ? { btn: 'px-2.5 py-1 text-[11px]', icon: 'h-3 w-3' }
    : { btn: 'px-3 py-1.5 text-xs', icon: 'h-3.5 w-3.5' };
  return (
    <div
      role="tablist"
      aria-label="Active panel"
      className="inline-flex items-center gap-1 rounded-full border border-pink-200/70 bg-white/80 p-1 backdrop-blur dark:border-pink-300/20 dark:bg-pink-950/30"
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
                ? `bg-gradient-to-r ${cls} text-white shadow ring-1 ring-white/30`
                : enabled
                  ? 'text-pink-700 hover:bg-pink-100 dark:text-pink-200 dark:hover:bg-pink-900/30'
                  : 'cursor-not-allowed text-pink-300/60',
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

  const initials = user?.email ? user.email.substring(0, 2).toUpperCase() : 'IG';

  const sidebar = (
    <aside
      className={[
        'flex h-full flex-col text-white shadow-xl',
        'bg-gradient-to-b from-[#a21caf] via-[#db2777] to-[#f59e0b]',
        collapsed ? 'md:w-20' : 'md:w-64',
        'w-72',
      ].join(' ')}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 h-16 border-b border-white/20">
        {!collapsed && (
          <>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/30 shrink-0">
              <Camera className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-base font-bold tracking-tight truncate">Instagram</div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/70">Panel</div>
            </div>
          </>
        )}
        <button
          onClick={() => setMobileOpen(false)}
          className="md:hidden ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20"
          aria-label="Close menu"
        >
          <X className="h-4 w-4" />
        </button>
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
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {isAdmin && (
          <Link
            to="/admin"
            className={[
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-all',
              'bg-amber-300/20 ring-1 ring-amber-200/40 hover:bg-amber-300/30',
              collapsed ? 'md:justify-center' : '',
            ].join(' ')}
          >
            <Crown className="h-4 w-4 text-amber-200" />
            <span className={collapsed ? 'md:hidden' : ''}>Admin</span>
          </Link>
        )}

        {Object.entries(grouped).map(([section, list]) => (
          list.length === 0 ? null : (
            <div key={section}>
              {!collapsed && (
                <div className="px-3 mb-1 text-[10px] uppercase tracking-[0.2em] font-semibold text-white/60">
                  {SECTION_LABELS[section]}
                </div>
              )}
              <div className="space-y-1">
                {list.map(({ path, label, icon: Icon }) => {
                  const fullPath = `/${platform}/${path}`;
                  const isActive = location.pathname === fullPath;
                  return (
                    <Link
                      key={fullPath}
                      to={fullPath}
                      className={[
                        'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                        isActive
                          ? 'bg-white text-pink-700 shadow ring-1 ring-white/40'
                          : 'text-white/85 hover:bg-white/15',
                        collapsed ? 'md:justify-center' : '',
                      ].join(' ')}
                    >
                      <Icon className={['h-5 w-5 shrink-0', isActive ? 'text-pink-700' : 'text-white/85'].join(' ')} />
                      <span className={collapsed ? 'md:hidden' : ''}>{label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )
        ))}

        {!isAdmin && !isApproved && (
          <p className="mx-2 mt-4 rounded-lg bg-white/15 p-3 text-xs text-white/90 ring-1 ring-white/30">
            Awaiting admin approval. Features unlock once your account is approved.
          </p>
        )}
      </nav>

      {/* User */}
      <div className="border-t border-white/20 p-3">
        <div className={`flex items-center ${collapsed ? 'md:justify-center' : 'gap-3'}`}>
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20 text-xs font-semibold ring-1 ring-white/30">
            {initials}
          </div>
          <div className={`flex-1 min-w-0 ${collapsed ? 'md:hidden' : ''}`}>
            <p className="text-sm font-semibold truncate">{user?.email?.split('@')[0] || 'User'}</p>
            <p className="text-[11px] text-white/70 truncate">{user?.email || ''}</p>
          </div>
          <button
            onClick={logout}
            className={[
              'inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 transition',
              collapsed ? 'md:hidden' : '',
            ].join(' ')}
            title="Logout"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );

  return (
    <div className="flex h-screen bg-pink-50 text-pink-950 dark:bg-[#1a0b1c] dark:text-pink-50">
      {/* Desktop sidebar */}
      <div className="hidden md:flex shrink-0">
        {sidebar}
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <div
        className={[
          'md:hidden fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-in-out',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        {sidebar}
      </div>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header className="sticky top-0 z-30 bg-white/85 backdrop-blur border-b border-pink-200/60 dark:bg-pink-950/40 dark:border-pink-300/20">
          <div className="flex items-center justify-between px-4 h-16">
            <div className="flex items-center gap-3 min-w-0">
              <button
                onClick={() => {
                  if (window.matchMedia('(max-width: 767px)').matches) setMobileOpen((p) => !p);
                  else setCollapsed((p) => !p);
                }}
                className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-pink-100 text-pink-700 hover:bg-pink-200 dark:bg-pink-900/40 dark:text-pink-200"
                aria-label="Toggle menu"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="flex items-center gap-2 min-w-0">
                <Sparkles className="h-4 w-4 text-pink-500 shrink-0" />
                <h1 className="text-base sm:text-lg font-semibold truncate">{title || 'Instagram Panel'}</h1>
              </div>
            </div>

            <div className="flex items-center gap-2 sm:gap-3">
              <div className="block sm:hidden">
                <PlatformSwitch size="sm" />
              </div>
              <div className="hidden sm:block">
                <PlatformSwitch />
              </div>
              <button
                className="hidden sm:inline-flex relative items-center justify-center h-9 w-9 rounded-lg text-pink-700 hover:bg-pink-100 dark:text-pink-200 dark:hover:bg-pink-900/40"
                title="Notifications"
              >
                <Bell className="h-5 w-5" />
                <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-pink-500 ring-2 ring-white dark:ring-pink-950" />
              </button>
              <div className="hidden sm:flex items-center gap-2 pl-2 border-l border-pink-200/60 dark:border-pink-300/20">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] text-white text-xs font-bold ring-2 ring-white/70">
                  {initials}
                </div>
                <div className="hidden md:block">
                  <p className="text-sm font-medium leading-tight">{user?.email?.split('@')[0] || 'User'}</p>
                  <p className="text-[11px] text-pink-700/70 dark:text-pink-200/60 leading-tight">
                    {user?.email || ''}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* Page body */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 bg-[radial-gradient(ellipse_at_top_right,rgba(244,114,182,0.18),transparent_55%)] dark:bg-none">
          {children}
        </main>
      </div>

    </div>
  );
}
