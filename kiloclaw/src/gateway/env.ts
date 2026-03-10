import { ALL_SECRET_ENV_VARS } from '@kilocode/kiloclaw-secret-catalog';
import type { KiloClawEnv } from '../types';
import type { EncryptedEnvelope, EncryptedChannelTokens } from '../schemas/instance-config';
import { deriveGatewayToken } from '../auth/gateway-token';
import { mergeEnvVarsWithSecrets, decryptChannelTokens } from '../utils/encryption';
import { validateUserEnvVarName } from '../utils/env-encryption';

/**
 * User-provided configuration for building container environment variables.
 * Stored in the KiloClawInstance DO, passed to buildEnvVars at start time.
 */
export type UserConfig = {
  envVars?: Record<string, string>;
  encryptedSecrets?: Record<string, EncryptedEnvelope>;
  kilocodeApiKey?: string | null;
  kilocodeDefaultModel?: string | null;
  channels?: EncryptedChannelTokens;
  instanceFeatures?: string[];
};

/**
 * Maps instance feature flag names to container environment variables.
 * Each feature becomes a KILOCLAW_* env var set to "true" when enabled.
 */
export const FEATURE_TO_ENV_VAR: Record<string, string> = {
  'npm-global-prefix': 'KILOCLAW_NPM_GLOBAL_PREFIX',
  'pip-global-prefix': 'KILOCLAW_PIP_GLOBAL_PREFIX',
  'uv-global-prefix': 'KILOCLAW_UV_GLOBAL_PREFIX',
};

/**
 * Result of buildEnvVars: split into non-sensitive env vars and sensitive values
 * that will be encrypted before placement in config.env.
 */
export type EnvVarsBuild = {
  /** Non-sensitive vars — placed in config.env as-is. */
  env: Record<string, string>;
  /** Sensitive vars — encrypted and prefixed with KILOCLAW_ENC_ before config.env. */
  sensitive: Record<string, string>;
};

/**
 * Env var names that are always classified as sensitive.
 * Values for these keys go into the `sensitive` bucket.
 *
 * Derived from the secret catalog to automatically include all channel/secret env vars.
 */
const SENSITIVE_KEYS = new Set([
  'KILOCODE_API_KEY',
  'OPENCLAW_GATEWAY_TOKEN',
  ...ALL_SECRET_ENV_VARS,
]);

/**
 * Build environment variables to pass to the OpenClaw container process.
 *
 * Layering order:
 * 1. Worker-level defaults
 * 2. User-provided plaintext env vars (override platform defaults)
 * 3. User-provided encrypted secrets (override env vars on conflict)
 * 4. Decrypted channel tokens (mapped to container env var names)
 * 5. Reserved system vars (cannot be overridden by any user config)
 * 6. Instance feature flags (cannot be overridden by any user config)
 *
 * Returns a split result: non-sensitive vars in `env`, sensitive vars in `sensitive`.
 * User-provided plaintext env vars go to `env` unless they match SENSITIVE_KEYS.
 * User-provided encrypted secrets always go to `sensitive`.
 *
 * @param env - Worker environment bindings
 * @param sandboxId - Per-user sandbox ID
 * @param gatewayTokenSecret - Secret for deriving per-sandbox gateway tokens
 * @param userConfig - User-provided env vars, encrypted secrets, and channel tokens
 * @returns Split env vars: `env` (plaintext) and `sensitive` (to be encrypted)
 */
