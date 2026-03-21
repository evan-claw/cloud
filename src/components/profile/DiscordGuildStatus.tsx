'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle2, XCircle, Shield, Loader2 } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { format } from 'date-fns';

type DiscordGuildStatusProps = {
  hasDiscordLinked: boolean;
};

export function DiscordGuildStatus({ hasDiscordLinked }: DiscordGuildStatusProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const autoVerifiedRef = useRef(false);

  const guildStatus = useQuery({
    ...trpc.user.getDiscordGuildStatus.queryOptions(),
    enabled: hasDiscordLinked,
  });

  const verifyMutation = useMutation({
    ...trpc.user.verifyDiscordGuildMembership.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: trpc.user.getDiscordGuildStatus.queryKey(),
      });
    },
  });

  const { mutate: verifyMutate } = verifyMutation;

  const data = guildStatus.data;
  const isMember = data?.discord_server_membership_verified_at != null;

  // Auto-verify guild membership when Discord is first linked
  useEffect(() => {
    if (hasDiscordLinked && data?.linked && !isMember && !autoVerifiedRef.current) {
      autoVerifiedRef.current = true;
      verifyMutate();
    }
  }, [hasDiscordLinked, data?.linked, isMember, verifyMutate]);

  return (
    <Card className="w-full rounded-xl shadow-sm">
      <CardContent className="pt-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Shield className="text-muted-foreground h-5 w-5 shrink-0" />
            <div>
              {!hasDiscordLinked && (
                <p className="text-muted-foreground text-sm">
                  Link your Discord account to verify{' '}
                  <a
                    href="https://discord.gg/GTPgzUvJ2t"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground underline"
                  >
                    Kilo server
                  </a>{' '}
                  membership.
                </p>
              )}

              {hasDiscordLinked && !isMember && !guildStatus.isLoading && verifyMutation.isIdle && (
                <p className="text-sm font-medium">Discord Server Membership</p>
              )}

              {hasDiscordLinked && guildStatus.isLoading && (
                <p className="text-muted-foreground text-sm">Loading Discord status…</p>
              )}

              {hasDiscordLinked && isMember && data.discord_server_membership_verified_at && (
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
                  <span className="text-sm font-medium text-green-700 dark:text-green-400">
                    Kilo Discord Member
                  </span>
                  <span className="text-muted-foreground text-xs">
                    · Verified {format(new Date(data.discord_server_membership_verified_at), 'MMM d, yyyy')}
                  </span>
                </div>
              )}

              {hasDiscordLinked && !isMember && !verifyMutation.isIdle && (
                <div className="flex items-center gap-2">
                  <XCircle className="text-muted-foreground h-4 w-4 shrink-0" />
                  <span className="text-muted-foreground text-sm">
                    Not a member of the{' '}
                    <a
                      href="https://discord.gg/GTPgzUvJ2t"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-foreground underline"
                    >
                      Kilo Discord server
                    </a>
                  </span>
                </div>
              )}
            </div>
          </div>

          {hasDiscordLinked && !isMember && !guildStatus.isLoading && !verifyMutation.isIdle && (
            <Button
              variant="outline"
              size="sm"
              disabled={verifyMutation.isPending}
              onClick={() => verifyMutation.mutate()}
            >
              {verifyMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Re-verify
            </Button>
          )}

          {hasDiscordLinked && !isMember && !guildStatus.isLoading && verifyMutation.isIdle && (
            <Button
              variant="outline"
              size="sm"
              disabled={verifyMutation.isPending}
              onClick={() => verifyMutation.mutate()}
            >
              {verifyMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Verify Kilo Discord Membership
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
