'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type { TRPCClientErrorLike } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';

type SlackError = TRPCClientErrorLike<AnyRouter>;

type SlackInstallation = {
  teamId: string | null;
  teamName: string | null;
  scopes: string[] | null;
  installedAt: string;
  modelSlug: string | null;
};

type SlackInstallationResult = {
  installed: boolean;
  installation: SlackInstallation | null;
};

type SlackOAuthUrlResult = {
  url: string;
};

type SlackTestConnectionResult = {
  success: boolean;
  error?: string;
};

type SlackSendTestMessageResult = {
  success: boolean;
  error?: string;
  channel?: string;
};

type SlackUpdateModelResult = {
  success: boolean;
  error?: string;
};

/**
 * Query options are typed loosely to accommodate TRPC's specific queryOptions return types.
 * Type safety is enforced at the hook level via useQuery's return type inference.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompatibleQueryOptions = Parameters<typeof useQuery<any, any, any, any>>[0];

export type SlackQueryOptions = {
  getInstallation: CompatibleQueryOptions;
  getOAuthUrl: CompatibleQueryOptions;
};

export type SlackMutations = {
  uninstallApp: UseMutationResult<{ success: boolean }, SlackError, void>;
  testConnection: UseMutationResult<SlackTestConnectionResult, SlackError, void>;
  sendTestMessage: UseMutationResult<SlackSendTestMessageResult, SlackError, void>;
  updateModel: UseMutationResult<SlackUpdateModelResult, SlackError, { modelSlug: string }>;
  devRemoveDbRowOnly: UseMutationResult<{ success: boolean }, SlackError, void>;
};

type SlackContextValue = {
  queryOptions: SlackQueryOptions;
  mutations: SlackMutations;
};

const SlackContext = createContext<SlackContextValue | null>(null);

function useSlackContext() {
  const context = useContext(SlackContext);
  if (!context) {
    throw new Error('Slack hooks must be used within a SlackProvider');
  }
  return context;
}

/** Hook to access Slack installation query */
export function useSlackInstallation() {
  const { queryOptions } = useSlackContext();
  return useQuery<SlackInstallationResult, SlackError>(queryOptions.getInstallation);
}

/** Hook to access Slack OAuth URL query */
export function useSlackOAuthUrl() {
  const { queryOptions } = useSlackContext();
  return useQuery<SlackOAuthUrlResult, SlackError>(queryOptions.getOAuthUrl);
}

/** Hook to access Slack mutations */
export function useSlackMutations() {
  const { mutations } = useSlackContext();
  return mutations;
}

/**
 * Base provider component that accepts query options and mutations
 */
export function SlackProvider({
  queryOptions,
  mutations,
  children,
}: {
  queryOptions: SlackQueryOptions;
  mutations: SlackMutations;
  children: ReactNode;
}) {
  return (
    <SlackContext.Provider value={{ queryOptions, mutations }}>{children}</SlackContext.Provider>
  );
}
