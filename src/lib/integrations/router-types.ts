import type { UseMutationResult, UseQueryOptions } from '@tanstack/react-query';
import type { TRPCClientErrorLike } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';
import type { PlatformRepository } from '@/lib/integrations/core/types';

/**
 * TRPC error type for integration operations
 * Using AnyRouter to avoid circular dependency with root-router.ts
 */
export type IntegrationError = TRPCClientErrorLike<AnyRouter>;

/**
 * Response type for getInstallation query
 */
export type InstallationResponse = {
  installed: boolean;
  installation: {
    installationId: string | null;
    accountId: string | null;
    accountLogin: string | null;
    accountType?: string;
    targetType?: string;
    permissions: unknown;
    events: string[] | null;
    repositorySelection: string | null;
    repositories: PlatformRepository[] | null;
    suspendedAt: string | null;
    suspendedBy: string | null;
    installedAt: string;
    status: string | null;
  } | null;
};

/**
 * Response type for checkUserPendingInstallation query
 */
export type PendingCheckResponse = {
  hasPending: boolean;
  pendingOrganizationId: string | null;
};

/**
 * Input for listRepositories query
 */
export type ListRepositoriesInput = {
  integrationId: string;
  forceRefresh?: boolean;
};

/**
 * Response type for listRepositories query
 */
export type ListRepositoriesResponse = {
  repositories: PlatformRepository[];
  syncedAt: string | null;
};

/**
 * Response type for listBranches query
 */
export type ListBranchesResponse = {
  branches: Array<{ name: string; isDefault: boolean }>;
};

/**
 * Query options are typed loosely to accommodate TRPC's specific queryOptions return types,
 * which are structurally compatible with useQuery but not directly assignable to UseQueryOptions.
 * Type safety is enforced at the hook level via useQuery's return type inference.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompatibleQueryOptions = UseQueryOptions<any, any, any, any>;

/**
 * Query options interface that both user and org integration providers must implement.
 *
 * Simple queries provide query options objects directly.
 * Parameterized queries provide functions that return query options objects.
 */
export type IntegrationQueryOptions = {
  /** List all integrations */
  listIntegrations: CompatibleQueryOptions;

  /** Get GitHub App installation status */
  getInstallation: CompatibleQueryOptions;

  /** Check if user has a pending installation */
  checkUserPendingInstallation: CompatibleQueryOptions;

  /**
   * List repositories accessible by an integration.
   * Returns query options; the `enabled` flag is set internally based on integrationId.
   */
  listRepositories: (integrationId: string, forceRefresh?: boolean) => CompatibleQueryOptions;

  /**
   * List branches for a repository.
   * Returns query options; the `enabled` flag is set internally based on args.
   */
  listBranches: (integrationId: string, repositoryFullName: string) => CompatibleQueryOptions;
};

/**
 * Mutation interface that both user and org integration providers must implement
 */
export type IntegrationMutations = {
  /** Uninstall GitHub App */
  uninstallApp: UseMutationResult<{ success: boolean }, IntegrationError, void>;

  /** Cancel pending installation */
  cancelPendingInstallation: UseMutationResult<{ success: boolean }, IntegrationError, void>;

  /** Refresh installation details from GitHub (permissions, events, repositories) */
  refreshInstallation: UseMutationResult<{ success: boolean }, IntegrationError, void>;
};
