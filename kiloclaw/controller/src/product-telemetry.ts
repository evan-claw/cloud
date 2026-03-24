/**
 * Collects product telemetry from the live openclaw config.
 *
 * Read from disk once per invocation (~every 24h). All fields have safe
 * defaults so callers never see an exception.
 */
import fs from 'node:fs';
import { z } from 'zod';
import { detectChannels } from './pairing-cache';

export { detectChannels };

const CONFIG_PATH = '/root/.openclaw/openclaw.json';

export type ProductTelemetry = {
  openclawVersion: string | null;
  defaultModel: string | null;
  channelCount: number;
  enabledChannels: string[];
  toolsProfile: string | null;
  execSecurity: string | null;
  browserEnabled: boolean;
};

/** Loose schema — extract only the fields we care about, ignore the rest. */
const OpenclawConfigSchema = z
  .object({
    agents: z
      .object({
        defaults: z
          .object({
            model: z.object({ primary: z.string() }).catch({ primary: '' }),
          })
          .catch({ model: { primary: '' } }),
      })
      .catch({ defaults: { model: { primary: '' } } }),
    tools: z
      .object({
        profile: z.string().catch(''),
        exec: z.object({ security: z.string().catch('') }).catch({ security: '' }),
      })
      .catch({ profile: '', exec: { security: '' } }),
    browser: z.object({ enabled: z.boolean().catch(false) }).catch({ enabled: false }),
    channels: z.unknown().optional(),
  })
  .catch({
    agents: { defaults: { model: { primary: '' } } },
    tools: { profile: '', exec: { security: '' } },
    browser: { enabled: false },
    channels: undefined,
  });

export type ProductTelemetryDeps = {
  readConfigFile: () => string;
};

const defaultDeps: ProductTelemetryDeps = {
  readConfigFile: () => fs.readFileSync(CONFIG_PATH, 'utf8'),
};

export function collectProductTelemetry(
  openclawVersion: string | null,
  deps: ProductTelemetryDeps = defaultDeps,
): ProductTelemetry {
  const empty: ProductTelemetry = {
    openclawVersion,
    defaultModel: null,
    channelCount: 0,
    enabledChannels: [],
    toolsProfile: null,
    execSecurity: null,
    browserEnabled: false,
  };

  let raw: unknown;
  try {
    raw = JSON.parse(deps.readConfigFile());
  } catch {
    return empty;
  }

  const config = OpenclawConfigSchema.safeParse(raw);
  if (!config.success) return empty;

  const enabledChannels = detectChannels(raw);

  return {
    openclawVersion,
    defaultModel: config.data.agents.defaults.model.primary || null,
    channelCount: enabledChannels.length,
    enabledChannels,
    toolsProfile: config.data.tools.profile || null,
    execSecurity: config.data.tools.exec.security || null,
    browserEnabled: config.data.browser.enabled,
  };
}
