'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type { TRPCClientErrorLike } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';
import type { PlatformRepository } from '@/lib/integrations/core/types';

type GitLabError = TRPCClientErrorLike<AnyRouter>;

type GitLabInstallation = {
  id: string;
  accountId: string | null;
  accountLogin: string | null;
  instanceUrl: string;
  repositories: PlatformRepository[] | null;
  repositoriesSyncedAt: string | null;
  installedAt: string;
  tokenExpiresAt: string | null;
};

export type GitLabInstallationResult = {
  installed: boolean;
  installation: GitLabInstallation | null;
};

/**
 * Query options are typed loosely to accommodate TRPC's specific queryOptions return types.
 * Type safety is enforced at the hook level via useQuery's return type inference.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompatibleQueryOptions = Parameters<typeof useQuery<any, any, any, any>>[0];

export type GitLabQueryOptions = {
  getInstallation: CompatibleQueryOptions;
};

export type GitLabMutations = {
  disconnect: UseMutationResult<{ success: boolean }, GitLabError, void>;
  refreshRepositories: UseMutationResult<
    { success: boolean; repositoryCount: number; syncedAt: string },
    GitLabError,
    { integrationId: string }
  >;
};

type GitLabContextValue = {
  queryOptions: GitLabQueryOptions;
  mutations: GitLabMutations;
};

const GitLabContext = createContext<GitLabContextValue | null>(null);

function useGitLabContext() {
  const context = useContext(GitLabContext);
  if (!context) {
    throw new Error('GitLab hooks must be used within a GitLabProvider');
  }
  return context;
}

/** Hook to access GitLab installation query */
export function useGitLabInstallation() {
  const { queryOptions } = useGitLabContext();
  return useQuery<GitLabInstallationResult, GitLabError>(queryOptions.getInstallation);
}

/** Hook to access GitLab mutations */
export function useGitLabMutations() {
  const { mutations } = useGitLabContext();
  return mutations;
}

/**
 * Base provider component that accepts query options and mutations
 */
export function GitLabProvider({
  queryOptions,
  mutations,
  children,
}: {
  queryOptions: GitLabQueryOptions;
  mutations: GitLabMutations;
  children: ReactNode;
}) {
  return (
    <GitLabContext.Provider value={{ queryOptions, mutations }}>{children}</GitLabContext.Provider>
  );
}
