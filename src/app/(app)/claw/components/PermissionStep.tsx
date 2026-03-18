'use client';

import { useState } from 'react';
import { Loader2, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useReadFile, type useKiloClawMutations } from '@/hooks/useKiloClaw';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';

type ExecPreset = 'always-ask' | 'never-ask';

function execPresetToConfig(preset: ExecPreset): { security: string; ask: string } {
  switch (preset) {
    case 'never-ask':
      return { security: 'full', ask: 'off' };
    case 'always-ask':
    default:
      return { security: 'allowlist', ask: 'on-miss' };
  }
}

function mergeExecPreset(
  currentConfig: Record<string, unknown>,
  preset: ExecPreset
): Record<string, unknown> {
  const tools = (currentConfig.tools ?? {}) as Record<string, unknown>;
  const exec = (tools.exec ?? {}) as Record<string, unknown>;
  return {
    ...currentConfig,
    tools: {
      ...tools,
      exec: { ...exec, ...execPresetToConfig(preset) },
    },
  };
}

const OPENCLAW_CONFIG_PATH = 'openclaw.json';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function PermissionStep({
  instanceRunning,
  mutations,
  onComplete,
}: {
  instanceRunning: boolean;
  mutations: ClawMutations;
  onComplete: () => void;
}) {
  const [preset, setPreset] = useState<ExecPreset | null>(null);

  // Only fetch config when the instance is running AND user picked "never-ask"
  // (the only case where we need to patch).
  const needsPatch = preset === 'never-ask';
  const { data: fileData, refetch } = useReadFile(
    OPENCLAW_CONFIG_PATH,
    instanceRunning && needsPatch
  );

  const isApplying = mutations.writeFile.isPending;
  const canContinue = instanceRunning && preset !== null && !isApplying;

  function handleContinue() {
    if (!preset) return;

    // "always-ask" is the default — no patch needed
    if (preset === 'always-ask') {
      onComplete();
      return;
    }

    // "never-ask" — patch the config
    if (!fileData) {
      toast.error('Config not loaded yet — please try again in a moment');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fileData.content);
    } catch {
      toast.error('Failed to parse config — please try again');
      return;
    }

    const currentConfig = (
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
    ) as Record<string, unknown>;

    const merged = mergeExecPreset(currentConfig, preset);
    mutations.writeFile.mutate(
      { path: OPENCLAW_CONFIG_PATH, content: JSON.stringify(merged, null, 2), etag: fileData.etag },
      {
        onSuccess: () => onComplete(),
        onError: (err: {
          message: string;
          data?: { code?: string; upstreamCode?: string } | null;
        }) => {
          if (err.data?.code === 'CONFLICT') {
            void refetch();
            toast.error('Config was modified externally — please try again');
          } else {
            toast.error(err.message);
          }
        },
      }
    );
  }

  return (
    <Card className="mt-6">
      <CardContent className="flex flex-col items-center gap-6 py-10">
        {/* Permission toggle */}
        <div className="w-full space-y-3">
          <p className="text-foreground text-center text-lg font-semibold">
            How should KiloClaw handle tool permissions?
          </p>
          <p className="text-muted-foreground text-center text-sm">
            Choose whether KiloClaw asks you before running tools, or runs them automatically. You
            can change this later in settings.
          </p>

          <RadioGroup
            value={preset ?? undefined}
            onValueChange={v => setPreset(v as ExecPreset)}
            className="mt-4 grid gap-3"
          >
            <PresetOption
              value="always-ask"
              selected={preset === 'always-ask'}
              icon={<ShieldCheck className="h-5 w-5 text-emerald-500" />}
              label="Always ask"
              description="KiloClaw asks you before running any new tool. Safer, more control."
            />
            <PresetOption
              value="never-ask"
              selected={preset === 'never-ask'}
              icon={<ShieldOff className="h-5 w-5 text-amber-500" />}
              label="Never ask"
              description="KiloClaw runs all tools automatically. Faster, fully autonomous."
            />
          </RadioGroup>
        </div>

        {/* Provisioning status banner */}
        {!instanceRunning && (
          <div className="border-border flex w-full items-center gap-3 rounded-lg border p-4">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <div>
              <p className="text-sm font-semibold">Setting up your instance</p>
              <p className="text-muted-foreground text-xs">
                This happens in the background — keep going while we get things ready.
              </p>
            </div>
          </div>
        )}

        <Button className="w-full py-6 text-base" disabled={!canContinue} onClick={handleContinue}>
          {isApplying ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Applying...
            </>
          ) : (
            'Continue'
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

function PresetOption({
  value,
  selected,
  icon,
  label,
  description,
}: {
  value: string;
  selected: boolean;
  icon: React.ReactNode;
  label: string;
  description: string;
}) {
  return (
    <label
      htmlFor={`preset-${value}`}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
        selected ? 'border-foreground bg-accent' : 'border-border hover:border-foreground/50'
      )}
    >
      <RadioGroupItem value={value} id={`preset-${value}`} className="mt-0.5" />
      <div className="flex items-start gap-2">
        {icon}
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
      </div>
    </label>
  );
}
