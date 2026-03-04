// Integration test: full middleware chain exercised end-to-end.
// All external dependencies (DB, KV, fetch) are mocked; the test runs through
// every middleware from parseBody to proxyHandler, confirming the correct
// response for several representative scenarios.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeEnv, chatRequest, fakeExecutionCtx } from './helpers';

// ── Module mocks ───────────────────────────────────────────────────────────────

// Mock @kilocode/db/client so we never hit a real Postgres
vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([]),
      }),
    }),
  }),
}));

// Mock @kilocode/worker-utils to bypass KV cache and provide extractBearerToken
vi.mock('@kilocode/worker-utils', () => ({
  userExistsWithCache: async () => true,
  extractBearerToken: (header: string | undefined) => {
    if (!header) return null;
    const parts = header.split(' ');
    return parts.length === 2 && parts[0].toLowerCase() === 'bearer' ? parts[1] : null;
  },
  verifyKiloToken: async () => {
    throw new Error('should not be called directly — verifyGatewayJwt wraps this');
  },
}));

// Keep a reference to the real globalThis.fetch
const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function dispatch(req: Request, envOverrides: Partial<Record<string, unknown>> = {}) {
  const { default: worker } = await import('../../src/index');
  const env = makeEnv(envOverrides);
  return worker.fetch!(
    req as Request<unknown, IncomingRequestCfProperties>,
    env,
    fakeExecutionCtx()
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('middleware chain – health check', () => {
  it('GET /health returns 404 (removed)', async () => {
    const res = await dispatch(new Request('http://localhost/health'));
    expect(res.status).toBe(404);
  });
});

describe('middleware chain – 404', () => {
  it('unknown path returns 404', async () => {
    const res = await dispatch(new Request('http://localhost/unknown'));
    expect(res.status).toBe(404);
  });
});

describe('middleware chain – invalid path', () => {
  it('returns 400 for /api/gateway/other (matches reference invalidPathResponse)', async () => {
    const req = new Request('http://localhost/api/gateway/other', { method: 'POST' });
    const res = await dispatch(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: 'Invalid path',
      message: 'This endpoint only accepts the path `/chat/completions`.',
    });
  });

  it('returns 400 for /api/openrouter/v1/models (matches reference invalidPathResponse)', async () => {
    const req = new Request('http://localhost/api/openrouter/v1/models', { method: 'GET' });
    const res = await dispatch(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: 'Invalid path',
      message: 'This endpoint only accepts the path `/chat/completions`.',
    });
  });
});

describe('middleware chain – body validation', () => {
  it('returns 404 for missing model (matches reference modelDoesNotExistResponse)', async () => {
    const res = await dispatch(chatRequest({ messages: [] }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: 'Model not found',
      message: 'The requested model could not be found.',
    });
  });

  it('returns 400 for invalid JSON', async () => {
    const req = new Request('http://localhost/api/gateway/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: 'not json',
    });
    const res = await dispatch(req);
    expect(res.status).toBe(400);
  });
});

describe('middleware chain – anonymous gate', () => {
  it('returns 401 for paid model without token', async () => {
    const res = await dispatch(
      chatRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PAID_MODEL_AUTH_REQUIRED');
  });
});

describe('middleware chain – route parity', () => {
  it('/api/openrouter/chat/completions works the same as /api/gateway/', async () => {
    const res = await dispatch(
      chatRequest(
        {
          model: 'anthropic/claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { path: '/api/openrouter/chat/completions' }
      )
    );
    // Should still hit anonymous-gate → 401 for paid model
    expect(res.status).toBe(401);
  });
});

describe('middleware chain – missing IP', () => {
  it('returns 400 when CF-Connecting-IP and x-forwarded-for are both absent', async () => {
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
  });
});
