'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type { TRPCClientErrorLike } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';

type DiscordError = TRPCClientErrorLike<AnyRouter>;

type DiscordInstallation = {
  guildId: string | null;
  guildName: string | null;
  scopes: string[] | null;
  installedAt: string;
};

type DiscordInstallationResult = {
  installed: boolean;
  installation: DiscordInstallation | null;
};

type DiscordOAuthUrlResult = {
  url: string;
};

type DiscordTestConnectionResult = {
  success: boolean;
  error?: string;
};

/**
 * Query options are typed loosely to accommodate TRPC's specific queryOptions return types,
 * which are structurally compatible with useQuery but not assignable to UseQueryOptions.
 * Type safety is enforced at the hook level via useQuery's return type inference.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompatibleQueryOptions = Parameters<typeof useQuery<any, any, any, any>>[0];

export type DiscordQueryOptions = {
  getInstallation: CompatibleQueryOptions;
  getOAuthUrl: CompatibleQueryOptions;
};

export type DiscordMutations = {
  uninstallApp: UseMutationResult<{ success: boolean }, DiscordError, void>;
  testConnection: UseMutationResult<DiscordTestConnectionResult, DiscordError, void>;
  devRemoveDbRowOnly: UseMutationResult<{ success: boolean }, DiscordError, void>;
};

type DiscordContextValue = {
  queryOptions: DiscordQueryOptions;
  mutations: DiscordMutations;
};

const DiscordContext = createContext<DiscordContextValue | null>(null);

function useDiscordContext() {
  const context = useContext(DiscordContext);
  if (!context) {
    throw new Error('Discord hooks must be used within a DiscordProvider');
  }
  return context;
}

/** Hook to access Discord installation query */
export function useDiscordInstallation() {
  const { queryOptions } = useDiscordContext();
  return useQuery<DiscordInstallationResult, DiscordError>(queryOptions.getInstallation);
}

/** Hook to access Discord OAuth URL query */
export function useDiscordOAuthUrl() {
  const { queryOptions } = useDiscordContext();
  return useQuery<DiscordOAuthUrlResult, DiscordError>(queryOptions.getOAuthUrl);
}

/** Hook to access Discord mutations */
export function useDiscordMutations() {
  const { mutations } = useDiscordContext();
  return mutations;
}

/**
 * Base provider component that accepts query options and mutations
 */
export function DiscordProvider({
  queryOptions,
  mutations,
  children,
}: {
  queryOptions: DiscordQueryOptions;
  mutations: DiscordMutations;
  children: ReactNode;
}) {
  return (
    <DiscordContext.Provider value={{ queryOptions, mutations }}>
      {children}
    </DiscordContext.Provider>
  );
}
