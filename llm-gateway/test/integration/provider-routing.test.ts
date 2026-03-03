import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dispatch,
  chatRequest,
  signToken,
  VALID_USER,
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
  opts: { headers?: Record<string, string>; path?: string } = {}
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

function getUpstreamUrl(): string {
  return fetchMock.mock.calls[0][0] as string;
}

function getUpstreamInit(): RequestInit & { headers: Headers } {
  return fetchMock.mock.calls[0][1] as RequestInit & { headers: Headers };
}

describe('provider routing', () => {
  it('corethink:free routes to api.corethink.ai/v1/code/chat/completions', async () => {
    mockUpstream200();
    const res = await dispatch(
      chatRequest({
        model: 'corethink:free',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    const url = getUpstreamUrl();
    expect(url).toContain('api.corethink.ai/v1/code/chat/completions');
  });

  it('giga-potato routes to gigapotato API URL', async () => {
    mockUpstream200();
    const res = await dispatch(
      chatRequest({
        model: 'giga-potato',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    const url = getUpstreamUrl();
    expect(url).toContain('gigapotato.example.com');
    expect(url).toContain('/chat/completions');
  });

  it('generic :free model routes to openrouter.ai/api/v1/chat/completions', async () => {
    mockUpstream200();
    // Use a :free model that is NOT rate-limited, NOT a Kilo free model, NOT in preferredModels
    const res = await dispatch(
      chatRequest({
        model: 'deepseek/deepseek-v3-0324:free',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    const url = getUpstreamUrl();
    expect(url).toContain('openrouter.ai');
    expect(url).toContain('/chat/completions');
  });

  it('paid model routes to openrouter.ai', async () => {
    mockUpstream200();
    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    const url = getUpstreamUrl();
    expect(url).toContain('openrouter.ai');
    expect(url).toContain('/chat/completions');
  });

  it('upstream gets Authorization, HTTP-Referer, X-Title, Content-Type headers', async () => {
    mockUpstream200();
    const res = await dispatch(
      await authRequest({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    const init = getUpstreamInit();
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toMatch(/^Bearer /);
    expect(headers.get('HTTP-Referer')).toBe('https://kilocode.ai');
    expect(headers.get('X-Title')).toBe('Kilo Code');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('query string preserved in upstream URL', async () => {
    mockUpstream200();
    const res = await dispatch(
      await authRequest(
        {
          model: 'anthropic/claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { path: '/api/gateway/chat/completions?foo=bar&baz=1' }
      )
    );
    expect(res.status).toBe(200);
    await res.text();

    const url = getUpstreamUrl();
    expect(url).toContain('?foo=bar&baz=1');
  });

  it('Kilo free model internal_id replaces public_id in upstream body', async () => {
    mockUpstream200();
    const res = await dispatch(
      chatRequest({
        model: 'corethink:free',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    // corethink:free has internal_id 'corethink' — the model sent upstream should be 'corethink'
    // (parseBody lowercases and the provider-specific logic may strip the :free suffix)
    expect(body.model).not.toContain(':free');
    // The upstream URL should be the corethink endpoint, not openrouter
    const url = getUpstreamUrl();
    expect(url).toContain('corethink');
  });
});
