'use client';

import { Check } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';

const COMMIT_FEATURES = ['Best value', 'Auto-renews every 6 months', 'Lower monthly equivalent'];
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
        <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-emerald-500/50 text-emerald-300 ring-1 ring-emerald-500/60">
          RECOMMENDED
        </Badge>
      )}

      <h3 className="text-foreground mb-1 text-center text-xl font-semibold">
        {isCommit ? 'Commit Plan' : 'Standard Plan'}
      </h3>
      <p className="text-muted-foreground mb-4 text-center text-sm">
        {isCommit ? '6 months' : 'Monthly'}
      </p>

      <div className="mb-6 text-center">
        <div className="text-foreground text-4xl font-bold">
          {isCommit ? '$8' : '$9'}
          <span className="text-muted-foreground text-lg font-normal">/month</span>
        </div>
        {!isCommit && (
          <div className="mt-2 text-sm font-medium text-emerald-400">$4 first month</div>
        )}
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
          {isPending ? 'Redirecting to Stripe…' : `Subscribe – ${isCommit ? '$48' : '$9'}`}
        </Button>
        <p className="text-muted-foreground mt-2 text-center text-xs">
          You&apos;ll be redirected to Stripe to pay
        </p>
      </div>
    </div>
  );
}

export function WelcomePage() {
  const trpc = useTRPC();
  const checkoutMutation = useMutation(trpc.kiloclaw.createSubscriptionCheckout.mutationOptions());

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

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="mb-10 text-center">
        <h1 className="text-foreground text-3xl font-bold">Welcome to KiloClaw 🦀</h1>
        <p className="text-muted-foreground mt-3 max-w-lg text-lg">
          Choose a plan to get started with KiloClaw.
        </p>
      </div>

      <div className="flex flex-wrap items-stretch justify-center gap-6">
        <PlanCard
          plan="commit"
          isPending={checkoutMutation.isPending}
          onSubscribe={() => handleSubscribe('commit')}
        />
        <PlanCard
          plan="standard"
          isPending={checkoutMutation.isPending}
          onSubscribe={() => handleSubscribe('standard')}
        />
      </div>
    </div>
  );
}
