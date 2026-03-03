import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatch, chatRequest, chainResult } from './_setup';

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

describe('requestValidation', () => {
  it('returns 503 for max_tokens exceeding limit on free model', async () => {
    // Anonymous + free model to get past auth + anonymous-gate
    const res = await dispatch(
      chatRequest({
        model: 'some-vendor/some-model:free',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100_000_000_000,
      })
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Service Unavailable',
      message: 'The service is temporarily unavailable. Please try again later.',
    });
  });

  it('returns 503 for max_completion_tokens exceeding limit', async () => {
    const res = await dispatch(
      chatRequest({
        model: 'some-vendor/some-model:free',
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 100_000_000_000,
      })
    );
    expect(res.status).toBe(503);
    const body: { error: string } = await res.json();
    expect(body.error).toBe('Service Unavailable');
  });

  it('returns 404 for dead free model', async () => {
    const res = await dispatch(
      chatRequest({
        model: 'x-ai/grok-code-fast-1:optimized:free',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(404);
    const body: { error: string } = await res.json();
    expect(body.error).toContain('alpha period');
  });

  it('returns 404 for rate-limited-to-death model', async () => {
    const res = await dispatch(
      chatRequest({
        model: 'deepseek/deepseek-r1-0528:free',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(404);
    const body: { error: string } = await res.json();
    expect(body.error).toBe('Model not found');
  });
});
