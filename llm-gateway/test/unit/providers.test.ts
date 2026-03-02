import { describe, it, expect } from 'vitest';
import { getPreferredProviderOrder, buildProviders } from '../../src/lib/providers';
import type { SecretsBundle } from '../../src/lib/providers';

const testSecrets: SecretsBundle = {
  openrouterApiKey: 'or-key',
  gigapotatoApiKey: 'gp-key',
  gigapotatoApiUrl: 'https://gp.example.com/v1',
  corethinkApiKey: 'ct-key',
  martianApiKey: 'mt-key',
  mistralApiKey: 'ms-key',
  vercelAiGatewayApiKey: 'vg-key',
  byokEncryptionKey: 'bk-key',
};

describe('buildProviders', () => {
  it('returns correct URLs and keys for OPENROUTER', () => {
    const p = buildProviders(testSecrets);
    expect(p.OPENROUTER.apiUrl).toBe('https://openrouter.ai/api/v1');
    expect(p.OPENROUTER.apiKey).toBe('or-key');
    expect(p.OPENROUTER.hasGenerationEndpoint).toBe(true);
  });

  it('uses provided GIGAPOTATO_API_URL', () => {
    const p = buildProviders(testSecrets);
    expect(p.GIGAPOTATO.apiUrl).toBe('https://gp.example.com/v1');
    expect(p.GIGAPOTATO.hasGenerationEndpoint).toBe(false);
  });

  it('VERCEL_AI_GATEWAY has generation endpoint', () => {
    const p = buildProviders(testSecrets);
    expect(p.VERCEL_AI_GATEWAY.hasGenerationEndpoint).toBe(true);
  });
});

describe('getPreferredProviderOrder', () => {
  it('routes anthropic models to bedrock first', () => {
    expect(getPreferredProviderOrder('anthropic/claude-sonnet-4')).toEqual([
      'amazon-bedrock',
      'anthropic',
    ]);
  });

  it('routes minimax models to minimax', () => {
    expect(getPreferredProviderOrder('minimax/minimax-m2.5')).toEqual(['minimax']);
  });

  it('routes mistralai models to mistral', () => {
    expect(getPreferredProviderOrder('mistralai/devstral')).toEqual(['mistral']);
  });

  it('returns empty for openai models', () => {
    expect(getPreferredProviderOrder('openai/gpt-4o')).toEqual([]);
  });

  it('returns empty for unknown models', () => {
    expect(getPreferredProviderOrder('unknown/model')).toEqual([]);
  });
});
