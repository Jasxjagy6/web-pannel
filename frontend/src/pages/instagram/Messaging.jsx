import { lazy, Suspense } from 'react';
import InstagramRouteFallback from '../../components/instagram/InstagramRouteFallback';
import { MessageCircle } from 'lucide-react';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';

const MessagingShared = lazy(() => import('../Messaging'));

export default function InstagramMessaging() {
  return (
    <InstagramFeatureShell
      icon={MessageCircle}
      title="Direct messages"
      subtitle="Bulk DM campaigns from your Instagram accounts. Use lists from the Saved lists page."
    >
      <Suspense fallback={<InstagramRouteFallback label="Loading" />}>
        <MessagingShared />
      </Suspense>
    </InstagramFeatureShell>
  );
}
