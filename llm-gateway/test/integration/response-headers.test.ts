import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dispatch,
  chatRequest,
  signToken,
  VALID_USER,
  sseChunk,
  sseDone,
  getTableName,
  chainResult,
} from './_setup';

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
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function authRequest(
  body: Record<string, unknown>,
  opts: { headers?: Record<string, string> } = {}
) {
  const token = await signToken({ kiloUserId: 'user-1' });
  return chatRequest(body, { token, ...opts });
}

describe('response headers', () => {
  it('Content-Encoding: identity on 200 JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Encoding')).toBe('identity');
  });

  it('Content-Encoding: identity on 200 SSE', async () => {
    const sseBody =
      sseChunk({
        id: 'chatcmpl-1',
        model: 'anthropic/claude-sonnet-4-20250514',
        choices: [{ delta: { content: 'Hi' } }],
      }) + sseDone();

    fetchMock.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Encoding')).toBe('identity');
  });

  it('Content-Encoding: identity on free model rewritten response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: 'corethink-internal',
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const res = await dispatch(
      chatRequest({
        model: 'corethink:free',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Encoding')).toBe('identity');
  });

  it('upstream date header preserved', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          date: 'Mon, 03 Mar 2026 12:00:00 GMT',
        },
      })
    );

    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('date')).toBe('Mon, 03 Mar 2026 12:00:00 GMT');
  });

  it('upstream content-type header preserved', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    );

    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('upstream request-id header preserved', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'request-id': 'req-abc-123',
        },
      })
    );

    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('request-id')).toBe('req-abc-123');
  });

  it('unknown upstream headers (x-ratelimit-remaining, x-custom, etc.) stripped', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '99',
          'x-custom': 'secret-value',
          server: 'openrouter',
          'x-request-id': 'or-abc',
        },
      })
    );

    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.has('x-ratelimit-remaining')).toBe(false);
    expect(res.headers.has('x-custom')).toBe(false);
    expect(res.headers.has('server')).toBe(false);
    expect(res.headers.has('x-request-id')).toBe(false);
  });
});
