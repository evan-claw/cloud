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

describe('promotionLimit', () => {
  it('returns 401 with PROMOTION_MODEL_LIMIT_REACHED for anonymous + free model when DO promotion blocked', async () => {
    const doNamespace = makeFakeDONamespace({ promotionBlocked: new Set(['1.2.3.4']) });
    const res = await dispatch(
      chatRequest({
        model: 'some-vendor/some-model:free',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      { RATE_LIMIT_DO: doNamespace }
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('PROMOTION_MODEL_LIMIT_REACHED');
    expect(body.error.message).toContain('Sign up for free');
  });
});
