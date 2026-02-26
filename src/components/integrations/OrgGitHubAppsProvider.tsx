'use client';

import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { GitHubAppsProvider } from './GitHubAppsContext';
import type {
  IntegrationQueryOptions,
  IntegrationMutations,
} from '@/lib/integrations/router-types';

type OrgGitHubAppsProviderProps = {
  organizationId: string;
  children: ReactNode;
};

export function OrgGitHubAppsProvider({ organizationId, children }: OrgGitHubAppsProviderProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const queryOptions: IntegrationQueryOptions = {
    listIntegrations: trpc.organizations.githubApps.listIntegrations.queryOptions({
      organizationId,
    }),

    getInstallation: trpc.organizations.githubApps.getInstallation.queryOptions({
      organizationId,
    }),

    checkUserPendingInstallation:
      trpc.organizations.githubApps.checkUserPendingInstallation.queryOptions({ organizationId }),

    listRepositories: (integrationId: string, forceRefresh?: boolean) => ({
      ...trpc.organizations.githubApps.listRepositories.queryOptions({
        organizationId,
        integrationId,
        forceRefresh: forceRefresh ?? false,
      }),
      enabled: !!integrationId,
    }),

    listBranches: (integrationId: string, repositoryFullName: string) => ({
      ...trpc.organizations.githubApps.listBranches.queryOptions({
        organizationId,
        integrationId,
        repositoryFullName,
      }),
      enabled: !!integrationId && !!repositoryFullName,
    }),
  };

  // Base mutations from TRPC
  const uninstallAppMutation = useMutation(
    trpc.organizations.githubApps.uninstallApp.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.githubApps.getInstallation.queryKey({ organizationId }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.githubApps.listIntegrations.queryKey({ organizationId }),
        });
      },
    })
  );

  const cancelPendingMutation = useMutation(
    trpc.organizations.githubApps.cancelPendingInstallation.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.githubApps.getInstallation.queryKey({ organizationId }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.githubApps.checkUserPendingInstallation.queryKey({
            organizationId,
          }),
        });
      },
    })
  );

  const refreshInstallationMutation = useMutation(
    trpc.organizations.githubApps.refreshInstallation.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.githubApps.getInstallation.queryKey({ organizationId }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.githubApps.listIntegrations.queryKey({ organizationId }),
        });
      },
    })
  );

  // Wrap mutations to match the IntegrationMutations interface
  const mutations: IntegrationMutations = {
    uninstallApp: {
      ...uninstallAppMutation,
      mutate: (_: void, options?: Parameters<typeof uninstallAppMutation.mutate>[1]) => {
        uninstallAppMutation.mutate({ organizationId }, options);
      },
      mutateAsync: async (
        _: void,
        options?: Parameters<typeof uninstallAppMutation.mutateAsync>[1]
      ) => {
        return uninstallAppMutation.mutateAsync({ organizationId }, options);
      },
    } as IntegrationMutations['uninstallApp'],

    cancelPendingInstallation: {
      ...cancelPendingMutation,
      mutate: (_: void, options?: Parameters<typeof cancelPendingMutation.mutate>[1]) => {
        cancelPendingMutation.mutate({ organizationId }, options);
      },
      mutateAsync: async (
        _: void,
        options?: Parameters<typeof cancelPendingMutation.mutateAsync>[1]
      ) => {
        return cancelPendingMutation.mutateAsync({ organizationId }, options);
      },
    } as IntegrationMutations['cancelPendingInstallation'],

    refreshInstallation: {
      ...refreshInstallationMutation,
      mutate: (_: void, options?: Parameters<typeof refreshInstallationMutation.mutate>[1]) => {
        refreshInstallationMutation.mutate({ organizationId }, options);
      },
      mutateAsync: async (
        _: void,
        options?: Parameters<typeof refreshInstallationMutation.mutateAsync>[1]
      ) => {
        return refreshInstallationMutation.mutateAsync({ organizationId }, options);
      },
    } as IntegrationMutations['refreshInstallation'],
  };

  return (
    <GitHubAppsProvider queryOptions={queryOptions} mutations={mutations}>
      {children}
    </GitHubAppsProvider>
  );
}
