import { lazy, Suspense } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';

const SettingsShared = lazy(() => import('../Settings'));

export default function InstagramSettings() {
  return (
    <InstagramFeatureShell
      icon={SettingsIcon}
      title="Panel settings"
      subtitle="Theme, locale, browser session preferences and per-platform defaults."
    >
      <Suspense fallback={<div className="text-sm text-pink-500">Loading settings…</div>}>
        <SettingsShared />
      </Suspense>
    </InstagramFeatureShell>
  );
}
