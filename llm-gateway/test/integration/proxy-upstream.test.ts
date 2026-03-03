import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dispatch,
  chatRequest,
  signToken,
  VALID_USER,
  sseChunk,
  sseDone,
  readSSEEvents,
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

async function authRequest(
  body: Record<string, unknown>,
  opts: { headers?: Record<string, string> } = {}
) {
  const token = await signToken({ kiloUserId: 'user-1' });
  return chatRequest(body, { token, ...opts });
}

describe('proxy upstream', () => {
  it('returns 200 JSON for paid model (non-streaming)', async () => {
    const upstreamBody = {
      id: 'chatcmpl-1',
      model: 'anthropic/claude-sonnet-4-20250514',
      choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamBody), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-secret': 'should-be-stripped',
          date: 'Mon, 03 Mar 2026 00:00:00 GMT',
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
    expect(res.headers.get('Content-Encoding')).toBe('identity');
    expect(res.headers.has('x-secret')).toBe(false);
    const body = await res.json();
    expect(body).toMatchObject({ choices: [{ message: { content: 'Hello!' } }] });
  });

  it('returns 200 SSE for paid model (streaming)', async () => {
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
    const text = await res.text();
    expect(text).toContain('data:');
  });

  it('rewrites model field in 200 JSON for free anonymous model', async () => {
    const upstreamBody = {
      id: 'chatcmpl-1',
      model: 'corethink-internal',
      choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const res = await dispatch(
      chatRequest({
        model: 'corethink:free',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string; usage: { cost?: number } };
    expect(body.model).toBe('corethink:free');
    expect(body.usage.cost).toBeUndefined();
  });

  it('rewrites model in SSE chunks for free anonymous model', async () => {
    const sseBody =
      sseChunk({
        id: 'chatcmpl-1',
        model: 'corethink-internal',
        choices: [{ delta: { content: 'Hi' } }],
      }) +
      sseChunk({
        id: 'chatcmpl-1',
        model: 'corethink-internal',
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      }) +
      sseDone();

    fetchMock.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    const res = await dispatch(
      chatRequest({
        model: 'corethink:free',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
    );
    expect(res.status).toBe(200);
    const events = await readSSEEvents(res);
    for (const event of events) {
      const e = event as { model: string; usage?: { cost?: number } };
      expect(e.model).toBe('corethink:free');
      if (e.usage) {
        expect(e.usage.cost).toBeUndefined();
      }
    }
  });

  it('converts 402 to 503 for non-BYOK', async () => {
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
    const body = await res.json();
    expect(body).toEqual({
      error: 'Service Unavailable',
      message: 'The service is temporarily unavailable. Please try again later.',
    });
  });

  it('passes through 500 from upstream', async () => {
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
  });

  it('passes through 400 from upstream', async () => {
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
  });

  it('returns context_length error for Kilo free model exceeding context', async () => {
    // corethink:free has context_length: 78_000
    // Need estimated token count > 78_000: JSON.stringify(request).length / 4 + max_output_tokens
    const bigMessage = 'x'.repeat(320_000);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'some upstream error' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    );

    const res = await dispatch(
      chatRequest({
        model: 'corethink:free',
        messages: [{ role: 'user', content: bigMessage }],
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('context length');
    expect(body.error).toContain('tokens');
  });

  it('returns stealth model error for giga-potato on 4xx', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'some error' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    );

    const res = await dispatch(
      chatRequest({
        model: 'giga-potato',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Stealth model unable to process request');
  });

  describe('BYOK errors', () => {
    // BYOK detection requires real DB interaction (model_user_byok_providers + user_byok_keys)
    // and AES-256-GCM decryption. These error messages are tested in unit tests
    // for makeErrorReadable. Integration-level BYOK tests would need a more complete
    // DB mock with BYOK key data and encryption stubs.
    it.skip('BYOK 401 → [BYOK] invalid key', () => {});
    it.skip('BYOK 402 → [BYOK] insufficient funds', () => {});
    it.skip('BYOK 403 → [BYOK] permission', () => {});
    it.skip('BYOK 429 → [BYOK] rate limit', () => {});
  });
});
