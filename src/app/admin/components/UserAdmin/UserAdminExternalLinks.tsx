import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SquareArrowOutUpRight } from 'lucide-react';
import type { UserDetailProps } from '@/types/admin';
import { createHash } from 'crypto';

function getGravatarUrl(email: string, size: number = 80): string {
  const hash = createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=mp`;
}

export function UserAdminExternalLinks({
  stripe_customer_id,
  google_user_email,
  google_user_name,
}: UserDetailProps) {
  const gravatarUrl = getGravatarUrl(google_user_email);

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>External Links </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <a
              href={`https://dashboard.stripe.com/${process.env.NODE_ENV === 'development' ? 'test/' : ''}customers/${stripe_customer_id}`}
              target="_blank"
              className="inline-flex items-center justify-between gap-2 rounded-md bg-purple-950 px-4 py-3 text-sm font-medium text-purple-200 transition-colors hover:bg-purple-900"
            >
              View in Stripe
              <SquareArrowOutUpRight size={16} />
            </a>

            <a
              href={`https://haveibeenpwned.com/account/${encodeURIComponent(google_user_email)}`}
              target="_blank"
              className="inline-flex items-center justify-between gap-2 rounded-md bg-orange-950 px-4 py-3 text-sm font-medium text-orange-200 transition-colors hover:bg-orange-900"
              title="Check if this email has been exposed in any data breaches"
            >
              <span className="flex items-center gap-2">Check on Have I Been Pwned</span>
              <SquareArrowOutUpRight size={16} />
            </a>

            <a
              href={`https://sentry.io/organizations/${process.env.SENTRY_ORG ?? 'kilo-code'}/issues/?query=user.email:${encodeURIComponent(google_user_email)}`}
              target="_blank"
              className="inline-flex items-center justify-between gap-2 rounded-md bg-red-950 px-4 py-3 text-sm font-medium text-red-200 transition-colors hover:bg-red-900"
              title="View Sentry issues for this user"
            >
              View in Sentry
              <SquareArrowOutUpRight size={16} />
            </a>

            <a
              href={`https://us.posthog.com/project/${process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID ?? '141915'}/persons?search=${encodeURIComponent(google_user_email)}`}
              target="_blank"
              className="inline-flex items-center justify-between gap-2 rounded-md bg-blue-950 px-4 py-3 text-sm font-medium text-blue-200 transition-colors hover:bg-blue-900"
              title="View PostHog person profile for this user"
            >
              View in PostHog
              <SquareArrowOutUpRight size={16} />
            </a>

            <a
              href={`https://app.usepylon.com/customers?search=${encodeURIComponent(google_user_email)}`}
              target="_blank"
              className="inline-flex items-center justify-between gap-2 rounded-md bg-emerald-950 px-4 py-3 text-sm font-medium text-emerald-200 transition-colors hover:bg-emerald-900"
              title="View Pylon customer profile for this user"
            >
              View in Pylon
              <SquareArrowOutUpRight size={16} />
            </a>
            <div className="bg-background flex items-center gap-3 rounded-md p-3">
              <div className="flex-1">
                <p className="text-foreground text-sm font-medium">Gravatar</p>
                <p className="text-muted-foreground truncate text-xs">{google_user_email}</p>
              </div>
              <img
                src={gravatarUrl}
                alt={`Gravatar for ${google_user_name}`}
                className="border-border h-16 w-16 rounded-full border-2"
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
