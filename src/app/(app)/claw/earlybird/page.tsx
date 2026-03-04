'use client';

import { useTRPC } from '@/lib/trpc/utils';
import { useMutation, useQuery } from '@tanstack/react-query';
import { PageLayout } from '@/components/PageLayout';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import Link from 'next/link';

export default function EarlybirdPage() {
  const trpc = useTRPC();
  const { data: earlybirdStatus } = useQuery(trpc.kiloclaw.getEarlybirdStatus.queryOptions());
  const alreadyPurchased = earlybirdStatus?.purchased === true;

  const checkoutMutation = useMutation(
    trpc.kiloclaw.createEarlybirdCheckoutSession.mutationOptions({
      onSuccess: result => {
        if (!result.url) {
          toast.error('Failed to create checkout session');
          return;
        }
        window.location.href = result.url;
      },
      onError: error => {
        toast.error(error.message || 'Failed to start checkout');
      },
    })
  );

  return (
    <PageLayout title="">
      <div className="flex justify-center pt-8">
        <Card className="group border-brand-primary/20 hover:border-brand-primary/40 hover:shadow-brand-primary/5 relative max-w-2xl overflow-hidden transition-all hover:shadow-lg">
          <div className="bg-brand-primary/10 group-hover:bg-brand-primary/20 absolute top-0 right-0 h-40 w-40 translate-x-10 -translate-y-10 rounded-full blur-2xl transition-all" />
          <div className="bg-brand-primary/5 group-hover:bg-brand-primary/10 absolute bottom-0 left-0 h-32 w-32 -translate-x-8 translate-y-8 rounded-full blur-2xl transition-all" />

          <CardHeader className="relative pb-4">
            <div className="flex items-center gap-3">
              <span className="text-3xl" role="img" aria-label="lobster">
                🦞
              </span>
              <CardTitle className="text-2xl">Presale: 50% Off for the First 1,000</CardTitle>
            </div>
            <span className="bg-brand-primary/15 text-brand-primary mt-2 w-fit rounded-full px-3 py-1 text-xs font-bold tracking-wide uppercase">
              Early Bird &mdash; 50% Off
            </span>
          </CardHeader>

          <CardContent className="relative flex flex-col gap-4">
            <p className="text-muted-foreground leading-relaxed">
              To thank those of you who have been early adopters, we&apos;re offering the first
              1,000 users 6 months of KiloClaw hosting at 50% off. That&apos;s{' '}
              <span className="text-brand-primary font-semibold">$150 total</span> &mdash; works out
              to <span className="text-brand-primary font-semibold">$25/month</span> instead of $49.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              The discount applies to hosting only, not inference. At $25/month for a hosted AI
              agent, that&apos;s hard to beat. 🦀
            </p>
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-center text-sm font-medium text-amber-600 dark:text-amber-400">
              ⚠ All early bird purchases are final. No refunds will be issued.
            </p>
          </CardContent>

          <CardFooter className="relative pt-2">
            {alreadyPurchased ? (
              <div className="flex w-full flex-col items-center gap-2">
                <p className="text-sm font-medium text-green-600 dark:text-green-400">
                  You&apos;ve already purchased the early bird offer.
                </p>
                <Button variant="outline" size="lg" className="w-full" asChild>
                  <Link href="/claw">Back to KiloClaw</Link>
                </Button>
              </div>
            ) : (
              <Button
                className="bg-brand-primary hover:text-brand-primary hover:ring-brand-primary w-full text-black hover:bg-black hover:ring-2"
                size="lg"
                disabled={checkoutMutation.isPending || !earlybirdStatus}
                onClick={() => checkoutMutation.mutate()}
              >
                {checkoutMutation.isPending
                  ? 'Redirecting to checkout...'
                  : '🦞 Get the Early Bird Offer'}
              </Button>
            )}
          </CardFooter>
        </Card>

        {/* Credit Options Note */}
        <div className="mt-6 max-w-2xl rounded-lg border border-border bg-muted/50 p-4">
          <h3 className="mb-3 text-center text-sm font-semibold">
            Credits are not included with your hosting subscription. Use what works best for you.
          </h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-md border border-border bg-background/50 p-3">
              <h4 className="text-sm font-medium">Kilo Pass</h4>
              <p className="text-muted-foreground mt-1 text-xs">
                Credit subscription with bonus credits.{' '}
                <a
                  href="https://kilo.ai/features/kilo-pass"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-primary hover:underline"
                >
                  Learn more
                </a>
              </p>
            </div>
            <div className="rounded-md border border-border bg-background/50 p-3">
              <h4 className="text-sm font-medium">Pay-as-you-go</h4>
              <p className="text-muted-foreground mt-1 text-xs">
                Purchase credits as needed. Only pay for what you use with no commitments.{' '}
                <a
                  href="https://app.kilo.ai/credits"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-primary hover:underline"
                >
                  Learn more
                </a>
              </p>
            </div>
            <div className="rounded-md border border-border bg-background/50 p-3">
              <h4 className="text-sm font-medium">Bring Your Own Key</h4>
              <p className="text-muted-foreground mt-1 text-xs">
                Use API keys from your existing AI provider accounts.{' '}
                <a
                  href="https://kilo.ai/docs/getting-started/byok"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-primary hover:underline"
                >
                  Learn more
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
