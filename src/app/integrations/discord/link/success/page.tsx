import { KiloCardLayout } from '@/components/KiloCardLayout';
import { CheckCircle2 } from 'lucide-react';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';

export default async function DiscordLinkSuccessPage() {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/integrations/discord/link/success');

  return (
    <KiloCardLayout
      className="max-w-xl"
      contentClassName="flex flex-col items-center gap-6 py-12 text-center"
    >
      <CheckCircle2 className="h-20 w-20 text-green-600" />
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Discord account linked</h1>
        <p className="text-muted-foreground text-lg">
          Your account is now linked to Kilo. You can close this tab and return to Discord.
        </p>
      </div>
    </KiloCardLayout>
  );
}
