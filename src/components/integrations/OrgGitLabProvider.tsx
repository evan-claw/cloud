'use client';

import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { GitLabProvider, type GitLabQueryOptions, type GitLabMutations } from './GitLabContext';

type OrgGitLabProviderProps = {
  organizationId: string;
  children: ReactNode;
};

export function OrgGitLabProvider({ organizationId, children }: OrgGitLabProviderProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const queryOptions: GitLabQueryOptions = {
    getInstallation: {
      ...trpc.gitlab.getIntegration.queryOptions({ organizationId }),
      select: (data: {
        connected: boolean;
        integration: {
          id: string;
          accountId: string | null;
          accountLogin: string | null;
          instanceUrl: string;
          repositories: import('@/lib/integrations/core/types').PlatformRepository[] | null;
          repositoriesSyncedAt: string | null;
          installedAt: string;
          tokenExpiresAt: string | null;
        } | null;
      }) => ({
        installed: data.connected,
        installation: data.integration
          ? {
              id: data.integration.id,
              accountId: data.integration.accountId,
              accountLogin: data.integration.accountLogin,
              instanceUrl: data.integration.instanceUrl,
              repositories: data.integration.repositories,
              repositoriesSyncedAt: data.integration.repositoriesSyncedAt,
              installedAt: data.integration.installedAt,
              tokenExpiresAt: data.integration.tokenExpiresAt ?? null,
            }
          : null,
      }),
    },
  };

  const disconnectOrgMutation = useMutation(
    trpc.gitlab.disconnectOrg.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gitlab.getIntegration.queryKey({ organizationId }),
        });
      },
    })
  );

  const refreshRepositoriesMutation = useMutation(
    trpc.gitlab.refreshRepositories.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gitlab.getIntegration.queryKey({ organizationId }),
        });
      },
    })
  );

  const mutations: GitLabMutations = {
    disconnect: {
      ...disconnectOrgMutation,
      mutate: (_: void, options?: Parameters<typeof disconnectOrgMutation.mutate>[1]) => {
        disconnectOrgMutation.mutate({ organizationId }, options);
      },
      mutateAsync: async (
        _: void,
        options?: Parameters<typeof disconnectOrgMutation.mutateAsync>[1]
      ) => {
        return disconnectOrgMutation.mutateAsync({ organizationId }, options);
      },
    } as GitLabMutations['disconnect'],

    refreshRepositories: {
      ...refreshRepositoriesMutation,
      mutate: (
        input: { integrationId: string },
        options?: Parameters<typeof refreshRepositoriesMutation.mutate>[1]
      ) => {
        refreshRepositoriesMutation.mutate(
          { organizationId, integrationId: input.integrationId },
          options
        );
      },
      mutateAsync: async (
        input: { integrationId: string },
        options?: Parameters<typeof refreshRepositoriesMutation.mutateAsync>[1]
      ) => {
        return refreshRepositoriesMutation.mutateAsync(
          { organizationId, integrationId: input.integrationId },
          options
        );
      },
    } as GitLabMutations['refreshRepositories'],
  };

  return (
    <GitLabProvider queryOptions={queryOptions} mutations={mutations}>
      {children}
    </GitLabProvider>
  );
}
