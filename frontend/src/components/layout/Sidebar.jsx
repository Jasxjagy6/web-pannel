import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { 
  LayoutDashboard, Users, Search, MessageSquare, UsersRound, List, BarChart3, Settings, LogOut, ChevronLeft, ChevronRight, UserCog, ShieldCheck, KeyRound, Network, UserPlus, Fingerprint
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

const navItems = [
  { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/sessions', label: 'Sessions', icon: Users },
  { path: '/create-session', label: 'Create Session', icon: UserPlus },
  { path: '/scrape', label: 'Scrape', icon: Search },
  { path: '/messaging', label: 'Messaging', icon: MessageSquare },
  { path: '/groups', label: 'Groups', icon: UsersRound },
  { path: '/lists', label: 'Lists', icon: List },
  { path: '/change-2fa', label: 'Change 2FA', icon: ShieldCheck },
  { path: '/get-otp', label: 'Get OTP', icon: KeyRound },
  { path: '/proxies', label: 'Proxies', icon: Network },
  { path: '/anti-detect', label: 'Anti-Detect', icon: Fingerprint },
  { path: '/reports', label: 'Reports', icon: BarChart3 },
  { path: '/account-settings', label: 'Account Settings', icon: UserCog },
  { path: '/settings', label: 'Settings', icon: Settings },
];

export default function Sidebar({ collapsed, onToggle }) {
  const location = useLocation();
  const { user, logout } = useAuth();
  const [hoveredItem, setHoveredItem] = useState(null);

  const initials = user?.email
    ? user.email.substring(0, 2).toUpperCase()
    : 'U';

  return (
    <aside
      className={`relative flex flex-col bg-dark-900 border-r border-white/5 transition-all duration-300 ease-in-out ${
        collapsed ? 'w-20' : 'w-64'
      }`}
    >
      {/* Logo / Header area */}
      <div className="flex items-center h-16 px-4 border-b border-white/5">
        {!collapsed && (
          <div className="flex items-center gap-3 flex-1">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-600 shadow-lg shadow-primary-600/20">
              <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
              </svg>
            </div>
            <span className="text-lg font-bold text-white tracking-tight">
              Telegram Panel
            </span>
          </div>
        )}
        <button
          onClick={onToggle}
          className="flex items-center justify-center h-8 w-8 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
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
        {navItems.map(({ path, label, icon: Icon }) => {
          const isActive = location.pathname === path;
          return (
            <div key={path} className="relative">
              <Link
                to={path}
                onMouseEnter={() => setHoveredItem(path)}
                onMouseLeave={() => setHoveredItem(null)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? 'bg-primary-600/20 text-primary-500 border-l-4 border-primary-500'
                    : 'text-gray-400 hover:bg-white/5 hover:text-white border-l-4 border-transparent'
                } ${collapsed ? 'justify-center' : ''}`}
              >
                <Icon className={`h-5 w-5 shrink-0 ${isActive ? 'text-primary-500' : ''}`} />
                {!collapsed && <span>{label}</span>}
              </Link>

              {/* Hover tooltip when collapsed */}
              {collapsed && hoveredItem === path && (
                <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-3 py-1.5 bg-dark-800 text-white text-xs font-medium rounded-md shadow-xl border border-white/10 whitespace-nowrap z-50 pointer-events-none">
                  {label}
                  <div className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-dark-800" />
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* User info and logout at bottom */}
      <div className="border-t border-white/5 p-3">
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-3'}`}>
          {/* User avatar */}
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

          {/* User details */}
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">
                {user?.email?.split('@')[0] || 'User'}
              </p>
              <p className="text-xs text-gray-500 truncate">
                {user?.email || ''}
              </p>
            </div>
          )}

          {/* Logout button */}
          <button
            onClick={logout}
            className="flex items-center justify-center h-8 w-8 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-400/10 transition-colors shrink-0"
            title="Logout"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>

        {/* Tooltip for user when collapsed */}
        {collapsed && (
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-dark-800 text-white text-xs font-medium rounded-md shadow-xl border border-white/10 whitespace-nowrap z-50 pointer-events-none">
            {user?.email || 'User'}
            <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-dark-800" />
          </div>
        )}
      </div>
    </aside>
  );
}
