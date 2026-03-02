// Provider-specific SHA-256 hash — async Web Crypto port of src/lib/providerHash.ts.
// The original uses Node.js crypto.createHash; here we use crypto.subtle.digest for
// Cloudflare Workers (no nodejs_compat dependency needed).

import type { Provider } from './providers';

const HASH_SALT = 'd20250815';

function getPepper(provider: Provider): string {
  if (provider.id === 'custom') return provider.apiUrl;
  if (provider.id === 'openrouter') return 'henk is a boss';
  return provider.id;
}

async function sha256Base64(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = new Uint8Array(hashBuffer);
  // Convert to base64 without Node.js Buffer
  let binary = '';
  for (const byte of hashArray) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Generates a service-specific SHA-256 hash for safety_identifier / prompt_cache_key.
 * Async because Web Crypto subtle.digest is Promise-based.
 */
export async function generateProviderSpecificHash(
  payload: string,
  provider: Provider
): Promise<string> {
  return sha256Base64(HASH_SALT + getPepper(provider) + payload);
}
