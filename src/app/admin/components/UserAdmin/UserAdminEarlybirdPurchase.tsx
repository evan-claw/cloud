import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bird } from 'lucide-react';
import { formatDate } from '@/lib/admin-utils';
import type { KiloClawEarlybirdPurchase } from '@kilocode/db/schema';

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function UserAdminEarlybirdPurchase({
  earlybirdPurchase,
}: {
  earlybirdPurchase: KiloClawEarlybirdPurchase | null;
}) {
  if (!earlybirdPurchase) {
    return (
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bird className="h-5 w-5" /> KiloClaw Earlybird
          </CardTitle>
          <CardDescription>No earlybird purchase record found</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const isBackloaded = !earlybirdPurchase.stripe_charge_id;

  return (
    <Card className={`lg:col-span-2 ${isBackloaded ? 'border-yellow-700' : ''}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bird className="h-5 w-5" /> KiloClaw Earlybird
        </CardTitle>
        <CardDescription>Earlybird purchase details</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <h4 className="text-muted-foreground text-xs font-medium">Amount</h4>
            <p className="font-mono text-sm font-semibold">
              {formatCents(earlybirdPurchase.amount_cents)}
            </p>
          </div>
          <div>
            <h4 className="text-muted-foreground text-xs font-medium">Purchased</h4>
            <p className="text-sm">{formatDate(earlybirdPurchase.created_at)}</p>
          </div>
          <div>
            <h4 className="text-muted-foreground text-xs font-medium">Stripe Charge</h4>
            {earlybirdPurchase.stripe_charge_id ? (
              <p className="font-mono text-sm break-all">{earlybirdPurchase.stripe_charge_id}</p>
            ) : (
              <Badge className="bg-yellow-900/20 text-yellow-400">
                Missing — backloaded user
              </Badge>
            )}
          </div>
          <div>
            <h4 className="text-muted-foreground text-xs font-medium">Manual Payment</h4>
            {earlybirdPurchase.manual_payment_id ? (
              <p className="font-mono text-sm break-all">{earlybirdPurchase.manual_payment_id}</p>
            ) : (
              <p className="text-muted-foreground text-sm">—</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
