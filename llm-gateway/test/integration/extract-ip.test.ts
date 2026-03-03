import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatch, chainResult } from './_setup';

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

describe('extractIp', () => {
  it('returns 400 when both CF-Connecting-IP and x-forwarded-for are absent', async () => {
    const req = new Request('http://localhost/api/gateway/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'corethink:free',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const res = await dispatch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unable to determine client IP' });
  });

  it('proceeds past IP check when only x-forwarded-for is present', async () => {
    const req = new Request('http://localhost/api/gateway/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '5.6.7.8, 9.10.11.12',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const res = await dispatch(req);
    // Should proceed past IP extraction. Without auth, a paid model → 401
    expect(res.status).toBe(401);
  });
});
