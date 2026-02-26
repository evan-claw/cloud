'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  IntegrationQueryOptions,
  IntegrationMutations,
  IntegrationError,
  InstallationResponse,
  PendingCheckResponse,
  ListRepositoriesResponse,
  ListBranchesResponse,
} from '@/lib/integrations/router-types';
import type { PlatformIntegration } from '@/db/schema';

type GitHubAppsContextValue = {
  queryOptions: IntegrationQueryOptions;
  mutations: IntegrationMutations;
};

const GitHubAppsContext = createContext<GitHubAppsContextValue | null>(null);

function useGitHubAppsContext() {
  const context = useContext(GitHubAppsContext);
  if (!context) {
    throw new Error('GitHub Apps hooks must be used within a GitHubAppsProvider');
  }
  return context;
}

/** Hook to access GitHub Apps installation query */
export function useGitHubAppsInstallation() {
  const { queryOptions } = useGitHubAppsContext();
  return useQuery<InstallationResponse, IntegrationError>(queryOptions.getInstallation);
}

/** Hook to check for pending installation */
export function useGitHubAppsPendingInstallation() {
  const { queryOptions } = useGitHubAppsContext();
  return useQuery<PendingCheckResponse, IntegrationError>(
    queryOptions.checkUserPendingInstallation
  );
}

/** Hook to list integrations */
export function useGitHubAppsIntegrations() {
  const { queryOptions } = useGitHubAppsContext();
  return useQuery<PlatformIntegration[], IntegrationError>(queryOptions.listIntegrations);
}

/** Hook to list repositories for an integration */
export function useGitHubAppsRepositories(integrationId: string, forceRefresh?: boolean) {
  const { queryOptions } = useGitHubAppsContext();
  return useQuery<ListRepositoriesResponse, IntegrationError>(
    queryOptions.listRepositories(integrationId, forceRefresh)
  );
}

/** Hook to list branches for a repository */
export function useGitHubAppsBranches(integrationId: string, repositoryFullName: string) {
  const { queryOptions } = useGitHubAppsContext();
  return useQuery<ListBranchesResponse, IntegrationError>(
    queryOptions.listBranches(integrationId, repositoryFullName)
  );
}

/** Hook to access GitHub Apps mutations */
export function useGitHubAppsMutations() {
  const { mutations } = useGitHubAppsContext();
  return mutations;
}

/**
 * Base provider component that accepts query options and mutations
 * This is used by specific implementations (UserGitHubAppsProvider, OrgGitHubAppsProvider)
 */
export function GitHubAppsProvider({
  queryOptions,
  mutations,
  children,
}: {
  queryOptions: IntegrationQueryOptions;
  mutations: IntegrationMutations;
  children: ReactNode;
}) {
  return (
    <GitHubAppsContext.Provider value={{ queryOptions, mutations }}>
      {children}
    </GitHubAppsContext.Provider>
  );
}