export async function buildEnvVars(
  env: KiloClawEnv,
  sandboxId: string,
  gatewayTokenSecret: string,
  userConfig?: UserConfig
): Promise<EnvVarsBuild> {
  // Layer 1: Worker-level defaults (non-sensitive)
  const plainEnv: Record<string, string> = {};

  if (env.KILOCODE_API_BASE_URL) plainEnv.KILOCODE_API_BASE_URL = env.KILOCODE_API_BASE_URL;
  plainEnv.KILOCODE_FEATURE = 'kiloclaw';

  // Collect all sensitive values
  const sensitive: Record<string, string> = {};

  // Layer 2 + 3: User env vars merged with decrypted secrets.
  if (userConfig) {
    // Validate user-provided env var names. Invalid names are dropped with a
    // warning rather than throwing, so a stale reserved-prefix var stored before
    // the prefix was blocked doesn't prevent the instance from starting.
    const cleanedEnvVars = userConfig.envVars ? { ...userConfig.envVars } : undefined;
    const cleanedSecrets = userConfig.encryptedSecrets
      ? { ...userConfig.encryptedSecrets }
      : undefined;
    if (cleanedEnvVars) {
      for (const name of Object.keys(cleanedEnvVars)) {
        try {
          validateUserEnvVarName(name);
        } catch {
          console.warn(`Dropping invalid env var "${name}": uses reserved prefix`);
          delete cleanedEnvVars[name];
        }
      }
    }
    if (cleanedSecrets) {
      for (const name of Object.keys(cleanedSecrets)) {
        try {
          validateUserEnvVarName(name);
        } catch {
          console.warn(`Dropping invalid encrypted secret "${name}": uses reserved prefix`);
          delete cleanedSecrets[name];
        }
      }
    }

    const userEnv = mergeEnvVarsWithSecrets(
      cleanedEnvVars,
      cleanedSecrets,
      env.AGENT_ENV_VARS_PRIVATE_KEY
    );

    // User-provided decrypted secrets are sensitive (they came from encrypted envelopes).
    // User-provided plaintext env vars: classify based on SENSITIVE_KEYS.
    for (const [key, value] of Object.entries(userEnv)) {
      if (SENSITIVE_KEYS.has(key)) {
        sensitive[key] = value;
      } else if (userConfig.encryptedSecrets?.[key]) {
        // Was an encrypted secret — treat as sensitive
        sensitive[key] = value;
      } else {
        plainEnv[key] = value;
      }
    }

    if (userConfig.kilocodeApiKey) {
      sensitive.KILOCODE_API_KEY = userConfig.kilocodeApiKey;
    }
    if (userConfig.kilocodeDefaultModel) {
      plainEnv.KILOCODE_DEFAULT_MODEL = userConfig.kilocodeDefaultModel;
    }

    // Layer 4: Decrypt channel tokens and map to container env var names
    if (userConfig.channels && env.AGENT_ENV_VARS_PRIVATE_KEY) {
      const channelEnv = decryptChannelTokens(userConfig.channels, env.AGENT_ENV_VARS_PRIVATE_KEY);
      // All channel tokens are sensitive
      Object.assign(sensitive, channelEnv);
    }
  }

  // Worker-level passthrough (non-sensitive)
  if (env.TELEGRAM_DM_POLICY) plainEnv.TELEGRAM_DM_POLICY = env.TELEGRAM_DM_POLICY;
  if (env.DISCORD_DM_POLICY) plainEnv.DISCORD_DM_POLICY = env.DISCORD_DM_POLICY;
  if (env.OPENCLAW_ALLOWED_ORIGINS)
    plainEnv.OPENCLAW_ALLOWED_ORIGINS = env.OPENCLAW_ALLOWED_ORIGINS;
  plainEnv.REQUIRE_PROXY_TOKEN = env.REQUIRE_PROXY_TOKEN ?? 'false';

  // Layer 5: Reserved system vars (cannot be overridden by any user config)
  sensitive.OPENCLAW_GATEWAY_TOKEN = await deriveGatewayToken(sandboxId, gatewayTokenSecret);
  plainEnv.AUTO_APPROVE_DEVICES = 'true';

  // Instance feature flags → env vars (non-sensitive, not user-overridable).
  // Applied after user env vars so users cannot suppress features via envVars config.
  if (userConfig?.instanceFeatures) {
    for (const feature of userConfig.instanceFeatures) {
      const envVar = FEATURE_TO_ENV_VAR[feature];
      if (envVar) plainEnv[envVar] = 'true';
    }
  }

  return { env: plainEnv, sensitive };
}
