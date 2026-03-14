'use client';

import { Check } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';

type WelcomePageProps = {
  trialEligible: boolean;
};

const COMMIT_FEATURES = ['Best value', '64% savings vs Standard', 'Save $96 over 6 months'];
const STANDARD_FEATURES = ['Cancel anytime', 'No commitment', 'Pay monthly'];

type PlanCardProps = {
  plan: 'commit' | 'standard';
  isPending: boolean;
  onSubscribe: () => void;
};

function PlanCard({ plan, isPending, onSubscribe }: PlanCardProps) {
  const isCommit = plan === 'commit';
  const features = isCommit ? COMMIT_FEATURES : STANDARD_FEATURES;

  return (
    <div
      className={cn(
        'relative flex w-72 flex-col rounded-lg border-2 p-6 text-left transition-all',
        'border-border bg-secondary hover:border-muted-foreground/30'
      )}
    >
      {isCommit && (
        <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20">
          RECOMMENDED
        </Badge>
      )}

      <h3 className="text-foreground mb-4 text-center text-xl font-semibold">
        {isCommit ? 'Commit Plan' : 'Standard Plan'}
      </h3>

      <div className="mb-6 text-center">
        <div className="text-foreground text-4xl font-bold">
          {isCommit ? '$9' : '$25'}
          <span className="text-muted-foreground text-lg font-normal">/month</span>
        </div>
        <div className="mt-1 min-h-[4rem]">
          {isCommit ? (
            <>
              <div className="text-sm text-emerald-400">$54 upfront for 6 months</div>
              <div className="text-muted-foreground mt-1 text-xs">
                Reverts to Standard ($25/mo) after 6 months unless you re-commit
              </div>
            </>
          ) : (
            <>
              <div className="text-muted-foreground text-sm">Billed monthly</div>
              <div className="text-muted-foreground mt-1 text-xs">
                No long-term commitment required
              </div>
            </>
          )}
        </div>
      </div>

      <ul className="mb-6 space-y-3">
        {features.map(feature => (
          <li key={feature} className="text-muted-foreground flex items-start gap-2 text-sm">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto">
        <Button
          onClick={onSubscribe}
          disabled={isPending}
          variant="primary"
          className="w-full py-4 font-semibold"
        >
          {isPending ? 'Redirecting to Stripe…' : 'Subscribe'}
        </Button>
        <p className="text-muted-foreground mt-2 text-center text-xs">
          You&apos;ll be redirected to Stripe to pay
        </p>
      </div>
    </div>
  );
}

export function WelcomePage({ trialEligible }: WelcomePageProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const startTrialMutation = useMutation(trpc.kiloclaw.startTrial.mutationOptions());
  const checkoutMutation = useMutation(trpc.kiloclaw.createSubscriptionCheckout.mutationOptions());

  async function handleStartTrial() {
    try {
      await startTrialMutation.mutateAsync();
      void queryClient.invalidateQueries({
        queryKey: trpc.kiloclaw.getBillingStatus.queryKey(),
      });
    } catch {
      toast.error('Failed to start trial. Please try again.');
    }
  }

  async function handleSubscribe(plan: 'commit' | 'standard') {
    try {
      const result = await checkoutMutation.mutateAsync({ plan });
      if (result.url) {
        window.location.href = result.url;
      }
    } catch {
      toast.error('Failed to start checkout. Please try again.');
    }
  }

  const anyPending = startTrialMutation.isPending || checkoutMutation.isPending;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="mb-10 text-center">
        <h1 className="text-foreground text-3xl font-bold">Welcome to KiloClaw 🦀</h1>
        <p className="text-muted-foreground mt-3 max-w-lg text-lg">
          {trialEligible
            ? 'Choose a plan to get started, or try it free first.'
            : 'Choose a plan to get started with KiloClaw.'}
        </p>
      </div>

      <div className="flex flex-wrap items-stretch justify-center gap-6">
        <PlanCard
          plan="commit"
          isPending={anyPending}
          onSubscribe={() => handleSubscribe('commit')}
        />
        <PlanCard
          plan="standard"
          isPending={anyPending}
          onSubscribe={() => handleSubscribe('standard')}
        />
      </div>

      {trialEligible && (
        <div className="mt-8 text-center">
          <Button
            onClick={handleStartTrial}
            disabled={anyPending}
            variant="link"
            className="text-base font-semibold"
          >
            {startTrialMutation.isPending ? 'Starting trial…' : 'Start free trial'}
          </Button>
          <p className="text-muted-foreground mt-1 text-sm">
            30 days free · No credit card required · Pick a plan when you&apos;re ready
          </p>
        </div>
      )}
    </div>
  );
}
