'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';

type ClawPlan = 'commit' | 'standard';

type PlanSelectionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const COMMIT_FEATURES = ['Best value', '64% savings vs Standard', 'Save $96 over 6 months'];
const STANDARD_FEATURES = ['Cancel anytime', 'No commitment', 'Pay monthly'];

function PlanCard({
  plan,
  isSelected,
  onSelect,
}: {
  plan: ClawPlan;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const isCommit = plan === 'commit';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative w-72 cursor-pointer rounded-lg border-2 p-6 text-left transition-all',
        isSelected
          ? 'border-blue-500/30 bg-blue-500/10'
          : 'border-border bg-secondary hover:border-muted-foreground/30 opacity-50'
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
          {isCommit ? '$9' : '$25'}
          <span className="text-muted-foreground text-lg font-normal">/month</span>
        </div>
      </div>

      <ul className="mb-6 space-y-3">
        {(isCommit ? COMMIT_FEATURES : STANDARD_FEATURES).map(feature => (
          <li key={feature} className="text-muted-foreground flex items-start gap-2 text-sm">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <div
        className={cn(
          'flex items-center justify-center gap-2 text-sm font-medium text-blue-400',
          !isSelected && 'invisible'
        )}
      >
        <Check className="h-4 w-4" />
        Selected
      </div>
    </button>
  );
}

export function PlanSelectionDialog({ open, onOpenChange }: PlanSelectionDialogProps) {
  const [selectedPlan, setSelectedPlan] = useState<ClawPlan>('commit');
  const trpc = useTRPC();
  const checkout = useMutation(trpc.kiloclaw.createSubscriptionCheckout.mutationOptions());

  const planName = selectedPlan === 'commit' ? 'Commit' : 'Standard';

  async function handlePurchase() {
    const result = await checkout.mutateAsync({ plan: selectedPlan });
    if (result.url) {
      window.location.href = result.url;
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={true} className="sm:max-w-2xl">
        <div className="space-y-6">
          <div className="text-center">
            <DialogTitle className="text-foreground text-2xl font-bold">
              Choose Your KiloClaw Plan
            </DialogTitle>
            <p className="text-muted-foreground mt-2">
              Select a plan to keep your KiloClaw instance running
            </p>
          </div>

          <div className="flex justify-center gap-4">
            <PlanCard
              plan="commit"
              isSelected={selectedPlan === 'commit'}
              onSelect={() => setSelectedPlan('commit')}
            />
            <PlanCard
              plan="standard"
              isSelected={selectedPlan === 'standard'}
              onSelect={() => setSelectedPlan('standard')}
            />
          </div>

          <div className="flex flex-col items-center gap-3">
            <Button
              onClick={handlePurchase}
              disabled={checkout.isPending}
              variant="primary"
              className="w-full max-w-md py-4 text-lg font-semibold"
            >
              {checkout.isPending
                ? 'Redirecting to Stripe…'
                : `Subscribe to ${planName} Plan – ${selectedPlan === 'commit' ? '$54' : '$25'}`}
            </Button>
            <p className="text-muted-foreground text-center text-xs">
              You&apos;ll be redirected to Stripe to pay
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
