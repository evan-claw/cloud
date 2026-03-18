import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';

export type ClawState = KiloClawDashboardStatus['status'];

export type ExecPreset = 'always-ask' | 'never-ask';

export type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export const OPENCLAW_CONFIG_PATH = 'openclaw.json';

export function execPresetToConfig(preset: ExecPreset): { security: string; ask: string } {
  switch (preset) {
    case 'never-ask':
      return { security: 'full', ask: 'off' };
    case 'always-ask':
    default:
      return { security: 'allowlist', ask: 'on-miss' };
  }
}

export function mergeExecPreset(
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

export const CLAW_STATUS_BADGE: Record<
  Exclude<ClawState, null>,
  { label: string; className: string }
> = {
  running: {
    label: 'Machine Online',
    className: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
  },
  starting: {
    label: 'Starting',
    className: 'border-blue-500/30 bg-blue-500/15 text-blue-400 animate-pulse',
  },
  stopped: {
    label: 'Machine Stopped',
    className: 'border-red-500/30 bg-red-500/15 text-red-400',
  },
  provisioned: {
    label: 'Provisioned',
    className: 'border-blue-500/30 bg-blue-500/15 text-blue-400',
  },
  destroying: {
    label: 'Destroying',
    className: 'border-amber-500/30 bg-amber-500/15 text-amber-400 animate-pulse',
  },
};
