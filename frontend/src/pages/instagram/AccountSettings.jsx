import { lazy, Suspense } from 'react';
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
      <Suspense fallback={<div className="text-sm text-pink-500">Loading account settings…</div>}>
        <AccountSettingsShared />
      </Suspense>
    </InstagramFeatureShell>
  );
}
