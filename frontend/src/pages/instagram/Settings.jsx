import { lazy, Suspense } from 'react';
import InstagramRouteFallback from '../../components/instagram/InstagramRouteFallback';
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
      <Suspense fallback={<InstagramRouteFallback label="Loading" />}>
        <SettingsShared />
      </Suspense>
    </InstagramFeatureShell>
  );
}
