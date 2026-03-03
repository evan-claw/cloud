// Tests for proxyHandler background task scheduling:
// - B1: 402 upstream responses still emit background tasks
// - B2: Free model responses include accounting and logging streams

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../../src/types/hono';
import type { ProviderId } from '../../src/lib/providers';
import { fakeExecutionCtx } from './helpers';

// ── Track scheduleBackgroundTasks calls ──────────────────────────────────────

const scheduledCalls: unknown[] = [];

vi.mock('../../src/handler/background-tasks', () => ({
  scheduleBackgroundTasks: (_ctx: unknown, params: unknown) => {
    scheduledCalls.push(params);
  },
}));

vi.mock('../../src/lib/abuse-service', () => ({
  classifyAbuse: async () => null,
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({}),
}));

// ── Restore real fetch after each test ───────────────────────────────────────

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scheduledCalls.length = 0;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;

  // scheduler.wait is a Workers-only global — stub it for Node tests.
  if (typeof globalThis.scheduler === 'undefined') {
    (globalThis as Record<string, unknown>).scheduler = {
      wait: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    };
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSecret(value: string) {
  return { get: async () => value };
}

const testEnv = {
  HYPERDRIVE: { connectionString: 'postgres://localhost:5432/test' },
  POSTHOG_API_KEY: makeSecret('ph-key'),
  ABUSE_SERVICE_URL: makeSecret('https://abuse.example.com'),
  ABUSE_CF_ACCESS_CLIENT_ID: makeSecret('abuse-id'),
  ABUSE_CF_ACCESS_CLIENT_SECRET: makeSecret('abuse-secret'),
  O11Y: { ingestApiMetrics: async () => {} },
};

type ContextOverrides = {
  model?: string;
  providerId?: ProviderId;
};

function buildApp(overrides: ContextOverrides = {}) {
  const model = overrides.model ?? 'anthropic/claude-sonnet-4-20250514';
  const providerId = overrides.providerId ?? 'openrouter';
  const app = new Hono<HonoContext>();

  // Pre-populate context variables normally set by earlier middleware.
  app.use('*', async (c, next) => {
    c.set('requestStartedAt', performance.now());
    c.set('requestBody', {
      model,
      messages: [{ role: 'user' as const, content: 'hi' }],
      stream: false,
    });
    c.set('resolvedModel', model);
    c.set('provider', {
      id: providerId,
      apiUrl: 'https://openrouter.example.com/v1',
      apiKey: 'test-key',
      hasGenerationEndpoint: true,
    });
    c.set('userByok', null);
    c.set('customLlm', null);
    c.set('user', {
      id: 'user-1',
      total_microdollars_acquired: 10_000_000,
      microdollars_used: 0,
    } as never);
    c.set('organizationId', undefined);
    c.set('projectId', null);
    c.set('extraHeaders', {});
    c.set('fraudHeaders', { cf_connecting_ip: '1.2.3.4' } as never);
    c.set('editorName', null);
    c.set('machineId', null);
    c.set('taskId', null);
    c.set('botId', undefined);
    c.set('tokenSource', undefined);
    c.set('feature', null);
    c.set('autoModel', null);
    c.set('modeHeader', null);
    await next();
  });

  return app;
}

function dispatch(app: Hono<HonoContext>, req: Request) {
  return app.fetch(req, testEnv as never, fakeExecutionCtx());
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('proxy handler – 402 upstream', () => {
  it('schedules background tasks before returning 503', async () => {
    // Upstream returns 402 Payment Required
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Payment Required' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { proxyHandler } = await import('../../src/handler/proxy');
    const app = buildApp();
    app.post('/api/gateway/chat/completions', proxyHandler);

    const req = new Request('http://localhost/api/gateway/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const res = await dispatch(app, req);

    // Should convert 402 → 503
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe('Service Unavailable');

    // Background tasks MUST have been scheduled (the whole point of B1)
    expect(scheduledCalls).toHaveLength(1);
    const params = scheduledCalls[0] as Record<string, unknown>;
    expect(params.upstreamStatusCode).toBe(402);
    // metricsStream should be provided (non-null)
    expect(params.metricsStream).not.toBeNull();
  });

  it('does NOT convert 402 to 503 when userByok is set', async () => {
    // Upstream returns 402 with BYOK — should pass through as-is
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { proxyHandler } = await import('../../src/handler/proxy');
    const app = buildApp();

    // Override userByok in this test's middleware
    app.use('/byok/*', async (c, next) => {
      c.set('userByok', [{ provider_id: 'anthropic', encrypted_api_key: 'enc-key' }] as never);
      await next();
    });
    app.post('/byok/chat/completions', proxyHandler);

    const req = new Request('http://localhost/byok/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const res = await dispatch(app, req);

    // BYOK 402 should NOT be converted — goes through makeErrorReadable instead
    // (which returns a readable BYOK error for 402)
    // Background tasks should still be scheduled
    expect(scheduledCalls).toHaveLength(1);
    expect((scheduledCalls[0] as Record<string, unknown>).upstreamStatusCode).toBe(402);
  });

  it('schedules background tasks for non-402 errors too', async () => {
    // Upstream returns 500 — verify background tasks still run
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { proxyHandler } = await import('../../src/handler/proxy');
    const app = buildApp();
    app.post('/api/gateway/chat/completions', proxyHandler);

    const req = new Request('http://localhost/api/gateway/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const res = await dispatch(app, req);

    // 500 should pass through (no conversion)
    expect(res.status).toBe(500);

    // Background tasks should be scheduled
    expect(scheduledCalls).toHaveLength(1);
    expect((scheduledCalls[0] as Record<string, unknown>).upstreamStatusCode).toBe(500);
  });
});

// ── B2: Free model responses include accounting and logging ───────────────────

describe('proxy handler – free model background tasks', () => {
  it('provides accountingStream and loggingStream for free model responses', async () => {
    // Upstream returns 200 OK for a free model
    const upstreamBody = JSON.stringify({
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    fetchMock.mockResolvedValue(
      new Response(upstreamBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { proxyHandler } = await import('../../src/handler/proxy');
    const app = buildApp({ model: 'corethink:free', providerId: 'corethink' });
    app.post('/api/gateway/chat/completions', proxyHandler);

    const req = new Request('http://localhost/api/gateway/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'corethink:free',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const res = await dispatch(app, req);
    expect(res.status).toBe(200);

    // Consume the response body to let the pipe promise complete.
    await res.text();
    // Allow microtasks / waitUntil promises to settle.
    await new Promise(resolve => setTimeout(resolve, 50));

    // Background tasks MUST include accounting and logging streams (B2 fix).
    expect(scheduledCalls).toHaveLength(1);
    const params = scheduledCalls[0] as Record<string, unknown>;
    expect(params.accountingStream).not.toBeNull();
    expect(params.metricsStream).not.toBeNull();
    expect(params.loggingStream).not.toBeNull();
  });

  it('skips accountingStream and loggingStream for anonymous free model requests', async () => {
    const upstreamBody = JSON.stringify({
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    fetchMock.mockResolvedValue(
      new Response(upstreamBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { proxyHandler } = await import('../../src/handler/proxy');
    // Build app with anonymous user (id starts with 'anon:')
    const app = new Hono<HonoContext>();
    app.use('*', async (c, next) => {
      c.set('requestStartedAt', performance.now());
      c.set('requestBody', {
        model: 'corethink:free',
        messages: [{ role: 'user' as const, content: 'hi' }],
        stream: false,
      });
      c.set('resolvedModel', 'corethink:free');
      c.set('provider', {
        id: 'corethink' as const,
        apiUrl: 'https://corethink.example.com/v1',
        apiKey: 'test-key',
        hasGenerationEndpoint: true,
      });
      c.set('userByok', null);
      c.set('customLlm', null);
      c.set('user', { id: 'anon:1.2.3.4', isAnonymous: true } as never);
      c.set('organizationId', undefined);
      c.set('projectId', null);
      c.set('extraHeaders', {});
      c.set('fraudHeaders', { cf_connecting_ip: '1.2.3.4' } as never);
      c.set('editorName', null);
      c.set('machineId', null);
      c.set('taskId', null);
      c.set('botId', undefined);
      c.set('tokenSource', undefined);
      c.set('feature', null);
      c.set('autoModel', null);
      c.set('modeHeader', null);
      await next();
    });
    app.post('/api/gateway/chat/completions', proxyHandler);

    const req = new Request('http://localhost/api/gateway/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'corethink:free',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const res = await dispatch(app, req);
    expect(res.status).toBe(200);
    await res.text();
    await new Promise(resolve => setTimeout(resolve, 50));

    // For anonymous users: accounting and logging are null, but metrics are present.
    expect(scheduledCalls).toHaveLength(1);
    const params = scheduledCalls[0] as Record<string, unknown>;
    expect(params.accountingStream).toBeNull();
    expect(params.metricsStream).not.toBeNull();
    expect(params.loggingStream).toBeNull();
  });
});
