'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Loader2, CheckCircle2 } from 'lucide-react';

export function KiloClawCheckoutSuccessClient() {
  const router = useRouter();
  const trpc = useTRPC();
  const [timedOut, setTimedOut] = useState(false);

  const { data: billingStatus } = useQuery({
    ...trpc.kiloclaw.getBillingStatus.queryOptions(),
    refetchInterval: timedOut ? false : 1_000,
  });

  const isActive = billingStatus?.subscription?.status === 'active';

  useEffect(() => {
    if (!isActive) return;
    const timer = setTimeout(() => router.push('/claw'), 2_000);
    return () => clearTimeout(timer);
  }, [isActive, router]);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 30_000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        {isActive ? (
          <>
            <CheckCircle2 className="text-brand-primary mx-auto mb-4 size-12" />
            <h1 className="mb-2 text-2xl font-bold">Subscription Active!</h1>
            <p className="text-muted-foreground">Redirecting to your dashboard...</p>
          </>
        ) : timedOut ? (
          <>
            <h1 className="mb-2 text-2xl font-bold">Taking longer than expected</h1>
            <p className="text-muted-foreground mb-4">
              Your payment was received. It may take a moment to activate.
            </p>
            <button
              type="button"
              onClick={() => router.push('/claw')}
              className="bg-brand-primary text-primary-foreground rounded-lg px-6 py-2 font-medium"
            >
              Go to Dashboard
            </button>
          </>
        ) : (
          <>
            <Loader2 className="text-brand-primary mx-auto mb-4 size-12 animate-spin" />
            <h1 className="mb-2 text-2xl font-bold">Setting up your subscription...</h1>
            <p className="text-muted-foreground">This usually takes just a moment.</p>
          </>
        )}
      </div>
    </div>
  );
}
