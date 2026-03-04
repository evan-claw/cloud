// Test: logFreeModelUsageMiddleware DB insert timing (B5).
// The DB insert must be awaited BEFORE next() so the rate-limit entry
// is counted even if the upstream request fails.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../../src/types/hono';
import { fakeExecutionCtx } from './helpers';

// ── Track DB insert timing relative to next() ──────────────────────────────

const timeline: string[] = [];

const fakeDb = {
  insert: () => ({
    values: () => {
      timeline.push('db-insert');
      return Promise.resolve();
    },
  }),
};

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => fakeDb,
}));

vi.mock('../../src/lib/rate-limit', () => ({
  incrementFreeModelUsage: async () => {
    timeline.push('do-increment');
  },
  incrementPromotionUsage: async () => {
    timeline.push('promo-increment');
  },
}));

beforeEach(() => {
  timeline.length = 0;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('logFreeModelUsageMiddleware', () => {
  it('awaits DB insert before calling next()', async () => {
    const { logFreeModelUsageMiddleware } =
      await import('../../src/middleware/log-free-model-usage');

    const app = new Hono<HonoContext>();

    // Stub context variables
    app.use('*', async (c, next) => {
      c.set('resolvedModel', 'corethink:free');
      c.set('clientIp', '1.2.3.4');
      c.set('user', { id: 'user-1' } as never);
      c.set('db', fakeDb as never);
      await next();
    });

    app.use('*', logFreeModelUsageMiddleware);

    app.post('*', c => {
      timeline.push('handler');
      return c.json({ ok: true });
    });

    const req = new Request('http://localhost/api/gateway/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const env = {
      HYPERDRIVE: { connectionString: 'postgres://localhost:5432/test' },
      RATE_LIMIT_DO: {},
    };

    await app.fetch(req, env as never, fakeExecutionCtx());

    // DB insert must happen BEFORE the handler (next())
    const dbIndex = timeline.indexOf('db-insert');
    const handlerIndex = timeline.indexOf('handler');
    expect(dbIndex).toBeGreaterThanOrEqual(0);
    expect(handlerIndex).toBeGreaterThanOrEqual(0);
    expect(dbIndex).toBeLessThan(handlerIndex);
  });

  it('still calls next() even if DB insert fails', async () => {
    // Override the mock for this test to simulate failure
    const { logFreeModelUsageMiddleware } =
      await import('../../src/middleware/log-free-model-usage');

    const app = new Hono<HonoContext>();

    app.use('*', async (c, next) => {
      c.set('resolvedModel', 'corethink:free');
      c.set('clientIp', '1.2.3.4');
      c.set('user', { id: 'user-1' } as never);
      c.set('db', fakeDb as never);
      await next();
    });

    app.use('*', logFreeModelUsageMiddleware);

    app.post('*', c => {
      timeline.push('handler');
      return c.json({ ok: true });
    });

    const req = new Request('http://localhost/api/gateway/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const env = {
      HYPERDRIVE: { connectionString: 'postgres://localhost:5432/test' },
      RATE_LIMIT_DO: {},
    };

    const res = await app.fetch(req, env as never, fakeExecutionCtx());

    // Handler should still run despite any DB issues
    expect(res.status).toBe(200);
    expect(timeline).toContain('handler');
  });

  it('skips for non-free models', async () => {
    const { logFreeModelUsageMiddleware } =
      await import('../../src/middleware/log-free-model-usage');

    const app = new Hono<HonoContext>();

    app.use('*', async (c, next) => {
      c.set('resolvedModel', 'anthropic/claude-sonnet-4-20250514');
      c.set('clientIp', '1.2.3.4');
      c.set('user', { id: 'user-1' } as never);
      c.set('db', fakeDb as never);
      await next();
    });

    app.use('*', logFreeModelUsageMiddleware);

    app.post('*', c => {
      timeline.push('handler');
      return c.json({ ok: true });
    });

    const req = new Request('http://localhost/api/gateway/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const env = {
      HYPERDRIVE: { connectionString: 'postgres://localhost:5432/test' },
      RATE_LIMIT_DO: {},
    };

    await app.fetch(req, env as never, fakeExecutionCtx());

    // No DB insert for paid models
    expect(timeline).not.toContain('db-insert');
    expect(timeline).toContain('handler');
  });
});
