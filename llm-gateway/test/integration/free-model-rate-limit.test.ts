import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatch, chatRequest, makeFakeDONamespace, chainResult } from './_setup';

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: () => chainResult([]),
    }),
    insert: () => chainResult([]),
    execute: () => Promise.resolve({ rows: [] }),
  }),
}));

vi.mock('@kilocode/worker-utils', () => ({
  userExistsWithCache: async () => true,
  extractBearerToken: (header: string | undefined) => {
    if (!header) return null;
    const parts = header.split(' ');
    return parts.length === 2 && parts[0].toLowerCase() === 'bearer' ? parts[1] : null;
  },
  verifyKiloToken: async () => {
    throw new Error('should not be called directly');
  },
}));

vi.mock('../../src/lib/abuse-service', () => ({
  classifyAbuse: async () => null,
  reportAbuseCost: async () => null,
}));

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('freeModelRateLimit', () => {
  it('returns 429 for Kilo free model when DO reports blocked', async () => {
    const doNamespace = makeFakeDONamespace({ freeModelBlocked: new Set(['1.2.3.4']) });
    const res = await dispatch(
      chatRequest({
        model: 'corethink:free',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      { RATE_LIMIT_DO: doNamespace }
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Rate limit exceeded',
      message: 'Free model usage limit reached. Please try again later or upgrade to a paid model.',
    });
  });

  it('skips Kilo-specific rate limit for non-Kilo :free model', async () => {
    // some-model:free is not a Kilo free model, so freeModelRateLimit should be skipped.
    // Even if DO would block, the middleware should not check it.
    const doNamespace = makeFakeDONamespace({ freeModelBlocked: new Set(['1.2.3.4']) });
    const res = await dispatch(
      chatRequest({
        model: 'some-vendor/some-model:free',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      { RATE_LIMIT_DO: doNamespace }
    );
    // Non-Kilo :free model without auth → anonymous gate allows (it's a free model)
    // Then continues down the chain. Should NOT be 429.
    expect(res.status).not.toBe(429);
  });
});
