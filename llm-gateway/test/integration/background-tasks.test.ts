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

// Spy on scheduleBackgroundTasks
const bgTasksSpy = vi.fn();
vi.mock('../../src/handler/background-tasks', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/handler/background-tasks')>();
  return {
    ...mod,
    scheduleBackgroundTasks: (...args: unknown[]) => {
      bgTasksSpy(...args);
    },
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
  bgTasksSpy.mockClear();
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

describe('background tasks', () => {
  it('schedules background tasks on 200 success', async () => {
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
    // Consume the body so the stream completes and bg tasks schedule
    await res.text();
    // Allow microtask queue to flush
    await new Promise(r => setTimeout(r, 50));

    expect(bgTasksSpy).toHaveBeenCalled();
    const [_ctx, params] = bgTasksSpy.mock.calls[0];
    expect(params.accountingStream).not.toBeNull();
    expect(params.metricsStream).not.toBeNull();
    expect(params.loggingStream).not.toBeNull();
  });

  it('schedules background tasks on 400 error', async () => {
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
    await new Promise(r => setTimeout(r, 50));

    expect(bgTasksSpy).toHaveBeenCalled();
  });

  it('schedules background tasks before returning 503 for 402→503 conversion', async () => {
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

    expect(bgTasksSpy).toHaveBeenCalled();
    const [_ctx, params] = bgTasksSpy.mock.calls[0];
    expect(params.upstreamStatusCode).toBe(402);
  });
});
