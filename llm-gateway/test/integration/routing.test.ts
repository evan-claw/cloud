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

describe('routing', () => {
  it('returns 400 for POST /api/gateway/foo (invalid sub-path)', async () => {
    const req = new Request('http://localhost/api/gateway/foo', { method: 'POST' });
    const res = await dispatch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Invalid path',
      message: 'This endpoint only accepts the path `/chat/completions`.',
    });
  });

  it('returns 400 for POST /api/openrouter/models', async () => {
    const req = new Request('http://localhost/api/openrouter/models', { method: 'POST' });
    const res = await dispatch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Invalid path',
      message: 'This endpoint only accepts the path `/chat/completions`.',
    });
  });

  it('returns 404 for POST /completely/unknown', async () => {
    const req = new Request('http://localhost/completely/unknown', { method: 'POST' });
    const res = await dispatch(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not found' });
  });

  it('returns 400 for GET /api/gateway/chat/completions (wrong method falls to notFound)', async () => {
    const req = new Request('http://localhost/api/gateway/chat/completions', { method: 'GET' });
    const res = await dispatch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Invalid path',
      message: 'This endpoint only accepts the path `/chat/completions`.',
    });
  });

  it('both /api/gateway/ and /api/openrouter/ proceed past routing', async () => {
    const makeReq = (path: string) =>
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
        body: 'not json',
      });

    const res1 = await dispatch(makeReq('/api/gateway/chat/completions'));
    expect(res1.status).toBe(400);
    const body1 = await res1.json();
    expect(body1.error).toBe('Invalid request');

    const res2 = await dispatch(makeReq('/api/openrouter/chat/completions'));
    expect(res2.status).toBe(400);
    const body2 = await res2.json();
    expect(body2.error).toBe('Invalid request');
  });
});
