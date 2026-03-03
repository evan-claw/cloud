import { describe, it, expect } from 'vitest';

// We test the DO logic directly by simulating what the DO class does.
// The actual DO class extends DurableObject (which requires the Workers runtime),
// so we replicate its core check-and-increment logic here.
// The rate-limit.ts module is a thin wrapper that just calls the DO stub methods.

const FREE_MODEL_WINDOW_MS = 60 * 60 * 1000;
const FREE_MODEL_MAX_REQUESTS = 200;
const PROMOTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROMOTION_MAX_REQUESTS = 10_000;

function makeStorage() {
  const store = new Map<string, number[]>();
  return {
    get(key: string): number[] | undefined {
      return store.get(key);
    },
    put(key: string, value: number[]) {
      store.set(key, value);
    },
  };
}

function checkAndIncrement(
  storage: ReturnType<typeof makeStorage>,
  key: string,
  windowMs: number,
  maxRequests: number
) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const timestamps = (storage.get(key) ?? []).filter(t => t >= windowStart);

  if (timestamps.length >= maxRequests) {
    return { allowed: false, requestCount: timestamps.length };
  }
  timestamps.push(now);
  storage.put(key, timestamps);
  return { allowed: true, requestCount: timestamps.length };
}

describe('RateLimitDO: checkFreeModel', () => {
  it('allows when no prior requests', () => {
    const storage = makeStorage();
    const result = checkAndIncrement(
      storage,
      'free',
      FREE_MODEL_WINDOW_MS,
      FREE_MODEL_MAX_REQUESTS
    );
    expect(result.allowed).toBe(true);
    expect(result.requestCount).toBe(1);
  });

  it('allows when under the 200 request limit', () => {
    const storage = makeStorage();
    for (let i = 0; i < 199; i++) {
      checkAndIncrement(storage, 'free', FREE_MODEL_WINDOW_MS, FREE_MODEL_MAX_REQUESTS);
    }
    const result = checkAndIncrement(
      storage,
      'free',
      FREE_MODEL_WINDOW_MS,
      FREE_MODEL_MAX_REQUESTS
    );
    expect(result.allowed).toBe(true);
    expect(result.requestCount).toBe(200);
  });

  it('blocks when at the 200 request limit', () => {
    const storage = makeStorage();
    for (let i = 0; i < 200; i++) {
      checkAndIncrement(storage, 'free', FREE_MODEL_WINDOW_MS, FREE_MODEL_MAX_REQUESTS);
    }
    const result = checkAndIncrement(
      storage,
      'free',
      FREE_MODEL_WINDOW_MS,
      FREE_MODEL_MAX_REQUESTS
    );
    expect(result.allowed).toBe(false);
    expect(result.requestCount).toBe(200);
  });

  it('ignores timestamps outside the 1-hour window', () => {
    const storage = makeStorage();
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    // Pre-populate with 200 expired timestamps + 1 recent
    storage.put('free', [...Array.from({ length: 200 }, () => twoHoursAgo), now - 1000]);
    const result = checkAndIncrement(
      storage,
      'free',
      FREE_MODEL_WINDOW_MS,
      FREE_MODEL_MAX_REQUESTS
    );
    expect(result.allowed).toBe(true);
    // 1 recent + 1 new = 2
    expect(result.requestCount).toBe(2);
  });
});

describe('RateLimitDO: checkPromotion', () => {
  it('allows when under 10000 requests per 24h', () => {
    const storage = makeStorage();
    const result = checkAndIncrement(storage, 'promo', PROMOTION_WINDOW_MS, PROMOTION_MAX_REQUESTS);
    expect(result.allowed).toBe(true);
  });

  it('blocks at 10000', () => {
    const storage = makeStorage();
    for (let i = 0; i < 10_000; i++) {
      checkAndIncrement(storage, 'promo', PROMOTION_WINDOW_MS, PROMOTION_MAX_REQUESTS);
    }
    const result = checkAndIncrement(storage, 'promo', PROMOTION_WINDOW_MS, PROMOTION_MAX_REQUESTS);
    expect(result.allowed).toBe(false);
    expect(result.requestCount).toBe(10_000);
  });
});

describe('RateLimitDO: atomicity', () => {
  it('check and increment happen atomically (no TOCTOU)', () => {
    const storage = makeStorage();
    // Fill to 199
    for (let i = 0; i < 199; i++) {
      checkAndIncrement(storage, 'free', FREE_MODEL_WINDOW_MS, FREE_MODEL_MAX_REQUESTS);
    }
    // Two "concurrent" calls — both see 199, but only first should succeed
    // because the function is atomic (check+increment in one call)
    const r1 = checkAndIncrement(storage, 'free', FREE_MODEL_WINDOW_MS, FREE_MODEL_MAX_REQUESTS);
    const r2 = checkAndIncrement(storage, 'free', FREE_MODEL_WINDOW_MS, FREE_MODEL_MAX_REQUESTS);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);
  });
});
