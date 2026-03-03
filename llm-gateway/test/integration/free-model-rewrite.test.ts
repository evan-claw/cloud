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

describe('free model rewrite', () => {
  it('auth user + corethink:free JSON: model rewritten, cost stripped', async () => {
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
      await authRequest({
        model: 'corethink:free',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string; usage: { cost?: number } };
    expect(body.model).toBe('corethink:free');
    expect(body.usage.cost).toBeUndefined();
  });

  it('auth user + corethink:free SSE: model rewritten in every chunk', async () => {
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
      await authRequest({
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

  it('reasoning_content converted to reasoning + reasoning_details in JSON', async () => {
    const upstreamBody = {
      id: 'chatcmpl-1',
      model: 'corethink-internal',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Answer here',
            reasoning_content: 'Let me think step by step...',
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
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
        messages: [{ role: 'user', content: 'think about this' }],
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const message = (body as { choices: Array<{ message: Record<string, unknown> }> }).choices[0]
      .message;
    expect(message.reasoning).toBe('Let me think step by step...');
    expect(message.reasoning_details).toEqual([
      { type: 'reasoning.text', text: 'Let me think step by step...' },
    ]);
    expect(message.reasoning_content).toBeUndefined();
  });

  it('reasoning_content converted to reasoning + reasoning_details in SSE delta', async () => {
    const sseBody =
      sseChunk({
        id: 'chatcmpl-1',
        model: 'corethink-internal',
        choices: [
          {
            delta: {
              reasoning_content: 'Step 1: analyze...',
              content: '',
            },
          },
        ],
      }) + sseDone();

    fetchMock.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    const res = await dispatch(
      chatRequest({
        model: 'corethink:free',
        messages: [{ role: 'user', content: 'think' }],
        stream: true,
      })
    );
    expect(res.status).toBe(200);
    const events = await readSSEEvents(res);
    const first = events[0] as {
      choices: Array<{
        delta: {
          reasoning?: string;
          reasoning_details?: Array<{ type: string; text: string }>;
          reasoning_content?: string;
        };
      }>;
    };
    const delta = first.choices[0].delta;
    expect(delta.reasoning).toBe('Step 1: analyze...');
    expect(delta.reasoning_details).toEqual([
      { type: 'reasoning.text', text: 'Step 1: analyze...' },
    ]);
    expect(delta.reasoning_content).toBeUndefined();
  });

  it('cost, cost_details, is_byok stripped from JSON usage', async () => {
    const upstreamBody = {
      id: 'chatcmpl-1',
      model: 'corethink-internal',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        cost: 0.001,
        cost_details: { input: 0.0005, output: 0.0005 },
        is_byok: false,
      },
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
    const body = await res.json();
    const usage = (body as { usage: Record<string, unknown> }).usage;
    expect(usage.cost).toBeUndefined();
    expect(usage.cost_details).toBeUndefined();
    expect(usage.is_byok).toBeUndefined();
    // Preserved fields should remain
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.completion_tokens).toBe(5);
  });

  it('cost, cost_details, is_byok stripped from SSE final chunk usage', async () => {
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
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          cost: 0.001,
          cost_details: { input: 0.0005 },
          is_byok: false,
        },
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
    const usageEvent = events.find(
      e => (e as { usage?: unknown }).usage !== undefined
    ) as { usage: Record<string, unknown> } | undefined;
    expect(usageEvent).toBeDefined();
    expect(usageEvent!.usage.cost).toBeUndefined();
    expect(usageEvent!.usage.cost_details).toBeUndefined();
    expect(usageEvent!.usage.is_byok).toBeUndefined();
    expect(usageEvent!.usage.prompt_tokens).toBe(10);
  });

  it('giga-potato response model rewritten from internal ep-* to giga-potato', async () => {
    const upstreamBody = {
      id: 'chatcmpl-1',
      model: 'ep-20260109111813-hztxv',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0 },
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const res = await dispatch(
      chatRequest({
        model: 'giga-potato',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string };
    expect(body.model).toBe('giga-potato');
  });
});
