import React from 'react';
import { Bell, Menu, User } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import PlatformToggle from './PlatformToggle';

export default function Header({ onMenuClick, title }) {
  const { user } = useAuth();

  const initials = user?.email
    ? user.email.substring(0, 2).toUpperCase()
    : 'U';

  return (
    <header className="bg-dark-800 border-b border-white/5 h-16 flex items-center justify-between px-4 sticky top-0 z-30">
      {/* Left: menu toggle button + page title */}
      <div className="flex items-center gap-4">
        <button
          onClick={onMenuClick}
          className="flex items-center justify-center h-9 w-9 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          title="Toggle sidebar"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="text-base sm:text-lg font-semibold text-white truncate max-w-[55vw] sm:max-w-none">
          {title || 'Dashboard'}
        </h1>
      </div>

      {/* Right: platform toggle, notification bell, user avatar */}
      <div className="flex items-center gap-3">
        {/* Platform toggle (TG / IG segmented control) */}
        <div className="hidden sm:block">
          <PlatformToggle />
        </div>

        {/* Notification bell */}
        <button
          className="relative flex items-center justify-center h-9 w-9 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          title="Notifications"
        >
          <Bell className="h-5 w-5" />
          <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-brand-500 ring-2 ring-dark-800" />
        </button>

        {/* Divider */}
        <div className="h-6 w-px bg-white/10" />

        {/* User avatar and email */}
        <div className="flex items-center gap-3 pl-2">
          {/* Avatar */}
          <div className="relative">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-600/20 text-primary-500 text-xs font-semibold ring-2 ring-primary-600/30">
              {user?.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.email || 'User'}
                  className="h-9 w-9 rounded-full object-cover"
                />
              ) : (
                <User className="h-4 w-4" />
              )}
            </div>
            {/* Online indicator */}
            <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-dark-800" />
          </div>

          {/* User email */}
          <div className="hidden sm:block">
            <p className="text-sm font-medium text-white">
              {user?.email?.split('@')[0] || 'User'}
            </p>
            <p className="text-xs text-gray-500 truncate max-w-[160px]">
              {user?.email || ''}
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}
