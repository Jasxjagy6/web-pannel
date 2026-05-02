import { lazy, Suspense } from 'react';
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
      <Suspense fallback={<div className="text-sm text-pink-500">Loading privacy controls…</div>}>
        <PrivacyShared />
      </Suspense>
    </InstagramFeatureShell>
  );
}
