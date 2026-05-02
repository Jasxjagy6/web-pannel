/**
 * InstagramFeatureShell — re-themed wrapper used by IG pages that
 * still rely on the cross-platform shared page bodies (Account
 * settings, Privacy, 2FA, Settings, Billing). Provides the
 * institutional IG hero + dark glass card so the wrapped content
 * doesn't break the overall pink/obsidian aesthetic.
 *
 * Pages that have full IG-native implementations (Dashboard,
 * Sessions, CreateSession, Scrape, Lists, Reports, Proxies,
 * AntiDetect) do NOT use this wrapper.
 */

import React from 'react';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

export default function InstagramFeatureShell({ icon: Icon, title, subtitle, children, actions }) {
  return (
    <div className="space-y-5">
      {/* Hero strip — gradient on top of glass so it reads as IG even
          inside the obsidian panel. */}
      <div
        className={[
          'relative overflow-hidden rounded-2xl px-5 sm:px-6 py-4 sm:py-5 text-white shadow-xl',
          'ring-1 ring-white/15',
          IG_GRADIENT,
        ].join(' ')}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            background:
              'radial-gradient(ellipse at 0% 0%, rgba(255,255,255,0.35) 0%, transparent 55%)',
          }}
        />
        <div className="relative flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            {Icon ? (
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/20 ring-1 ring-white/30 shrink-0">
                <Icon className="h-5 w-5" />
              </div>
            ) : null}
            <div className="min-w-0">
              <div className="text-base sm:text-lg font-semibold truncate">{title}</div>
              {subtitle ? (
                <div className="text-xs sm:text-sm text-white/85 truncate">{subtitle}</div>
              ) : null}
            </div>
          </div>
          {actions ? (
            <div className="flex items-center gap-2 shrink-0">{actions}</div>
          ) : null}
        </div>
      </div>

      {/* Content card — dark glass to match IG Studio chrome. */}
      <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-4 sm:p-5 shadow-xl">
        {children}
      </div>
    </div>
  );
}
