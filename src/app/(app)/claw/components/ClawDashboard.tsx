'use client';

import { useCallback, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import {
  useKiloClawGatewayStatus,
  useKiloClawMutations,
  useKiloClawServiceDegraded,
} from '@/hooks/useKiloClaw';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useGatewayUrl } from '../hooks/useGatewayUrl';
import { ClawHeader } from './ClawHeader';
import { CreateInstanceCard } from './CreateInstanceCard';
import { InstanceControls } from './InstanceControls';
import { InstanceTab } from './InstanceTab';
import { SettingsTab } from './SettingsTab';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import { ChangelogCard } from './ChangelogCard';
import { EarlybirdBanner } from './EarlybirdBanner';
import { PairingCard } from './PairingCard';

type PopulatedClawStatus = KiloClawDashboardStatus & {
  status: NonNullable<KiloClawDashboardStatus['status']>;
};

function hasPopulatedStatus(
  candidate: KiloClawDashboardStatus | undefined
): candidate is PopulatedClawStatus {
  return candidate !== undefined && candidate.status !== null;
}

export function ClawDashboard({ status }: { status: KiloClawDashboardStatus | undefined }) {
  const trpc = useTRPC();
  const mutations = useKiloClawMutations();
  const gatewayUrl = useGatewayUrl(status);
  const instanceStatus = hasPopulatedStatus(status) ? status : null;
  const isRunning = instanceStatus?.status === 'running';
  const {
    data: gatewayStatus,
    isLoading: gatewayLoading,
    error: gatewayError,
  } = useKiloClawGatewayStatus(isRunning);

  const { data: isServiceDegraded } = useKiloClawServiceDegraded();
  const { data: earlybirdStatus } = useQuery(trpc.kiloclaw.getEarlybirdStatus.queryOptions());

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const instanceYoung =
    instanceStatus !== null &&
    instanceStatus.provisionedAt !== null &&
    Date.now() - instanceStatus.provisionedAt < SEVEN_DAYS_MS;
  const configServiceNudgeVisible = !instanceStatus || instanceYoung;

  const [dirtySecrets, setDirtySecrets] = useState<Set<string>>(new Set());

  const onSecretsChanged = useCallback((entryId: string) => {
    setDirtySecrets(prev => new Set([...prev, entryId]));
  }, []);
  const onRedeploySuccess = useCallback(() => {
    setDirtySecrets(new Set());
  }, []);

  return (
    <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
      <ClawHeader
        status={status?.status || null}
        sandboxId={status?.sandboxId || null}
        region={status?.flyRegion || null}
        gatewayUrl={gatewayUrl}
        gatewayReady={gatewayStatus?.state === 'running'}
      />

      {isServiceDegraded && (
        <Alert variant="warning">
          <TriangleAlert className="size-4" />
          <AlertDescription className="flex flex-col">
            <span>
              KiloClaw ended up being really popular! We&apos;re working on getting additional
              capacity. If you have trouble starting a machine, please try again in a few minutes.
            </span>
            <span className="mt-2 flex flex-row gap-1">
              <span>You can also</span>
              <a
                href="https://status.kilo.ai/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:opacity-80"
              >
                check our status page for live updates
              </a>
            </span>
          </AlertDescription>
        </Alert>
      )}

      {configServiceNudgeVisible && (
        <Alert>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Need help getting KiloClaw configured? Get up and running in one hour with 2 months
              free KiloClaw hosting included.
            </span>
            <a
              href="https://kilo.ai/kiloclaw/config-service"
              target="_blank"
              rel="noopener noreferrer"
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex shrink-0 items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors"
            >
              Learn more
            </a>
          </AlertDescription>
        </Alert>
      )}

      <Card className="mt-6">
        {!instanceStatus ? (
          <CardContent className="p-5">
            <CreateInstanceCard mutations={mutations} />
          </CardContent>
        ) : (
          <>
            <CardContent className="border-b p-5">
              <InstanceControls
                status={instanceStatus}
                mutations={mutations}
                onRedeploySuccess={onRedeploySuccess}
              />
            </CardContent>
            <Tabs defaultValue="instance">
              <div className="px-5">
                <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b bg-transparent p-0">
                  <TabsTrigger
                    value="instance"
                    className="text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-3 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    Gateway Process
                  </TabsTrigger>
                  <TabsTrigger
                    value="settings"
                    className="text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-3 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    Settings
                  </TabsTrigger>
                </TabsList>
              </div>
              <CardContent className="p-5">
                <TabsContent value="instance" className="mt-0">
                  <InstanceTab
                    status={instanceStatus}
                    gatewayStatus={gatewayStatus}
                    gatewayLoading={gatewayLoading}
                    gatewayError={gatewayError}
                  />
                </TabsContent>
                <TabsContent value="settings" className="mt-0">
                  <SettingsTab
                    status={instanceStatus}
                    mutations={mutations}
                    onSecretsChanged={onSecretsChanged}
                    dirtySecrets={dirtySecrets}
                  />
                </TabsContent>
              </CardContent>
            </Tabs>
          </>
        )}
      </Card>

      {instanceStatus?.status === 'running' && <PairingCard mutations={mutations} />}

      {earlybirdStatus?.purchased && <EarlybirdBanner />}
      <ChangelogCard />
    </div>
  );
}
