import React, { useEffect, useRef, useState } from 'react';
import { Bell, Menu, User, Sun, Moon, LogOut, Settings as SettingsIcon, Mail } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '../../context/ThemeContext';
import { usePlatform } from '../../context/PlatformContext';
import PlatformToggle from './PlatformToggle';

/**
 * Top app bar for the Telegram panel.
 *
 * The previous implementation had:
 *   - a static notification bell that didn't open a popover,
 *   - no theme toggle,
 *   - no avatar menu.
 *
 * This refresh keeps every behaviour the old header had (mobile burger,
 * platform toggle, page title, user identity), and adds:
 *   - a brand-aware notification popover with an empty state,
 *   - a theme toggle (sun ⇄ moon) that flips the panel between
 *     pure-black dark and clean white modes,
 *   - an avatar menu with quick links to Account / Settings / Sign out.
 *
 * No backend calls are added — all upgrades are presentational.
 */
export default function Header({ onMenuClick, title }) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { platform } = usePlatform();

  const [notifOpen, setNotifOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const notifRef = useRef(null);
  const menuRef = useRef(null);

  // Click-outside to dismiss popovers.
  useEffect(() => {
    const onClick = (e) => {
      if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false);
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const initials = user?.email
    ? user.email.substring(0, 2).toUpperCase()
    : 'U';

  const isLight = theme === 'light';
  const showThemeToggle = platform === 'telegram';

  return (
    <header className="tg-chrome relative bg-dark-800 border-b border-white/5 h-16 flex items-center justify-between px-4 sticky top-0 z-30 backdrop-blur-md">
      {/* Subtle brand accent line */}
      <span
        aria-hidden
        className="pointer-events-none absolute left-0 right-0 bottom-0 h-px"
        style={{ background: 'linear-gradient(90deg, transparent, rgba(var(--brand-500-rgb),0.35), transparent)' }}
      />

      {/* Left: menu toggle button + page title */}
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="flex items-center justify-center h-9 w-9 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          title="Toggle sidebar"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-[11px] uppercase tracking-[0.14em] text-gray-500 hidden sm:inline">
            {platform === 'instagram' ? 'Instagram Panel' : 'Telegram Control Center'}
          </span>
          <h1 className="text-base sm:text-lg font-semibold text-white truncate max-w-[55vw] sm:max-w-none">
            {title || 'Dashboard'}
          </h1>
        </div>
      </div>

      {/* Right: platform toggle, theme toggle, notifications, avatar */}
      <div className="flex items-center gap-1.5 sm:gap-2">
        {/* Platform toggle — visible on mobile too so users on phones
            can swap between Telegram and Instagram panels. The compact
            `size=sm` variant keeps it from blowing out the header on
            <360px screens. */}
        <div className="block sm:hidden">
          <PlatformToggle size="sm" />
        </div>
        <div className="hidden sm:block">
          <PlatformToggle />
        </div>

        {/* Theme toggle — only meaningful inside the Telegram panel.
            Instagram has its own dark obsidian palette and isn't
            controlled by this attribute. */}
        {showThemeToggle && (
          <button
            onClick={toggleTheme}
            className="relative flex items-center justify-center h-9 w-9 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
            aria-label="Toggle theme"
          >
            {isLight ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
          </button>
        )}

        {/* Notification bell with popover */}
        <div ref={notifRef} className="relative">
          <button
            onClick={() => { setNotifOpen((v) => !v); setMenuOpen(false); }}
            className="relative flex items-center justify-center h-9 w-9 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            title="Notifications"
            aria-haspopup="true"
            aria-expanded={notifOpen}
          >
            <Bell className="h-5 w-5" />
            <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-brand-500 ring-2 ring-dark-800" />
          </button>
          {notifOpen && (
            <div
              role="dialog"
              className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-white/10 bg-dark-800 shadow-2xl overflow-hidden animate-fade-in"
            >
              <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                <p className="text-sm font-semibold text-white">Notifications</p>
                <span className="text-[11px] uppercase tracking-wider text-gray-500">Live</span>
              </div>
              <div className="max-h-80 overflow-y-auto divide-y divide-white/5">
                <div className="px-4 py-8 text-center">
                  <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-brand-500/10 text-brand-400">
                    <Mail className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-medium text-white">You're all caught up</p>
                  <p className="mt-1 text-xs text-gray-500">
                    Job updates, login alerts and admin broadcasts will appear here.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="h-6 w-px bg-white/10 mx-1" />

        {/* User avatar with menu */}
        <div ref={menuRef} className="relative flex items-center gap-3 pl-1">
          <button
            onClick={() => { setMenuOpen((v) => !v); setNotifOpen(false); }}
            className="flex items-center gap-3 rounded-lg pl-1 pr-2 py-1 hover:bg-white/5 transition-colors"
            aria-haspopup="true"
            aria-expanded={menuOpen}
          >
            <div className="relative">
              <div className="flex h-9 w-9 items-center justify-center rounded-full text-white text-xs font-semibold ring-2 ring-brand-500/40 brand-gradient shadow-md shadow-brand-500/20">
                {user?.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={user.email || 'User'}
                    className="h-9 w-9 rounded-full object-cover"
                  />
                ) : (
                  <span className="font-semibold tracking-wide">{initials}</span>
                )}
              </div>
              <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-dark-800" />
            </div>

            <div className="hidden sm:block text-left">
              <p className="text-sm font-medium text-white leading-tight">
                {user?.email?.split('@')[0] || 'User'}
              </p>
              <p className="text-xs text-gray-500 truncate max-w-[160px]">
                {user?.email || ''}
              </p>
            </div>
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-2 w-60 rounded-xl border border-white/10 bg-dark-800 shadow-2xl overflow-hidden animate-fade-in"
            >
              <div className="px-4 py-3 border-b border-white/5">
                <p className="text-sm font-semibold text-white truncate">{user?.email?.split('@')[0] || 'User'}</p>
                <p className="text-xs text-gray-500 truncate">{user?.email || ''}</p>
              </div>
              <a
                href={`/${platform || 'telegram'}/account-settings`}
                className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                role="menuitem"
              >
                <User className="h-4 w-4" /> Account
              </a>
              <a
                href={`/${platform || 'telegram'}/settings`}
                className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                role="menuitem"
              >
                <SettingsIcon className="h-4 w-4" /> Settings
              </a>
              <button
                onClick={logout}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors border-t border-white/5"
                role="menuitem"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
