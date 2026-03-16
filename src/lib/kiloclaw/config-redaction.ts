/**
 * Redaction utilities for openclaw.json config.
 *
 * The raw config editor sends the full openclaw.json to the browser for
 * editing.  Some fields contain plaintext secrets (gateway auth tokens,
 * channel bot/app tokens, provider API keys) that must never leave the
 * server.  This module replaces those values with a placeholder on read
 * and restores the real values on write.
 *
 * Secrets are identified two ways:
 *  1. Explicit paths (OPENCLAW_CONFIG_SECRET_PATHS) — known locations.
 *  2. Key-name pattern matching (SECRET_KEY_PATTERN) — catches provider
 *     apiKey fields and any other secret-shaped keys at arbitrary depth.
 */

/**
 * Explicit paths to secret values inside openclaw.json.
 * These are always redacted regardless of key-name matching.
 */
export const OPENCLAW_CONFIG_SECRET_PATHS: ReadonlyArray<readonly string[]> = [
  ['gateway', 'auth', 'token'],
  ['channels', 'telegram', 'botToken'],
  ['channels', 'discord', 'token'],
  ['channels', 'slack', 'botToken'],
  ['channels', 'slack', 'appToken'],
];

/**
 * Field names that indicate a value is a secret, matched case-insensitively.
 * Applied recursively at every level of the config tree.
 */
const SECRET_KEY_PATTERN =
  /^(apiKey|apiSecret|token|botToken|appToken|secret|password|credential|accessToken|refreshToken|privateKey)$/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export const REDACTED_PLACEHOLDER = '__REDACTED__';

/**
 * Regex-based redaction for raw text when JSON.parse fails.
 * Matches `"secretKey": "value"` patterns and replaces the value with the
 * placeholder. This is intentionally conservative — it only matches double-quoted
 * string values to avoid corrupting the file further.
 */
export function redactRawText(raw: string): string {
  const keyAlternation =
    'apiKey|apiSecret|token|botToken|appToken|secret|password|credential|accessToken|refreshToken|privateKey';
  const pattern = new RegExp(`("(?:${keyAlternation})"\\s*:\\s*)"(?!__REDACTED__)[^"]+"`, 'gi');
  return raw.replace(pattern, `$1"${REDACTED_PLACEHOLDER}"`);
}

/**
 * Read a nested value from an object by key path.
 * Returns undefined if any intermediate key is missing or not an object.
 */
function getNestedValue(obj: Record<string, unknown>, keyPath: readonly string[]): unknown {
  let current: unknown = obj;
  for (const key of keyPath) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Set a nested value in an object by key path.
 * Creates intermediate objects as needed.
 */
function setNestedValue(
  obj: Record<string, unknown>,
  keyPath: readonly string[],
  value: unknown
): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    if (typeof current[key] !== 'object' || current[key] === null || Array.isArray(current[key])) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keyPath[keyPath.length - 1]] = value;
}

/**
 * Delete a nested key from an object by key path.
 */
function deleteNestedValue(obj: Record<string, unknown>, keyPath: readonly string[]): void {
  let current: unknown = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return;
    }
    current = (current as Record<string, unknown>)[keyPath[i]];
  }
  if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
    delete (current as Record<string, unknown>)[keyPath[keyPath.length - 1]];
  }
}

/**
 * Recursively walk an object and redact any string value whose key matches
 * SECRET_KEY_PATTERN.
 */
function walkAndRedact(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.length > 0 && isSecretKey(key)) {
      obj[key] = REDACTED_PLACEHOLDER;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          walkAndRedact(item as Record<string, unknown>);
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      walkAndRedact(value as Record<string, unknown>);
    }
  }
}

/**
 * Strip secret fields from an openclaw config before sending to the browser.
 * Replaces each secret value with a placeholder so the UI can show that a
 * secret is configured without revealing its value.
 *
 * Uses both explicit paths and key-name pattern matching to catch secrets
 * at known and dynamic locations (e.g. provider apiKey fields).
 */
export function redactOpenclawConfig(config: Record<string, unknown>): Record<string, unknown> {
  // Deep clone to avoid mutating the original
  const redacted = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;

  // 1. Explicit paths (belt)
  for (const secretPath of OPENCLAW_CONFIG_SECRET_PATHS) {
    const value = getNestedValue(redacted, secretPath);
    if (value !== undefined && value !== null && typeof value === 'string' && value.length > 0) {
      setNestedValue(redacted, secretPath, REDACTED_PLACEHOLDER);
    }
  }

  // 2. Pattern-based walk (suspenders) — catches provider apiKeys, etc.
  walkAndRedact(redacted);

  return redacted;
}

/**
 * Recursively delete any remaining REDACTED_PLACEHOLDER values at secret keys.
 * Used as a safety net for subtrees that don't exist in currentConfig and
 * therefore can't be resolved by walkAndRestore.
 */
function stripUnresolvablePlaceholders(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (value === REDACTED_PLACEHOLDER && isSecretKey(key)) {
      delete obj[key];
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          stripUnresolvablePlaceholders(item as Record<string, unknown>);
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      stripUnresolvablePlaceholders(value as Record<string, unknown>);
    }
  }
}

/**
 * Recursively walk the user config and restore any REDACTED_PLACEHOLDER
 * values whose key matches SECRET_KEY_PATTERN from the corresponding
 * subtree in the current config.  When a subtree doesn't exist in
 * currentConfig, any placeholders inside it are stripped.
 */
function walkAndRestore(obj: Record<string, unknown>, current: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (value === REDACTED_PLACEHOLDER && isSecretKey(key)) {
      const realValue = current[key];
      if (realValue !== undefined && realValue !== null) {
        obj[key] = realValue;
      } else {
        delete obj[key];
      }
    } else if (Array.isArray(value)) {
      // Arrays are not walked for secret restoration — index-based matching
      // is position-dependent and silently swaps secrets when users reorder
      // entries. Strip any leftover placeholders so they don't leak through.
      for (const item of value) {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          stripUnresolvablePlaceholders(item as Record<string, unknown>);
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      const currentChild = current[key];
      if (
        typeof currentChild === 'object' &&
        currentChild !== null &&
        !Array.isArray(currentChild)
      ) {
        walkAndRestore(value as Record<string, unknown>, currentChild as Record<string, unknown>);
      } else {
        // Subtree doesn't exist in currentConfig — strip any unresolvable placeholders
        stripUnresolvablePlaceholders(value as Record<string, unknown>);
      }
    }
  }
}

/**
 * Restore redacted secret fields in a user-submitted config by merging
 * back the real values from the current on-disk config.
 *
 * If the user left the placeholder value, the original secret is restored.
 * If the user deleted the field entirely, it stays deleted.
 * If the user set a new (non-placeholder) value, the new value is kept.
 */
export function restoreRedactedSecrets(
  userConfig: Record<string, unknown>,
  currentConfig: Record<string, unknown>
): Record<string, unknown> {
  const merged = JSON.parse(JSON.stringify(userConfig)) as Record<string, unknown>;

  // 1. Explicit paths
  for (const secretPath of OPENCLAW_CONFIG_SECRET_PATHS) {
    const userValue = getNestedValue(merged, secretPath);
    if (userValue === REDACTED_PLACEHOLDER) {
      const realValue = getNestedValue(currentConfig, secretPath);
      if (realValue !== undefined && realValue !== null) {
        setNestedValue(merged, secretPath, realValue);
      } else {
        deleteNestedValue(merged, secretPath);
      }
    }
  }

  // 2. Pattern-based walk — restores provider apiKeys, etc.
  walkAndRestore(merged, currentConfig);

  return merged;
}
