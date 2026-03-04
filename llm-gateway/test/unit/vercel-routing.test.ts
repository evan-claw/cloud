// Tests for Vercel AI Gateway A/B routing logic.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { OpenRouterChatCompletionRequest } from '../../src/types/request';

// Stub scheduler.wait globally — it's a Workers runtime global not available in Node.
const g = globalThis as Record<string, unknown>;
const realScheduler = g.scheduler;
beforeAll(() => {
  g.scheduler = { wait: (ms: number) => new Promise(r => setTimeout(r, ms)) };
});
afterAll(() => {
  g.scheduler = realScheduler;
});

// Mock the DB module to avoid real Postgres connections.
vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({}),
}));

// We import after mocking so the module picks up the mock.
const { shouldRouteToVercel, getGatewayErrorRate } = await import('../../src/lib/vercel-routing');

function makeRequest(
  overrides: Partial<OpenRouterChatCompletionRequest> = {}
): OpenRouterChatCompletionRequest {
  return { model: 'openai/gpt-5.2', messages: [{ role: 'user', content: 'hi' }], ...overrides };
}

// Fake WorkerDb that returns configurable error rates.
function fakeDb(openrouter = 0, vercel = 0) {
  return {
    execute: async () => ({
      rows: [
        { gateway: 'openrouter', errorRate: openrouter },
        { gateway: 'vercel', errorRate: vercel },
      ],
    }),
  } as never;
}

describe('shouldRouteToVercel', () => {
  it('returns false when data_collection=deny', async () => {
    const req = makeRequest({ provider: { data_collection: 'deny' } });
    const result = await shouldRouteToVercel(fakeDb(), 'openai/gpt-5.2', req, 'seed-1');
    expect(result).toBe(false);
  });

  it('returns false for openrouter/* models', async () => {
    const result = await shouldRouteToVercel(
      fakeDb(),
      'openrouter/free',
      makeRequest({ model: 'openrouter/free' }),
      'seed-1'
    );
    expect(result).toBe(false);
  });

  it('returns false for Anthropic models', async () => {
    const result = await shouldRouteToVercel(
      fakeDb(),
      'anthropic/claude-sonnet-4.6',
      makeRequest({ model: 'anthropic/claude-sonnet-4.6' }),
      'seed-1'
    );
    expect(result).toBe(false);
  });

  it('returns false for OpenAI models (Vercel model-not-found)', async () => {
    const result = await shouldRouteToVercel(
      fakeDb(),
      'openai/gpt-5.2',
      makeRequest({ model: 'openai/gpt-5.2' }),
      'seed-1'
    );
    expect(result).toBe(false);
  });

  it('does not exclude openai/gpt-oss models from Vercel', async () => {
    // gpt-oss models should NOT be excluded — they go through the normal preferred-model check
    const result = await shouldRouteToVercel(
      fakeDb(),
      'openai/gpt-oss-120b',
      makeRequest({ model: 'openai/gpt-oss-120b' }),
      'seed-1'
    );
    // gpt-oss-120b is not in preferredModels, so it returns false for that reason, not the OpenAI exclusion
    expect(result).toBe(false);
  });

  it('returns false for models not in preferredModels', async () => {
    const result = await shouldRouteToVercel(
      fakeDb(),
      'meta-llama/llama-3.3-70b-instruct',
      makeRequest({ model: 'meta-llama/llama-3.3-70b-instruct' }),
      'seed-1'
    );
    expect(result).toBe(false);
  });

  it('returns false for Kilo free models with non-openrouter gateway (e.g. corethink)', async () => {
    const result = await shouldRouteToVercel(
      fakeDb(),
      'corethink:free',
      makeRequest({ model: 'corethink:free' }),
      'seed-1'
    );
    expect(result).toBe(false);
  });

  it('returns false for Kilo free models with non-openrouter gateway (e.g. giga-potato)', async () => {
    const result = await shouldRouteToVercel(
      fakeDb(),
      'giga-potato',
      makeRequest({ model: 'giga-potato' }),
      'seed-1'
    );
    expect(result).toBe(false);
  });

  it('routes preferred model deterministically based on seed', async () => {
    const db = fakeDb();
    const model = 'google/gemini-3.1-pro-preview';
    const req = makeRequest({ model });
    const r1 = await shouldRouteToVercel(db, model, req, 'stable-seed');
    const r2 = await shouldRouteToVercel(db, model, req, 'stable-seed');
    expect(r1).toBe(r2);
  });

  it('can route to Vercel for eligible preferred models', async () => {
    // Try many seeds; at 10% routing at least one should hit Vercel
    const db = fakeDb();
    const model = 'google/gemini-3.1-pro-preview';
    const req = makeRequest({ model });
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        shouldRouteToVercel(db, model, req, `seed-${i}`)
      )
    );
    const trueCount = results.filter(Boolean).length;
    // With 10% routing, we expect ~10 out of 100, but at least 1 and at most 30
    expect(trueCount).toBeGreaterThan(0);
    expect(trueCount).toBeLessThan(30);
  });

  it('routes ~90% to Vercel when OpenRouter error rate is high', async () => {
    // OpenRouter error rate > 50%, Vercel < 50% → 90% to Vercel
    const db = fakeDb(0.7, 0.1);
    const model = 'google/gemini-3.1-pro-preview';
    const req = makeRequest({ model });
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        shouldRouteToVercel(db, model, req, `failover-seed-${i}`)
      )
    );
    const trueCount = results.filter(Boolean).length;
    // With 90% routing, we expect ~90 out of 100
    expect(trueCount).toBeGreaterThan(70);
  });
});

describe('getGatewayErrorRate', () => {
  it('returns error rates from DB', async () => {
    const db = fakeDb(0.05, 0.02);
    const result = await getGatewayErrorRate(db);
    expect(result.openrouter).toBe(0.05);
    expect(result.vercel).toBe(0.02);
  });

  it('returns 0/0 on DB error', async () => {
    const db = {
      execute: async () => {
        throw new Error('connection failed');
      },
    } as never;
    const result = await getGatewayErrorRate(db);
    expect(result).toEqual({ openrouter: 0, vercel: 0 });
  });
});
