export type SecretCategory = 'channel' | 'tool' | 'provider' | 'custom';

export type SecretIconKey = 'send' | 'discord' | 'slack' | 'key';

/**
 * How a secret is delivered to the OpenClaw process at runtime.
 *
 * - 'env': The worker encrypts the secret value and sets it as a
 *   KILOCLAW_ENC_* env var on the Fly machine. At boot, start-openclaw.sh
 *   decrypts the env var, then a Node patch script reads the plaintext
 *   value and writes it into the appropriate location in openclaw.json
 *   (e.g., config.channels.telegram.botToken). OpenClaw reads from
 *   openclaw.json at startup — it never reads these env vars directly.
 *
 * - 'openclaw-secrets': (future) Use OpenClaw's native secret management
 *   via `openclaw secrets set` / SecretRef. Secrets are injected directly
 *   by OpenClaw without the env var + boot script patching roundtrip.
 *   See: https://github.com/openclaw/openclaw/issues/33702
 */
export type InjectionMethod = 'env' | 'openclaw-secrets';

export type SecretFieldDefinition = {
  key: string; // storage key (e.g. 'telegramBotToken')
  label: string; // UI label
  placeholder: string;
  placeholderConfigured: string;
  validationPattern?: string; // regex string (not RegExp — must be serializable)
  validationMessage?: string;
  envVar: string; // container env var name
  maxLength: number; // max input length
};

export type SecretCatalogEntry = {
  id: string; // e.g. 'telegram', 'brave-search'
  label: string;
  category: SecretCategory;
  icon: SecretIconKey; // typed union, resolved to React component at UI layer
  fields: readonly SecretFieldDefinition[];
  helpText?: string;
  helpUrl?: string;
  allFieldsRequired?: boolean; // e.g. Slack needs both bot + app tokens
  order?: number; // sort within category (undefined sorts last)
  injectionMethod?: InjectionMethod; // omit = use DEFAULT_INJECTION_METHOD
};

// Global default — all entries use 'env' unless individually overridden
export const DEFAULT_INJECTION_METHOD: InjectionMethod = 'env';

// Resolution helper
export function getInjectionMethod(entry: SecretCatalogEntry): InjectionMethod {
  return entry.injectionMethod ?? DEFAULT_INJECTION_METHOD;
}
