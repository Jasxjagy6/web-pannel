import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Search, MessageSquare, UsersRound, List, BarChart3,
  Settings, LogOut, ChevronLeft, ChevronRight, UserCog, ShieldCheck, KeyRound,
  Network, UserPlus, Fingerprint, Shield, Crown, X, CreditCard, MessagesSquare,
  LogIn,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { usePlatform, useCapabilities, PLATFORM_LABELS } from '../../context/PlatformContext';

// Each nav item declares the platform capability it requires (or null
// for cross-platform pages). Hidden when capabilities[capability] is
// false on the active platform.
const userNavItems = [
  { path: 'dashboard',         label: 'Dashboard',        icon: LayoutDashboard, capability: null },
  { path: 'sessions',          label: 'Sessions',         icon: Users,           capability: 'sessions_list' },
  { path: 'create-session',    label: 'Create Session',   icon: UserPlus,        capability: 'sessions_create' },
  { path: 'login-sessions',    label: 'Login',            icon: LogIn,           capability: 'telegram_client' },
  { path: 'scrape',            label: 'Scrape',           icon: Search,          capability: 'scrape_any' },
  { path: 'messaging',         label: 'Messaging',        icon: MessageSquare,   capability: 'messaging_bulk' },
  { path: 'groups',            label: 'Groups',           icon: UsersRound,      capability: 'groups_invite' },
  { path: 'threads',           label: 'Threads',          icon: MessagesSquare,  capability: 'messaging_threads' },
  { path: 'lists',             label: 'Lists',            icon: List,            capability: 'lists' },
  { path: 'change-2fa',        label: 'Change 2FA',       icon: ShieldCheck,     capability: 'twofa_change' },
  { path: 'get-otp',           label: 'Get OTP',          icon: KeyRound,        capability: 'otp_passive' },
  { path: 'otp-relay',         label: 'OTP Relay',        icon: ShieldCheck,     capability: 'otp_relay' },
  { path: 'proxies',           label: 'Proxies',          icon: Network,         capability: 'proxies' },
  { path: 'proxy-providers',   label: 'Auto-rotating proxy', icon: Network,      capability: 'proxies' },
  { path: 'anti-detect',       label: 'Anti-Detect',      icon: Fingerprint,     capability: 'identity_device' },
  { path: 'reports',           label: 'Reports',          icon: BarChart3,       capability: 'reports' },
  { path: 'account-settings',  label: 'Account Settings', icon: UserCog,         capability: 'account_settings' },
  { path: 'privacy',           label: 'Privacy',          icon: Shield,          capability: 'privacy_set' },
  { path: 'billing',           label: 'Billing',          icon: CreditCard,      capability: null },
  { path: 'settings',          label: 'Settings',         icon: Settings,        capability: null },
];

const adminNavItems = [
  { path: '/admin', label: 'Admin Panel', icon: Crown, absolute: true },
];

