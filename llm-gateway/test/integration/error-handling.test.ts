import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatch, chatRequest, signToken, VALID_USER, getTableName, chainResult } from './_setup';

// ── Configurable DB ────────────────────────────────────────────────────────────

let _userRows: Record<string, unknown>[] = [];

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table);
        if (name === 'kilocode_users') return chainResult(_userRows);
        if (name === 'credit_transactions') return chainResult([{ count: 1 }]);
        if (name === 'model_user_byok_providers') return chainResult([]);
        if (name === 'custom_llm') return chainResult([]);
        if (name === 'organizations') return chainResult([]);
        if (name === 'models_by_provider') return chainResult([]);
        return chainResult([]);
      },
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
  verifyKiloToken: async (token: string, secret: string) => {
    const { jwtVerify } = await import('jose');
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return payload as Record<string, unknown>;
  },
}));

vi.mock('@kilocode/encryption', () => ({
  timingSafeEqual: (a: string, b: string) => a === b,
}));

vi.mock('../../src/lib/abuse-service', () => ({
  classifyAbuse: async () => null,
  reportAbuseCost: async () => null,
}));

// Spy on Sentry captureException
const captureExceptionSpy = vi.fn();
vi.mock('../../src/lib/sentry', () => ({
  SENTRY_DSN: 'https://fake@sentry.io/123',
  captureException: (...args: unknown[]) => captureExceptionSpy(...args) as void,
}));

// Also mock @sentry/cloudflare to prevent real Sentry initialization
vi.mock('@sentry/cloudflare', () => ({
  withSentry: (_config: unknown, handler: { fetch: unknown }) => handler,
  captureException: () => {},
}));

// Polyfill scheduler.wait for Node
if (!(globalThis as Record<string, unknown>).scheduler) {
  (globalThis as Record<string, unknown>).scheduler = {
    wait: (ms: number) => new Promise(r => setTimeout(r, ms)),
  };
}

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _userRows = [{ ...VALID_USER }];
  captureExceptionSpy.mockClear();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function authRequest(body: Record<string, unknown>) {
  const token = await signToken({ kiloUserId: 'user-1' });
  return chatRequest(body, { token });
}

describe('error handling', () => {
  it('unhandled middleware exception returns 500 Internal server error', async () => {
    // Trigger an error by having fetch throw an exception
    fetchMock.mockRejectedValueOnce(new Error('network failure'));

    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(500);
    const body: { error: string } = await res.json();
    expect(body.error).toContain('Internal server error');
  });

  it('captureException called for upstream 5xx', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    );

    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(500);
    await res.text();
    // Allow waitUntil microtasks to flush
    await new Promise(r => setTimeout(r, 100));

    expect(captureExceptionSpy).toHaveBeenCalled();
    const err = captureExceptionSpy.mock.calls[0][0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('500');
  });

  it('captureException NOT called for upstream 4xx (non-402)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Bad Request' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    );

    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(400);
    await res.text();
    await new Promise(r => setTimeout(r, 100));

    // captureException should not be called for 4xx (only called for 5xx and 402→503)
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it('captureException called for 402→503 conversion', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Payment Required' }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      })
    );

    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(503);

    expect(captureExceptionSpy).toHaveBeenCalled();
    const err = captureExceptionSpy.mock.calls[0][0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('402');
  });
});
