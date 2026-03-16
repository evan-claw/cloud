'use client';

import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import { getEntriesByCategory, type SecretCatalogEntry } from '@kilocode/kiloclaw-secret-catalog';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useKiloClawLatestVersion, useKiloClawMyPin } from '@/hooks/useKiloClaw';
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ChannelTokenInput } from './ChannelTokenInput';
import { getIcon } from './secret-ui-adapter';
import { getCreateModelOptions } from './modelSupport';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function CreateInstanceCard({ mutations }: { mutations: ClawMutations }) {
  const posthog = usePostHog();
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();
  const { data: myPin, isLoading: isLoadingPin, isError: isPinLookupError } = useKiloClawMyPin();
  const { data: latestVersion, isLoading: isLoadingLatestVersion } = useKiloClawLatestVersion();
  const [selectedModel, setSelectedModel] = useState('');
  const [addedChannels, setAddedChannels] = useState<Set<string>>(new Set());
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const latestOpenClawVersion = latestVersion?.openclawVersion;
  const hasPin = myPin != null;
  const hasUnknownPinnedVersion = hasPin && !myPin?.openclaw_version;
  const isLoadingProvisionTargetVersion = isLoadingPin || (!hasPin && isLoadingLatestVersion);
  const hasProvisionTargetError = isPinLookupError || hasUnknownPinnedVersion;
  const modelLoadError = isPinLookupError
    ? 'Failed to load version pin state. Refresh and try again.'
    : hasUnknownPinnedVersion
      ? 'Pinned image version metadata is unavailable. Remove or update the pin to select a model.'
      : undefined;

  const channelEntries = useMemo(() => getEntriesByCategory('channel'), []);

  const channelEntryMap = useMemo<ReadonlyMap<string, SecretCatalogEntry>>(
    () => new Map(channelEntries.map(e => [e.id, e])),
    [channelEntries]
  );

  const modelOptions = useMemo<ModelOption[]>(
    () =>
      getCreateModelOptions({
        models: (modelsData?.data || []).map(model => ({ id: model.id, name: model.name })),
        hasPin,
        hasPinLookupError: isPinLookupError,
        pinnedOpenClawVersion: myPin?.openclaw_version,
        latestOpenClawVersion,
        isLoadingPin,
        isLoadingLatestVersion,
      }),
    [
      hasPin,
      isLoadingLatestVersion,
      isLoadingPin,
      isPinLookupError,
      latestOpenClawVersion,
      modelsData,
      myPin,
    ]
  );

  function addChannel(channelId: string) {
    setAddedChannels(prev => new Set([...prev, channelId]));
  }

  function removeChannel(channelId: string) {
    setAddedChannels(prev => {
      const next = new Set(prev);
      next.delete(channelId);
      return next;
    });
    // Clear tokens for removed channel
    const entry = channelEntryMap.get(channelId);
    if (entry) {
      const fieldKeys = entry.fields.map(f => f.key);
      setTokens(prev => {
        const next = { ...prev };
        for (const key of fieldKeys) delete next[key];
        return next;
      });
    }
  }

  function setToken(key: string, value: string) {
    setTokens(prev => ({ ...prev, [key]: value }));
  }

  function buildChannelsPayload() {
    const channels: Record<string, string> = {};
    let hasAny = false;
    for (const channelId of addedChannels) {
      const entry = channelEntryMap.get(channelId);
      if (!entry) continue;
      for (const field of entry.fields) {
        const val = tokens[field.key]?.trim();
        if (val) {
          channels[field.key] = val;
          hasAny = true;
        }
      }
    }
    return hasAny ? channels : undefined;
  }

  function handleCreate() {
    if (hasProvisionTargetError) {
      toast.error(modelLoadError || 'Failed to resolve provision target version.');
      return;
    }

    if (isLoadingModels || isLoadingProvisionTargetVersion) {
      toast.error('Models are still loading; try again in a moment.');
      return;
    }

    if (!selectedModel) {
      toast.error('Please select a default model before creating an instance.');
      return;
    }

    posthog?.capture('claw_create_instance_clicked', {
      selected_model: selectedModel,
      channels: [...addedChannels],
    });

    // Validate entries with allFieldsRequired (e.g. Slack needs both tokens)
    for (const channelId of addedChannels) {
      const entry = channelEntryMap.get(channelId);
      if (!entry?.allFieldsRequired) continue;
      const values = entry.fields.map(f => tokens[f.key]?.trim());
      const hasSome = values.some(v => !!v);
      const hasAll = values.every(v => !!v);
      if (hasSome && !hasAll) {
        toast.error(`${entry.label} requires all fields to be set together.`);
        return;
      }
    }

    mutations.provision.mutate(
      {
        kilocodeDefaultModel: `kilocode/${selectedModel}`,
        channels: buildChannelsPayload(),
      },
      {
        onSuccess: () => toast.success('Instance created and starting'),
        onError: err => toast.error(`Failed to create: ${err.message}`),
      }
    );
  }

  const availableChannels = channelEntries.filter(e => !addedChannels.has(e.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create Instance</CardTitle>
        <CardDescription>
          Choose a default model to provision your first KiloClaw instance.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ModelCombobox
          label="Default Model"
          models={modelOptions}
          value={selectedModel}
          onValueChange={setSelectedModel}
          error={modelLoadError}
          isLoading={isLoadingModels || isLoadingProvisionTargetVersion}
          disabled={
            mutations.provision.isPending ||
            isLoadingModels ||
            isLoadingProvisionTargetVersion ||
            hasProvisionTargetError
          }
          required
        />

        <div className="space-y-3">
          <Label>Channels (optional)</Label>

          {availableChannels.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {availableChannels.map(entry => {
                const Icon = getIcon(entry.icon);
                return (
                  <Button
                    key={entry.id}
                    variant="outline"
                    size="sm"
                    onClick={() => addChannel(entry.id)}
                    disabled={mutations.provision.isPending}
                  >
                    <Icon className="mr-1.5 h-4 w-4" />
                    {entry.label}
                  </Button>
                );
              })}
            </div>
          )}

          {[...addedChannels].map(channelId => {
            const entry = channelEntryMap.get(channelId);
            if (!entry) return null;
            const Icon = getIcon(entry.icon);
            return (
              <div key={entry.id} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Icon className="h-4 w-4" />
                    {entry.label}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeChannel(entry.id)}
                    disabled={mutations.provision.isPending}
                    className="h-6 w-6 p-0"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {entry.fields.map(field => (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={`create-${field.key}`} className="text-xs">
                      {field.label}
                    </Label>
                    <ChannelTokenInput
                      id={`create-${field.key}`}
                      placeholder={field.placeholder}
                      value={tokens[field.key] ?? ''}
                      onChange={v => setToken(field.key, v)}
                      disabled={mutations.provision.isPending}
                    />
                  </div>
                ))}
                <p className="text-muted-foreground text-xs">
                  {entry.helpUrl ? (
                    <>
                      {entry.helpText}{' '}
                      <a
                        href={entry.helpUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        Learn more
                      </a>
                    </>
                  ) : (
                    entry.helpText
                  )}
                </p>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end">
          <Button onClick={handleCreate} disabled={mutations.provision.isPending || !selectedModel}>
            <Plus className="mr-2 h-4 w-4" />
            {mutations.provision.isPending ? 'Creating...' : 'Create & Provision'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
