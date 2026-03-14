'use client';

import { Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { ClawDashboard, withStatusQueryBoundary } from './components';
import { WelcomePage } from './components/billing/WelcomePage';

const ClawDashboardWithBoundary = withStatusQueryBoundary(ClawDashboard);

/**
 * Inner component that owns the KiloClaw worker status polling.
 * Extracted so the hook only runs when the user actually has access
 * (new users on the WelcomePage don't have an instance to poll).
 */
function ClawDashboardLoader() {
  const statusQuery = useKiloClawStatus();
  return <ClawDashboardWithBoundary statusQuery={statusQuery} />;
}

export default function ClawPage() {
  const trpc = useTRPC();
  const billingQuery = useQuery(trpc.kiloclaw.getBillingStatus.queryOptions());

  if (billingQuery.isLoading) {
    return (
      <div
        className="container m-auto flex w-full max-w-[1140px] items-center justify-center p-4 md:p-6"
        style={{ minHeight: '50vh' }}
      >
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  // Treat billing fetch errors as a blocked state so transient failures
  // never accidentally expose the dashboard to suspended/expired users.
  if (billingQuery.isError) {
    return (
      <div
        className="container m-auto flex w-full max-w-[1140px] items-center justify-center p-4 md:p-6"
        style={{ minHeight: '50vh' }}
      >
        <p className="text-destructive text-sm">
          Unable to load billing status. Please refresh the page or try again later.
        </p>
      </div>
    );
  }

  // Brand-new user with no access and no instance (never provisioned) —
  // show welcome page without waiting for the KiloClaw Worker.
  // Expired earlybird/trial users must NOT land here even if they never
  // provisioned; they proceed to ClawDashboard where AccessLockedDialog
  // shows the appropriate locked state.
  const billing = billingQuery.data;
  const isNewUser =
    billing &&
    !billing.hasAccess &&
    billing.instance === null &&
    !billing.earlybird &&
    !billing.trial?.expired;
  if (isNewUser) {
    return (
      <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
        <WelcomePage trialEligible={billing.trialEligible} />
      </div>
    );
  }

  return <ClawDashboardLoader />;
}
