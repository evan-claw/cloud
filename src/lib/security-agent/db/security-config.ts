/**
 * Security Config - Database Operations
 *
 * Wrapper around agent_configs for security agent configuration.
 * Uses the existing agent_configs table with agent_type: 'security_scan'.
 */

import {
  getAgentConfigForOwner,
  upsertAgentConfigForOwner,
  setAgentEnabledForOwner,
} from '@/lib/agent-config/db/agent-configs';
import type { Owner } from '@/lib/code-reviews/core';
import { DEFAULT_SECURITY_AGENT_CONFIG } from '../core/constants';
import type { SecurityAgentConfig } from '../core/types';

const AGENT_TYPE = 'security_scan';
const DEFAULT_PLATFORM = 'github';

/**
 * Gets security agent configuration for an owner
 * Returns default config if none exists
 */
export async function getSecurityAgentConfig(
  owner: Owner,
  platform: string = DEFAULT_PLATFORM
): Promise<SecurityAgentConfig> {
  const config = await getAgentConfigForOwner(owner, AGENT_TYPE, platform);

  if (!config) {
    return DEFAULT_SECURITY_AGENT_CONFIG;
  }

  // Merge with defaults to ensure all fields are present
  return {
    ...DEFAULT_SECURITY_AGENT_CONFIG,
    ...(config.config as Partial<SecurityAgentConfig>),
  };
}

/**
 * Gets security agent configuration with enabled status
 * Returns null if no config exists
 */
export async function getSecurityAgentConfigWithStatus(
  owner: Owner,
  platform: string = DEFAULT_PLATFORM
): Promise<{
  config: SecurityAgentConfig;
  storedConfig: Partial<SecurityAgentConfig>;
  isEnabled: boolean;
} | null> {
  const agentConfig = await getAgentConfigForOwner(owner, AGENT_TYPE, platform);

  if (!agentConfig) {
    return null;
  }

  return {
    storedConfig: agentConfig.config as Partial<SecurityAgentConfig>,
    config: {
      ...DEFAULT_SECURITY_AGENT_CONFIG,
      ...(agentConfig.config as Partial<SecurityAgentConfig>),
    },
    isEnabled: agentConfig.is_enabled,
  };
}

/**
 * Creates or updates security agent configuration for an owner
 */
export async function upsertSecurityAgentConfig(
  owner: Owner,
  config: Partial<SecurityAgentConfig>,
  createdBy: string,
  platform: string = DEFAULT_PLATFORM
): Promise<void> {
  const existingConfig = await getAgentConfigForOwner(owner, AGENT_TYPE, platform);
  const fullConfig = {
    ...DEFAULT_SECURITY_AGENT_CONFIG,
    ...(existingConfig?.config as Partial<SecurityAgentConfig> | undefined),
    ...config,
  };

  await upsertAgentConfigForOwner({
    owner,
    agentType: AGENT_TYPE,
    platform,
    config: fullConfig,
    isEnabled: true,
    createdBy,
  });
}

/**
 * Enables or disables security agent for an owner
 */
export async function setSecurityAgentEnabled(
  owner: Owner,
  isEnabled: boolean,
  platform: string = DEFAULT_PLATFORM
): Promise<void> {
  await setAgentEnabledForOwner(owner, AGENT_TYPE, platform, isEnabled);
}

/**
 * Checks if security agent is enabled for an owner
 */
export async function isSecurityAgentEnabled(
  owner: Owner,
  platform: string = DEFAULT_PLATFORM
): Promise<boolean> {
  const config = await getAgentConfigForOwner(owner, AGENT_TYPE, platform);
  return config?.is_enabled ?? false;
}
