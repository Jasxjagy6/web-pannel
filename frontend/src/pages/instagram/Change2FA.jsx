import { lazy, Suspense } from 'react';
import InstagramRouteFallback from '../../components/instagram/InstagramRouteFallback';
import { ShieldCheck } from 'lucide-react';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';

const Change2FAShared = lazy(() => import('../Change2FA'));

export default function InstagramChange2FA() {
  return (
    <InstagramFeatureShell
      icon={ShieldCheck}
      title="Two-factor authentication"
      subtitle="Enroll, rotate, or disable 2FA on your panel account."
    >
      <Suspense fallback={<InstagramRouteFallback label="Loading" />}>
        <Change2FAShared />
      </Suspense>
    </InstagramFeatureShell>
  );
}
