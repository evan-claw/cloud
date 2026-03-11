'use client';

import { AlertTriangle, Hash, Package, RotateCcw, Save, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { calverAtLeast, cleanVersion } from '@/lib/kiloclaw/version';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useControllerVersion, useKiloClawConfig, useKiloClawMyPin } from '@/hooks/useKiloClaw';
import { useDefaultModelSelection } from '../hooks/useDefaultModelSelection';
import { getSettingsModelOptions } from './modelSupport';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DetailTile } from './DetailTile';

import { getEntriesByCategory } from '@kilocode/kiloclaw-secret-catalog';
import { SecretEntrySection } from './SecretEntrySection';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { VersionPinCard } from './VersionPinCard';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function SettingsTab({
  status,
  mutations,
  onSecretsChanged,
  dirtySecrets,
}: {
  status: KiloClawDashboardStatus;
  mutations: ClawMutations;
  onSecretsChanged?: (entryId: string) => void;
  dirtySecrets: Set<string>;
}) {
  const posthog = usePostHog();
  const { data: config } = useKiloClawConfig();
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();
  const isRunning = status.status === 'running';
  const {
    data: controllerVersion,
    isLoading: isLoadingControllerVersion,
    isError: isControllerVersionError,
  } = useControllerVersion(isRunning);
  const { data: myPin } = useKiloClawMyPin();
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const trackedVersion = cleanVersion(status.openclawVersion);
  const runningVersion = cleanVersion(controllerVersion?.openclawVersion);
  const hasModelSelectionError = isRunning && isControllerVersionError;
  const modelSelectionError = hasModelSelectionError
    ? 'Failed to load the running OpenClaw version. Retry before changing the default model.'
    : undefined;
  const isLoadingModelSelection = isLoadingModels || (isRunning && isLoadingControllerVersion);

  const modelOptions = useMemo<ModelOption[]>(
    () =>
      getSettingsModelOptions({
        models: (modelsData?.data || []).map(model => ({ id: model.id, name: model.name })),
        trackedOpenClawVersion: trackedVersion,
        runningOpenClawVersion: runningVersion,
        isRunning,
        isLoadingRunningVersion: isLoadingControllerVersion,
        hasRunningVersionError: hasModelSelectionError,
      }),
    [
      hasModelSelectionError,
      isLoadingControllerVersion,
      isRunning,
      modelsData,
      runningVersion,
      trackedVersion,
    ]
  );

  const { selectedModel, setSelectedModel } = useDefaultModelSelection(
    config?.kilocodeDefaultModel,
    modelOptions
  );

  const isSaving = mutations.patchConfig.isPending;
  const isDestroying = status.status === 'destroying';
  const supportsConfigRestore = calverAtLeast(
    cleanVersion(controllerVersion?.version),
    '2026.2.26'
  );

  const configuredSecrets = config?.configuredSecrets ?? {};

  function handleSave() {
    if (hasModelSelectionError) {
      toast.error(modelSelectionError);
      return;
    }

    if (isLoadingModelSelection) {
      toast.error('Models are still loading; try again in a moment.');
      return;
    }

    posthog?.capture('claw_save_config_clicked', {
      selected_model: selectedModel || null,
      instance_status: status.status,
    });

    mutations.patchConfig.mutate(
      {
        kilocodeDefaultModel: selectedModel ? `kilocode/${selectedModel}` : null,
      },
      {
        onSuccess: () => toast.success('Configuration saved. Model change applied.'),
        onError: err => toast.error(`Failed to save: ${err.message}`),
      }
    );
  }

  // Determine if running version differs from tracked version
  // Old image: the DO returns null when the controller lacks /_kilo/version,
  // and the platform route converts that to { version: null, commit: null }.
  const needsImageUpgrade = isRunning && controllerVersion && !controllerVersion.version;
  const versionMismatch = trackedVersion && runningVersion && trackedVersion !== runningVersion;
  const isPinned = !!myPin;

  // Show version section when running with a tracked version — even if running version is unknown yet
  const hasVersionInfo = isRunning && trackedVersion && trackedVersion !== ':latest';

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DetailTile label="Env Vars" value={String(status.envVarCount)} icon={Hash} />
        <DetailTile label="Secrets" value={String(status.secretCount)} icon={Hash} />
        <DetailTile label="Channels" value={String(status.channelCount)} icon={Hash} />
      </div>

      <Separator />

      {/* OpenClaw Version Information - only show when instance is running with real version data */}
      {hasVersionInfo && (
        <>
          <div>
            <h3 className="text-foreground mb-3 flex items-center gap-2 text-sm font-medium">
              <Package className="h-4 w-4" />
              OpenClaw Version
            </h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
              <div>
                <p className="text-muted-foreground mb-1.5 text-xs">Running Version</p>
                <div className="flex items-center gap-2">
                  {runningVersion ? (
                    <code className="bg-muted text-foreground rounded px-2 py-1 text-sm font-medium">
                      {runningVersion}
                    </code>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <code className="bg-muted text-muted-foreground cursor-help rounded px-2 py-1 text-sm font-medium">
                          —
                        </code>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Unable to determine the running OpenClaw version</p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {needsImageUpgrade && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          className="border-blue-500/30 bg-blue-500/15 text-blue-400"
                        >
                          Upgrade required
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Upgrade your image to report the running OpenClaw version</p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {versionMismatch && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          className="border-amber-500/30 bg-amber-500/15 text-amber-400"
                        >
                          Modified
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>
                          OpenClaw was updated on this machine independently of the image —
                          redeploying will revert to the image version ({trackedVersion})
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
              <div>
                <p className="text-muted-foreground mb-1.5 text-xs">Image Version</p>
                <code className="bg-muted text-foreground rounded px-2 py-1 text-sm font-medium">
                  {trackedVersion}
                </code>
              </div>
              <div>
                <p className="text-muted-foreground mb-1.5 text-xs">Variant</p>
                <code className="bg-muted text-foreground rounded px-2 py-1 text-sm font-medium">
                  {status.imageVariant || '—'}
                </code>
              </div>
            </div>
            {versionMismatch && (
              <p className="text-muted-foreground mt-2 text-xs">
                {isPinned
                  ? `Redeploying will replace the running version with your pinned image version (${trackedVersion}).`
                  : `Redeploying will replace the running version with the image version (${trackedVersion}).`}
              </p>
            )}
          </div>

          <Separator />
        </>
      )}

      <div>
        <h2 className="text-foreground mb-4 text-lg font-semibold">KiloCode Configuration</h2>

        <div className="space-y-4">
          <div>
            <h3 className="text-foreground mb-1 text-sm font-medium">Default Model</h3>
            <p className="text-muted-foreground mb-2 text-xs">
              The model used for new conversations. Can be changed per-conversation in the OpenClaw
              Control UI.
            </p>
          </div>

          <ModelCombobox
            label=""
            models={modelOptions}
            value={selectedModel}
            onValueChange={setSelectedModel}
            error={modelSelectionError}
            isLoading={isLoadingModelSelection}
            disabled={isSaving || isLoadingModelSelection || hasModelSelectionError}
          />

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSave} disabled={isSaving || hasModelSelectionError}>
              <Save className="h-4 w-4" />
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </div>

          {config && (
            <p className="text-muted-foreground text-xs">
              Current default model: {config.kilocodeDefaultModel || 'not set'}
            </p>
          )}
        </div>
      </div>

      <Separator />

      <div>
        <h3 className="text-foreground mb-1 text-sm font-medium">Channels</h3>
        <p className="text-muted-foreground mb-4 text-xs">
          Connect messaging channels. Advanced settings (DM policy, allow lists, groups) can be
          configured in the OpenClaw Control UI after connecting.
        </p>

        <div className="space-y-6">
          {getEntriesByCategory('channel').map(entry => (
            <SecretEntrySection
              key={entry.id}
              entry={entry}
              configured={configuredSecrets[entry.id] ?? false}
              mutations={mutations}
              onSecretsChanged={onSecretsChanged}
              isDirty={dirtySecrets.has(entry.id)}
            />
          ))}
        </div>
      </div>

      <Separator />

      <VersionPinCard />

      <Separator />

      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-500/10">
            <AlertTriangle className="h-4 w-4 text-red-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-red-400">Danger Zone</h3>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              Stop or destroy this instance. Destroy permanently removes associated data.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        !supportsConfigRestore ||
                        !isRunning ||
                        mutations.restoreConfig.isPending ||
                        isDestroying
                      }
                      onClick={() => {
                        posthog?.capture('claw_restore_config_clicked', {
                          instance_status: status.status,
                        });
                        setConfirmRestore(true);
                      }}
                    >
                      <RotateCcw className="h-4 w-4" />
                      Restore Default Config
                    </Button>
                  </span>
                </TooltipTrigger>
                {!supportsConfigRestore && (
                  <TooltipContent>Unavailable until redeploy</TooltipContent>
                )}
              </Tooltip>

              <Button
                variant="outline"
                size="sm"
                disabled={!isRunning || mutations.stop.isPending || isDestroying}
                onClick={() => {
                  posthog?.capture('claw_stop_instance_clicked', {
                    instance_status: status.status,
                    source: 'settings_danger_zone',
                  });
                  mutations.stop.mutate(undefined, {
                    onSuccess: () => toast.success('Instance stopped'),
                    onError: err => toast.error(err.message),
                  });
                }}
              >
                <Square className="h-4 w-4" />
                Stop Instance
              </Button>

              {!confirmDestroy ? (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isDestroying || mutations.destroy.isPending}
                  onClick={() => {
                    posthog?.capture('claw_destroy_instance_clicked', {
                      instance_status: status.status,
                    });
                    setConfirmDestroy(true);
                  }}
                >
                  {isDestroying ? 'Destroying...' : 'Destroy Instance'}
                </Button>
              ) : (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={isDestroying || mutations.destroy.isPending}
                    onClick={() => {
                      posthog?.capture('claw_destroy_instance_confirmed', {
                        instance_status: status.status,
                      });
                      mutations.destroy.mutate(undefined, {
                        onSuccess: () => {
                          toast.success('Instance destroyed');
                          setConfirmDestroy(false);
                        },
                        onError: err => toast.error(err.message),
                      });
                    }}
                  >
                    {isDestroying ? 'Destroying...' : 'Yes, destroy'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      posthog?.capture('claw_destroy_instance_cancelled');
                      setConfirmDestroy(false);
                    }}
                  >
                    Cancel
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {supportsConfigRestore && (
        <ConfirmActionDialog
          open={confirmRestore}
          onOpenChange={setConfirmRestore}
          title="Restore Default Config"
          description="This will rewrite openclaw.json to defaults based on the machine's current environment variables and restart the gateway process. Any manual config changes made via the Control UI will be lost. This does not pull fresh settings from your dashboard — use Redeploy for that."
          confirmLabel="Restore & Restart"
          confirmIcon={<RotateCcw className="mr-1 h-4 w-4" />}
          isPending={mutations.restoreConfig.isPending}
          pendingLabel="Restoring..."
          onConfirm={() => {
            posthog?.capture('claw_restore_config_confirmed', {
              instance_status: status.status,
            });
            mutations.restoreConfig.mutate(undefined, {
              onSuccess: data => {
                if (data.signaled) {
                  toast.success('Config restored and gateway restarting');
                } else {
                  toast.success(
                    'Config restored, but the gateway was not running — restart the instance to apply'
                  );
                }
                setConfirmRestore(false);
              },
              onError: err => toast.error(`Failed to restore config: ${err.message}`),
            });
          }}
        />
      )}
    </div>
  );
}
