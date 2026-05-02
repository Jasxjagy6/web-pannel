import { lazy, Suspense } from 'react';
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
      <Suspense fallback={<div className="text-sm text-pink-500">Loading 2FA settings…</div>}>
        <Change2FAShared />
      </Suspense>
    </InstagramFeatureShell>
  );
}
