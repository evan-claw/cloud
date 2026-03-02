import { describe, it, expect } from 'vitest';
import { generateProviderSpecificHash } from '../../src/lib/provider-hash';
import type { Provider } from '../../src/lib/providers';

const openrouterProvider: Provider = {
  id: 'openrouter',
  apiUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  hasGenerationEndpoint: true,
};

const gigapotatoProvider: Provider = {
  id: 'gigapotato',
  apiUrl: 'https://giga.potato.ai/v1',
  apiKey: 'test-key',
  hasGenerationEndpoint: false,
};

const customProvider: Provider = {
  id: 'custom',
  apiUrl: 'https://custom.example.com/v1',
  apiKey: 'test-key',
  hasGenerationEndpoint: true,
};

describe('generateProviderSpecificHash', () => {
  it('returns a base64 string for openrouter provider', async () => {
    const hash = await generateProviderSpecificHash('user123', openrouterProvider);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
    // Base64 chars only
    expect(hash).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('returns different hashes for different providers', async () => {
    const hash1 = await generateProviderSpecificHash('user123', openrouterProvider);
    const hash2 = await generateProviderSpecificHash('user123', gigapotatoProvider);
    expect(hash1).not.toBe(hash2);
  });

  it('returns different hashes for different payloads', async () => {
    const hash1 = await generateProviderSpecificHash('user1', openrouterProvider);
    const hash2 = await generateProviderSpecificHash('user2', openrouterProvider);
    expect(hash1).not.toBe(hash2);
  });

  it('is deterministic — same inputs produce same output', async () => {
    const hash1 = await generateProviderSpecificHash('user123', openrouterProvider);
    const hash2 = await generateProviderSpecificHash('user123', openrouterProvider);
    expect(hash1).toBe(hash2);
  });

  it('uses apiUrl as pepper for custom provider', async () => {
    const customA: Provider = { ...customProvider, apiUrl: 'https://a.example.com' };
    const customB: Provider = { ...customProvider, apiUrl: 'https://b.example.com' };
    const hash1 = await generateProviderSpecificHash('user123', customA);
    const hash2 = await generateProviderSpecificHash('user123', customB);
    expect(hash1).not.toBe(hash2);
  });

  it('produces a 44-character base64 string (SHA-256 = 32 bytes)', async () => {
    const hash = await generateProviderSpecificHash('user123', openrouterProvider);
    // SHA-256 → 32 bytes → base64: ceil(32/3)*4 = 44 chars
    expect(hash.length).toBe(44);
  });
});
