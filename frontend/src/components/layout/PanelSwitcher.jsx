/**
 * PanelSwitcher — three-way segmented control that flips between the
 * Telegram, Instagram, and Tracking panels.
 *
 * Telegram and Instagram are platforms in PlatformContext (they share
 * the automation feature-set and the /:platform/* routing tree).
 * Tracking is a standalone panel mounted at /tracking/* with its own
 * chrome, so switching to/from it is plain navigation rather than a
 * platform change. This control hides that distinction behind one
 * consistent switcher rendered in all three panel headers.
 */

import { Send, Camera, ClipboardList } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePlatform } from '../../context/PlatformContext';

const TARGETS = [
  { key: 'telegram',  Icon: Send,          label: 'Telegram',  grad: 'from-[#229ED9] to-[#0088cc]' },
  { key: 'instagram', Icon: Camera,        label: 'Instagram', grad: 'from-[#f09433] via-[#dc2743] to-[#bc1888]' },
  { key: 'tracking',  Icon: ClipboardList, label: 'Tracking',  grad: 'from-emerald-500 to-teal-600' },
];

export default function PanelSwitcher({ size = 'md' }) {
  const { platform, setPlatform, isEnabled } = usePlatform();
  const location = useLocation();
  const navigate = useNavigate();

  const onTracking = location.pathname.startsWith('/tracking');
  const active = onTracking ? 'tracking' : platform;

  const sizing = size === 'sm'
    ? { btn: 'px-2.5 py-1 text-[11px]', icon: 'h-3 w-3', gap: 'gap-1' }
    : { btn: 'px-3 py-1.5 text-xs', icon: 'h-3.5 w-3.5', gap: 'gap-1.5' };

  const go = (target) => {
    if (target === active) return;
    try {
      window.dispatchEvent(new CustomEvent('panel:platform-switch', { detail: { target } }));
    } catch (_) { /* SSR */ }
    if (target === 'tracking') {
      navigate('/tracking');
    } else if (onTracking) {
      // Leaving the standalone Tracking panel — go straight to the
      // target platform's dashboard; PlatformContext mirrors the URL
      // back into platform state via its pathname effect.
      navigate(`/${target}/dashboard`);
    } else {
      setPlatform(target);
    }
  };

  return (
    <div
      role="tablist"
      aria-label="Active panel"
      className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1"
    >
      {TARGETS.map(({ key, Icon, label, grad }) => {
        const enabled = key === 'tracking' ? true : isEnabled(key);
        const isActive = active === key;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={!enabled}
            onClick={() => go(key)}
            className={[
              'inline-flex items-center rounded-full font-medium transition-all duration-200',
              sizing.btn,
              sizing.gap,
              isActive
                ? `bg-gradient-to-r ${grad} text-white shadow ring-1 ring-white/20`
                : enabled
                  ? 'text-gray-300 hover:bg-white/10 hover:text-white'
                  : 'cursor-not-allowed text-gray-500/60',
            ].join(' ')}
            title={enabled ? `Switch to ${label}` : `${label} not enabled`}
          >
            <Icon className={sizing.icon} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
