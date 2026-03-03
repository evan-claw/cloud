import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatch, chatRequest, signToken, VALID_USER, getTableName, chainResult } from './_setup';

// ── DB mock ────────────────────────────────────────────────────────────────────

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

describe('happy path', () => {
  it('anonymous + corethink:free → 200, model rewritten, upstream URL contains corethink', async () => {
    const upstreamBody = {
      id: 'chatcmpl-1',
      model: 'corethink-internal',
      choices: [{ message: { role: 'assistant', content: 'Hello from corethink!' } }],
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

    expect(fetchMock).toHaveBeenCalled();
    const [fetchUrl] = fetchMock.mock.calls[0];
    expect(fetchUrl).toContain('corethink');

    const body = (await res.json()) as { model: string; usage: { cost?: number } };
    expect(body.model).toBe('corethink:free');
    expect(body.usage.cost).toBeUndefined();
  });

  it('authenticated + anthropic/claude-sonnet-4-20250514 → 200, upstream URL contains openrouter', async () => {
    const upstreamBody = {
      id: 'chatcmpl-2',
      model: 'anthropic/claude-sonnet-4-20250514',
      choices: [{ message: { role: 'assistant', content: 'Hello from Claude!' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const token = await signToken({ kiloUserId: 'user-1' });
    const res = await dispatch(
      chatRequest(
        {
          model: 'anthropic/claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { token }
      )
    );
    expect(res.status).toBe(200);

    expect(fetchMock).toHaveBeenCalled();
    const [fetchUrl] = fetchMock.mock.calls[0];
    expect(fetchUrl).toContain('openrouter.ai');

    const body = (await res.json()) as { model: string };
    expect(body.model).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('anonymous + giga-potato → 200, upstream URL contains gigapotato', async () => {
    const upstreamBody = {
      id: 'chatcmpl-3',
      model: 'ep-20260109111813-hztxv',
      choices: [{ message: { role: 'assistant', content: 'Hello from giga-potato!' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 },
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

    expect(fetchMock).toHaveBeenCalled();
    const [fetchUrl] = fetchMock.mock.calls[0];
    expect(fetchUrl).toContain('gigapotato');

    const body = (await res.json()) as { model: string };
    expect(body.model).toBe('giga-potato');
  });
});
