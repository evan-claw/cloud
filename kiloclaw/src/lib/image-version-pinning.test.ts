import { describe, it, expect, vi } from 'vitest';
import { lookupVersion } from './image-version';

function createFakeKV(data: Record<string, unknown>) {
  return {
    get: vi.fn(async (key: string, format?: string) => {
      const value = data[key];
      if (value === undefined) return null;
      return format === 'json' ? value : JSON.stringify(value);
    }),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  } as unknown as KVNamespace;
}

describe('lookupVersion', () => {
  it('returns entry for a valid version+variant', async () => {
    const entry = {
      openclawVersion: '2026.2.9',
      variant: 'default',
      imageTag: 'dev-123',
      imageDigest: 'sha256:abc',
      publishedAt: '2026-02-20T00:00:00Z',
    };
    const kv = createFakeKV({ 'image-version:2026.2.9:default': entry });

    const result = await lookupVersion(kv, '2026.2.9', 'default');
    expect(result).toEqual(entry);
  });

  it('returns null for missing version', async () => {
    const kv = createFakeKV({});
    const result = await lookupVersion(kv, '9999.0.0', 'default');
    expect(result).toBeNull();
  });

  it('returns null for invalid entry shape', async () => {
    const kv = createFakeKV({ 'image-version:bad:default': { garbage: true } });
    const result = await lookupVersion(kv, 'bad', 'default');
    expect(result).toBeNull();
  });
});
