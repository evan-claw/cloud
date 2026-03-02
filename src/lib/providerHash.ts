import crypto from 'crypto';
import type { Provider } from '@/lib/providers';

/**
 * Generates a service-specific SHA256 hash.
 *
 * @param payload - The string to hash
 * @param provider - The provider to generate the hash for
 * @returns Base64-encoded SHA256 hash
 */
export function generateProviderSpecificHash(payload: string, provider: Provider): string {
  const salt = 'd20250815';
  const pepper =
    provider.id === 'custom'
      ? provider.apiUrl
      : provider.id === 'openrouter'
        ? 'henk is a boss'
        : provider.id;
  return crypto
    .createHash('sha256')
    .update(salt + pepper + payload)
    .digest('base64');
}