export default function Sidebar({ collapsed, mobileOpen, onToggle, onCloseMobile }) {
  const location = useLocation();
  const { user, logout, isAdmin, isApproved } = useAuth();
  const [hoveredItem, setHoveredItem] = useState(null);

  // Close drawer when clicking a link on mobile.
  useEffect(() => {
    if (mobileOpen && onCloseMobile) {
      onCloseMobile();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const initials = user?.email
    ? user.email.substring(0, 2).toUpperCase()
    : 'U';

  // Build the nav: admins see admin items + everything; approved users see
  // user items filtered by the active platform's capabilities;
  // un-approved users see nothing useful (Pending page handles that, so
  // we just show their account info).
  const { platform } = usePlatform();
  const capabilities = useCapabilities();
  const items = [];
  if (isAdmin) items.push(...adminNavItems);
  if (isAdmin || isApproved) {
    for (const item of userNavItems) {
      if (item.capability == null || !capabilities) {
        // Either the page is platform-agnostic, or capabilities haven't
        // loaded yet — show it. The page itself enforces the gate.
        items.push(item);
        continue;
      }
      if (capabilities[item.capability]) items.push(item);
    }
  }

  const aside = (
    <aside
      className={`flex h-full flex-col bg-dark-900 border-r border-white/5 transition-[width] duration-300 ease-in-out
        ${collapsed ? 'md:w-20' : 'md:w-64'} w-72 md:w-64`}
    >
      {/* Logo / Header area */}
      <div className="flex items-center h-16 px-4 border-b border-white/5">
        {!collapsed && (
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg shadow-lg shrink-0 brand-gradient">
              <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
              </svg>
            </div>
            <span className="text-lg font-bold text-white tracking-tight truncate">
              {PLATFORM_LABELS[platform] || 'Panel'}
            </span>
          </div>
        )}
        {/* Close on mobile */}
        <button
          onClick={onCloseMobile}
          className="md:hidden flex items-center justify-center h-8 w-8 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          title="Close menu"
        >
          <X className="h-5 w-5" />
        </button>
        {/* Collapse on desktop */}
        <button
          onClick={onToggle}
          className="hidden md:flex items-center justify-center h-8 w-8 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronRight className="h-5 w-5" />
          ) : (
            <ChevronLeft className="h-5 w-5" />
          )}
        </button>
      </div>

      {/* Navigation links */}
      <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
        {items.map(({ path, label, icon: Icon, absolute }) => {
          const fullPath = absolute ? path : `/${platform}/${path}`;
          const isActive = location.pathname === fullPath;
          const isAdminItem = adminNavItems.some((it) => it.path === path);
          return (
            <div key={fullPath} className="relative">
              <Link
                to={fullPath}
                onMouseEnter={() => setHoveredItem(fullPath)}
                onMouseLeave={() => setHoveredItem(null)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? (isAdminItem
                      ? 'bg-amber-500/15 text-amber-300 border-l-4 border-amber-400'
                      : 'bg-brand-500/20 text-brand-400 border-l-4 border-brand-500')
                    : 'text-gray-400 hover:bg-white/5 hover:text-white border-l-4 border-transparent'
                } ${collapsed ? 'md:justify-center' : ''}`}
              >
                <Icon className={`h-5 w-5 shrink-0 ${
                  isActive ? (isAdminItem ? 'text-amber-300' : 'text-brand-400') : ''
                }`} />
                <span className={`${collapsed ? 'md:hidden' : ''}`}>{label}</span>
              </Link>

              {/* Hover tooltip when collapsed (desktop only) */}
              {collapsed && hoveredItem === fullPath && (
                <div className="hidden md:block absolute left-full top-1/2 -translate-y-1/2 ml-2 px-3 py-1.5 bg-dark-800 text-white text-xs font-medium rounded-md shadow-xl border border-white/10 whitespace-nowrap z-50 pointer-events-none">
                  {label}
                </div>
              )}
            </div>
          );
        })}

        {!isAdmin && !isApproved && (
          <p className="mx-2 mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
            Awaiting admin approval. Features unlock once your account is approved.
          </p>
        )}
      </nav>

      {/* User info and logout */}
      <div className="border-t border-white/5 p-3">
        <div className={`flex items-center ${collapsed ? 'md:justify-center' : 'gap-3'}`}>
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-600/20 text-primary-500 text-xs font-semibold">
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.email || 'User'}
                className="h-9 w-9 rounded-full object-cover"
              />
            ) : (
              initials
            )}
          </div>
          <div className={`flex-1 min-w-0 ${collapsed ? 'md:hidden' : ''}`}>
            <p className="text-sm font-medium text-white truncate flex items-center gap-1.5">
              {user?.email?.split('@')[0] || 'User'}
              {isAdmin && <Crown className="h-3.5 w-3.5 text-amber-400" />}
            </p>
            <p className="text-xs text-gray-500 truncate">
              {user?.email || ''}
            </p>
          </div>
          <button
            onClick={logout}
            className="flex items-center justify-center h-8 w-8 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-400/10 transition-colors shrink-0"
            title="Logout"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}
      {/* Mobile drawer */}
      <div
        className={`md:hidden fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-in-out ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {aside}
      </div>
      {/* Desktop sidebar */}
      <div className={`hidden md:block shrink-0 ${collapsed ? 'w-20' : 'w-64'}`}>
        {aside}
      </div>
    </>
  );
}
