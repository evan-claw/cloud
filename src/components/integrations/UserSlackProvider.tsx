'use client';

import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { SlackProvider, type SlackQueryOptions, type SlackMutations } from './SlackContext';

export function UserSlackProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const queryOptions: SlackQueryOptions = {
    getInstallation: trpc.slack.getInstallation.queryOptions(),
    getOAuthUrl: trpc.slack.getOAuthUrl.queryOptions(),
  };

  const mutations: SlackMutations = {
    uninstallApp: useMutation(
      trpc.slack.uninstallApp.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.slack.getInstallation.queryKey(),
          });
        },
      })
    ),

    testConnection: useMutation(trpc.slack.testConnection.mutationOptions()),

    sendTestMessage: useMutation(trpc.slack.sendTestMessage.mutationOptions()),

    updateModel: useMutation(
      trpc.slack.updateModel.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.slack.getInstallation.queryKey(),
          });
        },
      })
    ),

    devRemoveDbRowOnly: useMutation(
      trpc.slack.devRemoveDbRowOnly.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.slack.getInstallation.queryKey(),
          });
        },
      })
    ),
  };

  return (
    <SlackProvider queryOptions={queryOptions} mutations={mutations}>
      {children}
    </SlackProvider>
  );
}
