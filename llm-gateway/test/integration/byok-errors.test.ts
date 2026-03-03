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

// Mock BYOK module to return BYOK keys for the test user.
// This bypasses DB+crypto complexity while exercising the full
// provider-resolution → proxy → makeErrorReadable chain.
vi.mock('../../src/lib/byok', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/lib/byok')>();
  return {
    ...mod,
    getModelUserByokProviders: async () => ['anthropic'],
    getBYOKforUser: async () => [{ decryptedAPIKey: 'sk-test-byok', providerId: 'anthropic' }],
    getBYOKforOrganization: async () => null,
  };
});

// Polyfill scheduler.wait for Node
if (!globalThis.scheduler) {
  (globalThis as Record<string, unknown>).scheduler = {
    wait: (ms: number) => new Promise(r => setTimeout(r, ms)),
  };
}

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _userRows = [{ ...VALID_USER }];
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

describe('BYOK errors', () => {
  it('BYOK user: upstream 401 → response with [BYOK] invalid key message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );

    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('[BYOK]');
    expect(body.error).toContain('invalid');
  });

  it('BYOK user: upstream 402 → response with [BYOK] insufficient funds', async () => {
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
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('[BYOK]');
    expect(body.error).toContain('insufficient funds');
  });

  it('BYOK user: upstream 403 → response with [BYOK] no permission', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    );

    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('[BYOK]');
    expect(body.error).toContain('permission');
  });

  it('BYOK user: upstream 429 → response with [BYOK] rate limit', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Too Many Requests' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    );

    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('[BYOK]');
    expect(body.error).toContain('rate limit');
  });

  it('BYOK user: upstream 402 is NOT converted to 503 (only non-BYOK gets 503)', async () => {
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
    // BYOK 402 should remain 402, NOT be converted to 503
    expect(res.status).toBe(402);
    expect(res.status).not.toBe(503);
  });
});
