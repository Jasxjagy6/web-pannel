/**
 * Cinematic overlay played whenever the user toggles between the
 * Telegram and Instagram panels. Mounted once at the App root so it
 * can play even mid-route-change. Listens for the
 * `panel:platform-switch` CustomEvent (dispatched by the platform
 * toggle buttons in either panel's header) and renders a full-screen
 * gradient + spinner for ~1.1s.
 */

import React, { useEffect, useState } from 'react';
import { Camera, Send } from 'lucide-react';

export default function PanelSwitchOverlay() {
  const [state, setState] = useState({ phase: 'idle', target: 'instagram' });

  useEffect(() => {
    function onSwitch(e) {
      const target = e?.detail?.target || 'instagram';
      setState({ phase: 'enter', target });
      window.setTimeout(() => setState((s) => ({ ...s, phase: 'exit' })), 700);
      window.setTimeout(() => setState({ phase: 'idle', target }), 1200);
    }
    window.addEventListener('panel:platform-switch', onSwitch);
    return () => window.removeEventListener('panel:platform-switch', onSwitch);
  }, []);

  if (state.phase === 'idle') return null;

  const isInstagram = state.target === 'instagram';
  const gradient = isInstagram
    ? 'bg-[radial-gradient(circle_at_30%_20%,#fbcfe8_0%,#fda4af_30%,#f472b6_55%,#a21caf_100%)]'
    : 'bg-[radial-gradient(circle_at_30%_20%,#bfdbfe_0%,#60a5fa_45%,#0088cc_100%)]';
  const Icon = isInstagram ? Camera : Send;
  const heading = isInstagram ? 'Switching to Instagram' : 'Switching to Telegram';
  const sub = isInstagram
    ? 'Loading the pink side of the panel…'
    : 'Loading the blue side of the panel…';

  return (
    <div
      className={[
        'fixed inset-0 z-[100] flex items-center justify-center transition-opacity duration-500',
        gradient,
        state.phase === 'enter' ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
      aria-hidden="true"
    >
      <div className="flex flex-col items-center gap-5 text-white drop-shadow-lg">
        <div className="relative h-20 w-20">
          <div className="absolute inset-0 rounded-full border-4 border-white/30" />
          <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-white" />
          <div className="absolute inset-0 flex items-center justify-center">
            <Icon className="h-8 w-8" />
          </div>
        </div>
        <div className="text-center">
          <div className="text-xl font-bold tracking-tight">{heading}</div>
          <div className="mt-1 text-sm text-white/85">{sub}</div>
        </div>
      </div>
    </div>
  );
}
