'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/admin-utils';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

type Props = {
  userId: string;
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function UserAdminKiloclawEarlybird({ userId }: Props) {
  const trpc = useTRPC();
  const { data, isLoading, isError, refetch } = useQuery(
    trpc.admin.users.getKiloclawEarlybirdPurchase.queryOptions({
      kilo_user_id: userId,
    })
  );

  const purchase = data?.purchase;

  return (
    <Card className="max-h-max lg:col-span-2">
      <CardHeader>
        <CardTitle>KiloClaw Early Adopter</CardTitle>
      </CardHeader>
      <CardContent>
        {isError ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-600">Failed to load earlybird purchase</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        ) : isLoading ? (
          <p className="text-muted-foreground text-sm">Loading...</p>
        ) : !purchase ? (
          <p className="text-muted-foreground text-sm">No KiloClaw Early Adopter record found.</p>
        ) : (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">ID</dt>
            <dd className="font-mono text-xs">{purchase.id}</dd>

            <dt className="text-muted-foreground">Amount</dt>
            <dd>{formatCents(purchase.amount_cents)}</dd>

            {purchase.stripe_charge_id && (
              <>
                <dt className="text-muted-foreground">Stripe Charge</dt>
                <dd className="font-mono text-xs">{purchase.stripe_charge_id}</dd>
              </>
            )}

            {purchase.manual_payment_id && (
              <>
                <dt className="text-muted-foreground">Manual Payment</dt>
                <dd className="font-mono text-xs">{purchase.manual_payment_id}</dd>
              </>
            )}

            <dt className="text-muted-foreground">Purchased</dt>
            <dd>{formatDate(purchase.created_at)}</dd>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
