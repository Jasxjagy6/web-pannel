/**
 * PlatformToggle — segmented control in the header that flips the
 * active panel platform.
 *
 * Disabled platforms (e.g. Instagram before the feature flag is set)
 * are dimmed and unclickable. The active platform glows with the brand
 * gradient defined by platform-tokens.css so the user always has a
 * clear visual cue which world they're in.
 */

import { Send, Camera } from 'lucide-react';
import { usePlatform, PLATFORMS, PLATFORM_LABELS } from '../../context/PlatformContext';

const ICONS = {
  telegram: Send,
  instagram: Camera,
};

export default function PlatformToggle({ size = 'md' }) {
  const { platform, setPlatform, isEnabled } = usePlatform();

  const sizing = size === 'sm'
    ? { btn: 'px-2.5 py-1 text-[11px]', icon: 'h-3 w-3', gap: 'gap-1' }
    : { btn: 'px-3 py-1.5 text-xs', icon: 'h-3.5 w-3.5', gap: 'gap-1.5' };

  return (
    <div
      role="tablist"
      aria-label="Active panel"
      className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1"
    >
      {PLATFORMS.map((p) => {
        const Icon = ICONS[p];
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
              'inline-flex items-center rounded-full font-medium transition-colors',
              sizing.btn,
              sizing.gap,
              active
                ? 'brand-gradient text-white shadow ring-1 ring-white/10'
                : enabled
                  ? 'text-gray-300 hover:bg-white/10 hover:text-white'
                  : 'cursor-not-allowed text-gray-500/60',
            ].join(' ')}
            title={enabled ? `Switch to ${PLATFORM_LABELS[p]}` : `${PLATFORM_LABELS[p]} not enabled`}
          >
            <Icon className={sizing.icon} />
            <span>{PLATFORM_LABELS[p]}</span>
          </button>
        );
      })}
    </div>
  );
}
