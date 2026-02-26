'use client';

import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { GitHubAppsProvider } from './GitHubAppsContext';
import type {
  IntegrationQueryOptions,
  IntegrationMutations,
} from '@/lib/integrations/router-types';

export function UserGitHubAppsProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const queryOptions: IntegrationQueryOptions = {
    listIntegrations: trpc.githubApps.listIntegrations.queryOptions(),

    getInstallation: trpc.githubApps.getInstallation.queryOptions(),

    checkUserPendingInstallation: trpc.githubApps.checkUserPendingInstallation.queryOptions(),

    listRepositories: (integrationId: string, forceRefresh?: boolean) => ({
      ...trpc.githubApps.listRepositories.queryOptions({
        integrationId,
        forceRefresh: forceRefresh ?? false,
      }),
      enabled: !!integrationId,
    }),

    listBranches: (integrationId: string, repositoryFullName: string) => ({
      ...trpc.githubApps.listBranches.queryOptions({
        integrationId,
        repositoryFullName,
      }),
      enabled: !!integrationId && !!repositoryFullName,
    }),
  };

  const mutations: IntegrationMutations = {
    uninstallApp: useMutation(
      trpc.githubApps.uninstallApp.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.githubApps.getInstallation.queryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: trpc.githubApps.listIntegrations.queryKey(),
          });
        },
      })
    ),

    cancelPendingInstallation: useMutation(
      trpc.githubApps.cancelPendingInstallation.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.githubApps.getInstallation.queryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: trpc.githubApps.checkUserPendingInstallation.queryKey(),
          });
        },
      })
    ),

    refreshInstallation: useMutation(
      trpc.githubApps.refreshInstallation.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.githubApps.getInstallation.queryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: trpc.githubApps.listIntegrations.queryKey(),
          });
        },
      })
    ),
  };

  return (
    <GitHubAppsProvider queryOptions={queryOptions} mutations={mutations}>
      {children}
    </GitHubAppsProvider>
  );
}
