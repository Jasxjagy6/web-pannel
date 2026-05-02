/**
 * InstagramFeatureShell — re-themed wrapper around shared feature
 * pages so they fit the pink Instagram chrome instead of inheriting
 * the Telegram dark/blue look. Most shared pages render fine inside
 * the InstagramLayout because the brand-* CSS variables flip to pink
 * automatically (platform-tokens.css). This component adds a hero
 * banner above the wrapped page so the IG context is unambiguous.
 */

import React from 'react';

const IG_GRADIENT = 'bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888]';

export default function InstagramFeatureShell({ icon: Icon, title, subtitle, children, actions }) {
  return (
    <div className="space-y-5">
      <div className={`rounded-2xl ${IG_GRADIENT} px-6 py-5 text-white shadow-lg`}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            {Icon ? <Icon className="h-7 w-7" /> : null}
            <div>
              <div className="text-lg font-semibold">{title}</div>
              {subtitle ? <div className="text-sm text-white/85">{subtitle}</div> : null}
            </div>
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      </div>
      <div className="rounded-xl border border-pink-200 bg-white p-4 sm:p-5 shadow-sm dark:border-pink-300/20 dark:bg-pink-950/30">
        {children}
      </div>
    </div>
  );
}
