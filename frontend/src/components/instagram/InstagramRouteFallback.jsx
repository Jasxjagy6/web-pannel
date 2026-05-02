import React from 'react';
import { Camera } from 'lucide-react';

/**
 * Instagram-themed Suspense fallback. Shown while a lazy IG route's
 * chunk is being fetched, and any time we want a branded "loading"
 * surface inside the IG panel. Visually distinct from the Telegram
 * RouteFallback (which is dark-blue): pink/orange aurora backdrop,
 * camera glyph in a glass ring, three-dot pulse — institutional feel.
 */
export default function InstagramRouteFallback({ label = 'Loading', subLabel }) {
  return (
    <div
      className="route-fallback ig-route-fallback relative flex h-full w-full items-center justify-center overflow-hidden"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {/* Base obsidian gradient */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 20% 0%, rgba(244,114,182,0.32) 0%, transparent 55%),' +
            'radial-gradient(ellipse at 80% 100%, rgba(245,158,11,0.28) 0%, transparent 55%),' +
            'linear-gradient(180deg, #0b0410 0%, #150620 60%, #1a0820 100%)',
        }}
      />

      {/* Subtle scanline grid for depth */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px),' +
            'linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      />

      <div className="relative flex flex-col items-center gap-6">
        {/* Concentric rings — outer rotates, inner reverses, glyph pulses */}
        <div className="relative h-20 w-20">
          {/* Outer halo */}
          <div
            className="absolute -inset-3 rounded-full opacity-70 blur-xl"
            style={{
              background:
                'conic-gradient(from 0deg, #f09433, #dc2743, #bc1888, #833ab4, #f09433)',
              animation: 'igHaloSpin 2.4s linear infinite',
            }}
          />
          {/* Static base ring */}
          <div className="absolute inset-0 rounded-full border-2 border-white/10" />
          {/* Brand spinner */}
          <div
            className="absolute inset-0 animate-spin rounded-full border-2 border-transparent"
            style={{
              borderTopColor: '#f472b6',
              borderRightColor: '#f59e0b',
              animationDuration: '1.1s',
            }}
          />
          {/* Reverse inner */}
          <div
            className="absolute inset-2 animate-spin rounded-full border-2 border-transparent"
            style={{
              borderBottomColor: '#ec4899',
              borderLeftColor: '#a855f7',
              animationDirection: 'reverse',
              animationDuration: '1.6s',
            }}
          />
          {/* Glass camera in the center */}
          <div className="absolute inset-[26%] flex items-center justify-center rounded-full bg-white/10 ring-1 ring-white/20 backdrop-blur-sm">
            <Camera className="h-5 w-5 text-pink-200" />
          </div>
        </div>

        <div className="flex flex-col items-center gap-2">
          <p className="text-sm font-semibold tracking-wide text-pink-50">
            {label}
          </p>
          {subLabel ? (
            <p className="text-[11px] uppercase tracking-[0.22em] text-pink-200/70">
              {subLabel}
            </p>
          ) : null}
          <div className="flex items-center gap-1.5">
            <span
              className="h-1.5 w-1.5 rounded-full bg-pink-300"
              style={{ animation: 'igDot 1s ease-in-out infinite' }}
            />
            <span
              className="h-1.5 w-1.5 rounded-full bg-pink-400"
              style={{ animation: 'igDot 1s ease-in-out infinite', animationDelay: '0.15s' }}
            />
            <span
              className="h-1.5 w-1.5 rounded-full bg-amber-300"
              style={{ animation: 'igDot 1s ease-in-out infinite', animationDelay: '0.3s' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
