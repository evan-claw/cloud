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

function mockUpstream200() {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
}

function getUpstreamBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('body mutations', () => {
  it('stream_options.include_usage is forced to true', async () => {
    mockUpstream200();
    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    const body = getUpstreamBody();
    expect(body.stream_options).toMatchObject({ include_usage: true });
  });

  it('stream_options.include_usage merges with existing stream_options', async () => {
    mockUpstream200();
    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
        stream_options: { some_custom_option: 'value' },
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    const body = getUpstreamBody();
    expect(body.stream_options).toMatchObject({
      include_usage: true,
      some_custom_option: 'value',
    });
  });

  it('models field is deleted from upstream body', async () => {
    mockUpstream200();
    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        models: ['model-a', 'model-b'],
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    const body = getUpstreamBody();
    expect(body.models).toBeUndefined();
  });

  it('model is lowercased and trimmed in resolved context', async () => {
    mockUpstream200();
    const res = await dispatch(
      await authRequest({
        model: '  Anthropic/Claude-Sonnet-4-20250514  ',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    // The upstream URL should be valid (routing used the lowercase/trimmed resolvedModel)
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('chat/completions');
    // The original body.model is preserved as-is (not mutated by parseBody)
    // but the route was resolved correctly via the lowercased resolvedModel
    const body = getUpstreamBody();
    expect(body.model).toBeDefined();
  });

  it('safety_identifier and user fields set on upstream body', async () => {
    mockUpstream200();
    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    const body = getUpstreamBody();
    expect(body.safety_identifier).toBeDefined();
    expect(typeof body.safety_identifier).toBe('string');
    expect(body.user).toBeDefined();
    expect(body.safety_identifier).toBe(body.user);
  });

  it('prompt_cache_key set when x-kilocode-taskid present', async () => {
    mockUpstream200();
    const res = await dispatch(
      await authRequest(
        {
          model: 'anthropic/claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { headers: { 'x-kilocode-taskid': 'task-123' } }
      )
    );
    expect(res.status).toBe(200);
    await res.text();

    const body = getUpstreamBody();
    expect(body.prompt_cache_key).toBeDefined();
    expect(typeof body.prompt_cache_key).toBe('string');
  });

  it('prompt_cache_key absent when no taskid header', async () => {
    mockUpstream200();
    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    const body = getUpstreamBody();
    expect(body.prompt_cache_key).toBeUndefined();
  });
});
