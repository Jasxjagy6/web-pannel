import { lazy, Suspense } from 'react';
import InstagramRouteFallback from '../../components/instagram/InstagramRouteFallback';
import { Fingerprint } from 'lucide-react';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';

const AntiDetectShared = lazy(() => import('../AntiDetect'));

export default function InstagramAntiDetect() {
  return (
    <InstagramFeatureShell
      icon={Fingerprint}
      title="Identity & device"
      subtitle="Per-account device fingerprint, user agent, and timezone. Stable identities = stable cookies."
    >
      <Suspense fallback={<InstagramRouteFallback label="Loading" />}>
        <AntiDetectShared />
      </Suspense>
    </InstagramFeatureShell>
  );
}
