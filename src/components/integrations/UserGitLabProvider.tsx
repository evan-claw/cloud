'use client';

import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { GitLabProvider, type GitLabQueryOptions } from './GitLabContext';

export function UserGitLabProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const queryOptions: GitLabQueryOptions = {
    getInstallation: trpc.gitlab.getInstallation.queryOptions(),
  };

  const mutations = {
    disconnect: useMutation(
      trpc.gitlab.disconnect.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.gitlab.getInstallation.queryKey(),
          });
        },
      })
    ),

    refreshRepositories: useMutation(
      trpc.gitlab.refreshRepositories.mutationOptions({
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: trpc.gitlab.getInstallation.queryKey(),
          });
        },
      })
    ),
  };

  return (
    <GitLabProvider queryOptions={queryOptions} mutations={mutations}>
      {children}
    </GitLabProvider>
  );
}
