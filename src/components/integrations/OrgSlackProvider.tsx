'use client';

import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { SlackProvider, type SlackQueryOptions, type SlackMutations } from './SlackContext';

type OrgSlackProviderProps = {
  organizationId: string;
  children: ReactNode;
};

export function OrgSlackProvider({ organizationId, children }: OrgSlackProviderProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const queryOptions: SlackQueryOptions = {
    getInstallation: trpc.organizations.slack.getInstallation.queryOptions({ organizationId }),
    getOAuthUrl: trpc.organizations.slack.getOAuthUrl.queryOptions({ organizationId }),
  };

  const uninstallAppMutation = useMutation(
    trpc.organizations.slack.uninstallApp.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.slack.getInstallation.queryKey({ organizationId }),
        });
      },
    })
  );

  const testConnectionMutation = useMutation(
    trpc.organizations.slack.testConnection.mutationOptions()
  );

  const sendTestMessageMutation = useMutation(
    trpc.organizations.slack.sendTestMessage.mutationOptions()
  );

  const updateModelMutation = useMutation(
    trpc.organizations.slack.updateModel.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.slack.getInstallation.queryKey({ organizationId }),
        });
      },
    })
  );

  const devRemoveDbRowOnlyMutation = useMutation(
    trpc.organizations.slack.devRemoveDbRowOnly.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.slack.getInstallation.queryKey({ organizationId }),
        });
      },
    })
  );

  const mutations: SlackMutations = {
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
    } as SlackMutations['uninstallApp'],

    testConnection: {
      ...testConnectionMutation,
      mutate: (_: void, options?: Parameters<typeof testConnectionMutation.mutate>[1]) => {
        testConnectionMutation.mutate({ organizationId }, options);
      },
      mutateAsync: async (
        _: void,
        options?: Parameters<typeof testConnectionMutation.mutateAsync>[1]
      ) => {
        return testConnectionMutation.mutateAsync({ organizationId }, options);
      },
    } as SlackMutations['testConnection'],

    sendTestMessage: {
      ...sendTestMessageMutation,
      mutate: (_: void, options?: Parameters<typeof sendTestMessageMutation.mutate>[1]) => {
        sendTestMessageMutation.mutate({ organizationId }, options);
      },
      mutateAsync: async (
        _: void,
        options?: Parameters<typeof sendTestMessageMutation.mutateAsync>[1]
      ) => {
        return sendTestMessageMutation.mutateAsync({ organizationId }, options);
      },
    } as SlackMutations['sendTestMessage'],

    updateModel: {
      ...updateModelMutation,
      mutate: (
        input: { modelSlug: string },
        options?: Parameters<typeof updateModelMutation.mutate>[1]
      ) => {
        updateModelMutation.mutate({ organizationId, modelSlug: input.modelSlug }, options);
      },
      mutateAsync: async (
        input: { modelSlug: string },
        options?: Parameters<typeof updateModelMutation.mutateAsync>[1]
      ) => {
        return updateModelMutation.mutateAsync(
          { organizationId, modelSlug: input.modelSlug },
          options
        );
      },
    } as SlackMutations['updateModel'],

    devRemoveDbRowOnly: {
      ...devRemoveDbRowOnlyMutation,
      mutate: (_: void, options?: Parameters<typeof devRemoveDbRowOnlyMutation.mutate>[1]) => {
        devRemoveDbRowOnlyMutation.mutate({ organizationId }, options);
      },
      mutateAsync: async (
        _: void,
        options?: Parameters<typeof devRemoveDbRowOnlyMutation.mutateAsync>[1]
      ) => {
        return devRemoveDbRowOnlyMutation.mutateAsync({ organizationId }, options);
      },
    } as SlackMutations['devRemoveDbRowOnly'],
  };

  return (
    <SlackProvider queryOptions={queryOptions} mutations={mutations}>
      {children}
    </SlackProvider>
  );
}
