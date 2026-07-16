/**
 * TrackingLayout — dedicated full-screen chrome for the Tracking panel
 * (/tracking/*). Mirrors the "separate world" treatment the Instagram
 * panel gets (its own sidebar, theme, and header) rather than living as
 * a menu item inside the Telegram sidebar.
 *
 * Identity: emerald/teal aurora on an obsidian base — visually distinct
 * from Telegram (blue) and Instagram (pink/orange). Must be rendered
 * inside TrackingAccessProvider so the sidebar can gate the Team link on
 * the caller's tracking permissions.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, ClipboardList, UserCog, LogOut, Menu, X,
  ChevronLeft, ChevronRight, Crown, PackageSearch,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import PanelSwitcher from '../layout/PanelSwitcher';
import { useTrackingAccess } from '../../context/TrackingAccessContext';

function NavItem({ to, label, icon: Icon, active, collapsed }) {
  return (
    <Link
      to={to}
      className={[
        'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
        active
          ? 'text-white shadow-lg shadow-emerald-900/40 ring-1 ring-white/20 bg-gradient-to-r from-emerald-500 to-teal-600'
          : 'text-emerald-100/80 hover:text-white hover:bg-white/5 ring-1 ring-transparent hover:ring-white/10',
        collapsed ? 'md:justify-center md:px-2' : '',
      ].join(' ')}
      title={label}
    >
      <Icon className={['h-5 w-5 shrink-0 transition-colors', active ? 'text-white' : 'text-emerald-200/80 group-hover:text-emerald-100'].join(' ')} />
      <span className={['truncate', collapsed ? 'md:hidden' : ''].join(' ')}>{label}</span>
      {active && !collapsed && (
        <span className="ml-auto inline-block h-1.5 w-1.5 rounded-full bg-white/90 ring-2 ring-white/30" />
      )}
    </Link>
  );
}

function TrackingSidebar({ items, location, collapsed, setCollapsed, onClose, user, logout, isAdmin, mobile }) {
  const initials = user?.email ? user.email.substring(0, 2).toUpperCase() : 'TR';
  return (
    <aside
      className={[
        'flex h-full flex-col text-emerald-50 shadow-2xl relative',
        'bg-[#04100c]/95 backdrop-blur-xl border-r border-white/10',
        collapsed ? 'md:w-20' : 'md:w-[16rem]',
        'w-[16.5rem]',
      ].join(' ')}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            'radial-gradient(ellipse at 0% 0%, rgba(16,185,129,0.20) 0%, transparent 55%),' +
            'radial-gradient(ellipse at 100% 100%, rgba(20,184,166,0.16) 0%, transparent 55%)',
        }}
        aria-hidden="true"
      />

      {/* Header / logo */}
      <div className="relative flex items-center gap-3 px-4 h-16 border-b border-white/10">
        {!collapsed && (
          <>
            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-600 ring-1 ring-white/20 shrink-0 shadow-lg shadow-emerald-900/40">
              <PackageSearch className="h-5 w-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold tracking-tight truncate">
                Account <span className="bg-gradient-to-r from-emerald-300 to-teal-200 bg-clip-text text-transparent">Tracker</span>
              </div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-emerald-200/70">Inventory · CRM</div>
            </div>
          </>
        )}
        {mobile ? (
          <button onClick={onClose} className="md:hidden ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 transition" aria-label="Close menu">
            <X className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={() => setCollapsed((c) => !c)}
            className={['hidden md:inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 transition', collapsed ? 'mx-auto' : ''].join(' ')}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="relative flex-1 overflow-y-auto px-3 py-4 space-y-1">
        {items.map(({ path, label, icon }) => {
          const isActive = path === '/tracking'
            ? (location.pathname === '/tracking' || location.pathname === '/tracking/')
            : location.pathname.startsWith(path);
          return (
            <NavItem key={path} to={path} label={label} icon={icon} active={isActive} collapsed={collapsed} />
          );
        })}
      </nav>

      {/* User card */}
      <div className="relative border-t border-white/10 p-3">
        <div className={`flex items-center ${collapsed ? 'md:justify-center' : 'gap-3'}`}>
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-emerald-500 to-teal-600 text-xs font-bold ring-2 ring-white/15">
            {initials}
          </div>
          <div className={`flex-1 min-w-0 ${collapsed ? 'md:hidden' : ''}`}>
            <p className="flex items-center gap-1.5 text-sm font-semibold truncate">
              {user?.email?.split('@')[0] || 'User'}
              {isAdmin && <Crown className="h-3.5 w-3.5 text-amber-300" />}
            </p>
            <p className="text-[11px] text-emerald-200/70 truncate">{user?.email || ''}</p>
          </div>
          <button
            onClick={logout}
            className={['inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/5 text-emerald-100 hover:bg-rose-500/20 hover:text-rose-200 transition ring-1 ring-white/10', collapsed ? 'md:hidden' : ''].join(' ')}
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

export default function TrackingLayout({ children, title }) {
  const location = useLocation();
  const { user, logout, isAdmin } = useAuth();
  const { hasPermission } = useTrackingAccess();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  const items = useMemo(() => {
    const list = [
      { path: '/tracking', label: 'Dashboard', icon: LayoutDashboard },
      { path: '/tracking/accounts', label: 'Accounts', icon: ClipboardList },
    ];
    if (hasPermission('manageTeam')) {
      list.push({ path: '/tracking/team', label: 'Team', icon: UserCog });
    }
    return list;
  }, [hasPermission]);

  const sidebarProps = {
    items, location, collapsed, setCollapsed,
    onClose: () => setMobileOpen(false), user, logout, isAdmin,
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#04100c] text-emerald-50">
      {/* Desktop sidebar */}
      <div className="hidden md:flex shrink-0">
        <TrackingSidebar {...sidebarProps} mobile={false} />
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={() => setMobileOpen(false)} aria-hidden="true" />
      )}
      <div className={['md:hidden fixed inset-y-0 left-0 z-[60] transition-transform duration-300 ease-in-out', mobileOpen ? 'translate-x-0' : '-translate-x-full'].join(' ')}>
        <TrackingSidebar {...sidebarProps} mobile />
      </div>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="sticky top-0 z-30 border-b border-white/10 bg-[#04100c]/75 backdrop-blur-xl">
          <div className="flex items-center justify-between gap-2 px-3 sm:px-5 h-16 min-w-0">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <button
                onClick={() => {
                  if (window.matchMedia('(max-width: 767px)').matches) setMobileOpen((p) => !p);
                  else setCollapsed((p) => !p);
                }}
                className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-white/5 text-emerald-100 hover:bg-white/10 ring-1 ring-white/10"
                aria-label="Toggle menu"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="flex flex-col leading-tight min-w-0">
                <span className="hidden sm:inline text-[11px] uppercase tracking-[0.18em] text-emerald-200/70">Account Tracker</span>
                <h1 className="text-[15px] sm:text-base font-semibold truncate text-emerald-50">{title || 'Tracking'}</h1>
              </div>
            </div>

            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              <div className="block sm:hidden"><PanelSwitcher size="sm" /></div>
              <div className="hidden sm:block"><PanelSwitcher /></div>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 min-w-0">
          <div className="mx-auto w-full max-w-[1400px] min-w-0">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
