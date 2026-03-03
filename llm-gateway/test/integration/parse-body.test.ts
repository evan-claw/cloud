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

describe('parseBody', () => {
  it('returns 400 for non-JSON body', async () => {
    const req = new Request('http://localhost/api/gateway/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: 'not json',
    });
    const res = await dispatch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Invalid request',
      message: 'Could not parse request body. Please ensure it is valid JSON.',
    });
  });

  it('returns 404 for missing model field', async () => {
    const res = await dispatch(chatRequest({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Model not found',
      message: 'The requested model could not be found.',
    });
  });

  it('returns 404 for empty string model', async () => {
    const res = await dispatch(
      chatRequest({ model: '', messages: [{ role: 'user', content: 'hi' }] })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Model not found',
      message: 'The requested model could not be found.',
    });
  });

  it('returns 404 for non-string model', async () => {
    const res = await dispatch(
      chatRequest({ model: 123, messages: [{ role: 'user', content: 'hi' }] })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Model not found',
      message: 'The requested model could not be found.',
    });
  });
});
