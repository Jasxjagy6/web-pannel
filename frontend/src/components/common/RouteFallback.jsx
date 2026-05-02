import React from 'react';

/**
 * RouteFallback — themed loading screen shown by React.Suspense while a
 * lazy-loaded route's chunk is being fetched.
 *
 * The previous fallback was a plain "Loading…" line on the parent layout
 * background, which produced a jarring white-ish flash for ~1s every
 * time the user moved between sidebar entries. This component replaces
 * that with a calm, branded screen that:
 *
 *   * matches the panel's dark theme (no white flash);
 *   * pulses the brand color (Telegram blue / Instagram gradient,
 *     resolved at runtime from CSS variables in platform-tokens.css)
 *     so the animation flips automatically when the user toggles
 *     platforms;
 *   * fills the host container without forcing a fixed full-screen
 *     overlay, so it lives inside <main> (or wherever Suspense is
 *     mounted) instead of stealing focus from the rest of the panel.
 *
 * No props — keep it simple; the spinner color is purely CSS-driven.
 */
export default function RouteFallback({ label = 'Loading' }) {
  return (
    <div
      className="route-fallback relative flex h-full w-full items-center justify-center overflow-hidden bg-dark-950"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {/* Soft gradient halo behind the spinner. The brand-* colors come
          from CSS variables that flip with html[data-platform=…], so
          this halo automatically matches the active platform. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, rgba(var(--brand-500-rgb, 0, 136, 204), 0.18) 0%, transparent 60%)',
        }}
      />

      {/* Subtle scanline / grid texture so the background has depth even
          on cheap displays where the radial gradient banding is visible. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px),' +
            'linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      />

      <div className="relative flex flex-col items-center gap-5">
        {/* Concentric ring spinner — outer ring is the brand color via
            border-brand-500, inner ring is dark-700 so the rotating gap
            reads cleanly on the dark canvas. */}
        <div className="relative h-16 w-16">
          <div className="absolute inset-0 rounded-full border-2 border-dark-700" />
          <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-brand-500 border-r-brand-500" />
          <div
            className="absolute inset-2 animate-spin rounded-full border-2 border-transparent border-b-brand-400 border-l-brand-400"
            style={{ animationDirection: 'reverse', animationDuration: '1.5s' }}
          />
          {/* Soft brand pulse in the center so the eye gets a gentle
              focus point even before the spinner begins moving. */}
          <div className="absolute inset-[26%] rounded-full bg-brand-500/30 animate-pulse" />
        </div>

        <div className="flex flex-col items-center gap-2">
          <p className="text-sm font-medium text-dark-100 tracking-wide">
            {label}
          </p>
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="h-1.5 w-1.5 rounded-full bg-brand-400 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="h-1.5 w-1.5 rounded-full bg-brand-300 animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
