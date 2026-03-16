export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const PLACEHOLDER_PATTERNS = [/^\.\.\.$/, /^fo1_\.\.\.$/, /^key-\.\.\.$/, /^whsec_\.\.\./];

export function findMissingVars(
  example: Record<string, string>,
  actual: Record<string, string>
): string[] {
  const missing: string[] = [];
  for (const [key, exampleVal] of Object.entries(example)) {
    const actualVal = actual[key];
    if (!actualVal) {
      missing.push(key);
      continue;
    }
    if (PLACEHOLDER_PATTERNS.some(p => p.test(actualVal))) {
      missing.push(key);
    } else if (actualVal === exampleVal && PLACEHOLDER_PATTERNS.some(p => p.test(exampleVal))) {
      missing.push(key);
    }
  }
  return missing;
}
