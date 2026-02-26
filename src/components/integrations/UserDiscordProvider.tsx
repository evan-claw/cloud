'use client';

import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { DiscordProvider, type DiscordQueryOptions, type DiscordMutations } from './DiscordContext';

export function UserDiscordProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const queryOptions: DiscordQueryOptions = {
    getInstallation: trpc.discord.getInstallation.queryOptions(),
    getOAuthUrl: trpc.discord.getOAuthUrl.queryOptions(),
  };

  const mutations: DiscordMutations = {
    uninstallApp: useMutation(
      trpc.discord.uninstallApp.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.discord.getInstallation.queryKey(),
          });
        },
      })
    ),

    testConnection: useMutation(trpc.discord.testConnection.mutationOptions()),

    devRemoveDbRowOnly: useMutation(
      trpc.discord.devRemoveDbRowOnly.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.discord.getInstallation.queryKey(),
          });
        },
      })
    ),
  };

  return (
    <DiscordProvider queryOptions={queryOptions} mutations={mutations}>
      {children}
    </DiscordProvider>
  );
}
