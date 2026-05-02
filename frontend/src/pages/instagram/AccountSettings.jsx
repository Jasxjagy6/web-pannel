import { lazy, Suspense } from 'react';
import InstagramRouteFallback from '../../components/instagram/InstagramRouteFallback';
import { UserCog } from 'lucide-react';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';

const AccountSettingsShared = lazy(() => import('../AccountSettings'));

export default function InstagramAccountSettings() {
  return (
    <InstagramFeatureShell
      icon={UserCog}
      title="Account settings"
      subtitle="Update your panel email, password, and notification preferences."
    >
      <Suspense fallback={<InstagramRouteFallback label="Loading" />}>
        <AccountSettingsShared />
      </Suspense>
    </InstagramFeatureShell>
  );
}
