import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkFreeModelRateLimit,
  checkPromotionLimit,
  incrementFreeModelUsage,
} from '../../src/lib/rate-limit';

function makeKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

describe('checkFreeModelRateLimit', () => {
  it('allows when no prior requests', async () => {
    const kv = makeKv();
    const result = await checkFreeModelRateLimit(kv, '1.2.3.4');
    expect(result.allowed).toBe(true);
    expect(result.requestCount).toBe(0);
  });

  it('allows when under the 200 request limit', async () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 199 }, (_, i) => now - i * 1000);
    const kv = makeKv({ 'rl:free:1.2.3.4': JSON.stringify(timestamps) });
    const result = await checkFreeModelRateLimit(kv, '1.2.3.4');
    expect(result.allowed).toBe(true);
    expect(result.requestCount).toBe(199);
  });

  it('blocks when at the 200 request limit', async () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 200 }, (_, i) => now - i * 1000);
    const kv = makeKv({ 'rl:free:1.2.3.4': JSON.stringify(timestamps) });
    const result = await checkFreeModelRateLimit(kv, '1.2.3.4');
    expect(result.allowed).toBe(false);
  });

  it('ignores timestamps outside the 1-hour window', async () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    // 200 old timestamps + 1 recent — should be allowed (only 1 in window)
    const timestamps = [...Array.from({ length: 200 }, () => twoHoursAgo), now - 1000];
    const kv = makeKv({ 'rl:free:1.2.3.4': JSON.stringify(timestamps) });
    const result = await checkFreeModelRateLimit(kv, '1.2.3.4');
    expect(result.allowed).toBe(true);
    expect(result.requestCount).toBe(1);
  });
});

describe('checkPromotionLimit', () => {
  it('allows when under 10000 requests per 24h', async () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 9999 }, (_, i) => now - i * 1000);
    const kv = makeKv({ 'rl:promo:1.2.3.4': JSON.stringify(timestamps) });
    const result = await checkPromotionLimit(kv, '1.2.3.4');
    expect(result.allowed).toBe(true);
  });

  it('blocks at 10000', async () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 10000 }, (_, i) => now - i * 1000);
    const kv = makeKv({ 'rl:promo:1.2.3.4': JSON.stringify(timestamps) });
    const result = await checkPromotionLimit(kv, '1.2.3.4');
    expect(result.allowed).toBe(false);
  });
});

describe('incrementFreeModelUsage', () => {
  it('appends a timestamp and persists', async () => {
    const kv = makeKv();
    await incrementFreeModelUsage(kv, '1.2.3.4');
    const raw = await kv.get('rl:free:1.2.3.4');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(typeof parsed[0]).toBe('number');
  });
});
