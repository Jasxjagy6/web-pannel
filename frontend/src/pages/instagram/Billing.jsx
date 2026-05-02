import { lazy, Suspense } from 'react';
import InstagramRouteFallback from '../../components/instagram/InstagramRouteFallback';
import { CreditCard } from 'lucide-react';
import InstagramFeatureShell from '../../components/instagram/InstagramFeatureShell';

const BillingShared = lazy(() => import('../Billing'));

export default function InstagramBilling() {
  return (
    <InstagramFeatureShell
      icon={CreditCard}
      title="Billing & subscription"
      subtitle="Your Instagram-side trial, plan and crypto invoices."
    >
      <Suspense fallback={<InstagramRouteFallback label="Loading" />}>
        <BillingShared />
      </Suspense>
    </InstagramFeatureShell>
  );
}
