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

// Spy on scheduleBackgroundTasks
const bgTasksSpy = vi.fn();
vi.mock('../../src/handler/background-tasks', async importOriginal => {
  const mod = await importOriginal();
  return {
    ...(mod as Record<string, unknown>),
    scheduleBackgroundTasks: (...args: unknown[]) => {
      bgTasksSpy(...args);
    },
  };
});

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
  bgTasksSpy.mockClear();
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

describe('auto-model resolution', () => {
  it('kilo/auto without mode resolves to code model (claude-sonnet)', async () => {
    mockUpstream200();
    const res = await dispatch(
      await authRequest({
        model: 'kilo/auto',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    // The upstream URL should go to openrouter (paid model)
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('chat/completions');

    // The body should have the resolved model (claude-sonnet)
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.model).toContain('claude-sonnet');
  });

  it('kilo/auto with x-kilocode-mode: plan resolves to plan model', async () => {
    mockUpstream200();
    const res = await dispatch(
      await authRequest(
        {
          model: 'kilo/auto',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { headers: { 'x-kilocode-mode': 'plan' } }
      )
    );
    expect(res.status).toBe(200);
    await res.text();

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    // plan mode resolves to claude-opus
    expect(body.model).toContain('claude-opus');
  });

  it('kilo/auto-free resolves to free model', async () => {
    mockUpstream200();
    // kilo/auto-free resolves to minimax/minimax-m2.5:free which is a free model
    // The anonymous path should work too
    const res = await dispatch(
      chatRequest({
        model: 'kilo/auto-free',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.model).toContain('minimax');
  });

  it('kilo/auto sets autoModel in background task params', async () => {
    mockUpstream200();
    const res = await dispatch(
      await authRequest({
        model: 'kilo/auto',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(res.status).toBe(200);
    await res.text();
    await new Promise(r => setTimeout(r, 50));

    expect(bgTasksSpy).toHaveBeenCalled();
    const params = bgTasksSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(params.autoModel).toBe('kilo/auto');
  });
});
