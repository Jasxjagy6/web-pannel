import { lazy, Suspense } from 'react';
import InstagramRouteFallback from '../../components/instagram/InstagramRouteFallback';
import { Shield } from 'lucide-react';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';

const PrivacyShared = lazy(() => import('../Privacy'));

export default function InstagramPrivacy() {
  return (
    <InstagramFeatureShell
      icon={Shield}
      title="Privacy"
      subtitle="Control which data the panel keeps, exports, and erases for your Instagram accounts."
    >
      <Suspense fallback={<InstagramRouteFallback label="Loading" />}>
        <PrivacyShared />
      </Suspense>
    </InstagramFeatureShell>
  );
}
