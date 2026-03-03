// Tests for freeModelRateLimitMiddleware — DO-backed rate limit check for Kilo free models.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../../src/types/hono';
import { freeModelRateLimitMiddleware } from '../../src/middleware/free-model-rate-limit';
import { parseBodyMiddleware } from '../../src/middleware/parse-body';
import { extractIpMiddleware } from '../../src/middleware/extract-ip';
import { resolveAutoModelMiddleware } from '../../src/middleware/resolve-auto-model';

// Fake DO that simulates rate limit behavior with a configurable threshold.
function makeFakeDONamespace(blocked = new Set<string>()) {
  return {
    idFromName(name: string) {
      return { name };
    },
    get(id: { name: string }) {
      return {
        checkFreeModel: async () => ({
          allowed: !blocked.has(id.name),
          requestCount: blocked.has(id.name) ? 200 : 0,
        }),
        checkPromotion: async () => ({ allowed: true, requestCount: 0 }),
        incrementFreeModel: async () => {},
        incrementPromotion: async () => {},
      };
    },
  };
}

function makeApp() {
  const app = new Hono<HonoContext>();
  app.post(
    '/test',
    parseBodyMiddleware,
    extractIpMiddleware,
    resolveAutoModelMiddleware,
    freeModelRateLimitMiddleware,
    c => c.json({ ok: true })
  );
  return app;
}

function post(doNamespace: ReturnType<typeof makeFakeDONamespace>, model: string, ip = '1.2.3.4') {
  const app = makeApp();
  const env = { RATE_LIMIT_DO: doNamespace } as unknown as Cloudflare.Env;
  return app.fetch(
    new Request('http://x/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    }),
    env
  );
}

describe('freeModelRateLimitMiddleware', () => {
  it('allows Kilo free model when under the limit', async () => {
    const ns = makeFakeDONamespace();
    const res = await post(ns, 'corethink:free');
    expect(res.status).toBe(200);
  });

  it('blocks Kilo free model at 200 requests/hour', async () => {
    const ns = makeFakeDONamespace(new Set(['1.2.3.4']));
    const res = await post(ns, 'corethink:free');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FREE_MODEL_RATE_LIMITED');
  });

  it('skips non-Kilo free models', async () => {
    // Even if the IP is blocked, non-Kilo free models are not rate-limited here
    const ns = makeFakeDONamespace(new Set(['1.2.3.4']));
    const res = await post(ns, 'meta-llama/llama-3.1-8b-instruct:free');
    expect(res.status).toBe(200);
  });

  it('rate limits per IP', async () => {
    // Only 5.5.5.5 is blocked, 6.6.6.6 should pass
    const ns = makeFakeDONamespace(new Set(['5.5.5.5']));
    const res = await post(ns, 'corethink:free', '6.6.6.6');
    expect(res.status).toBe(200);
  });
});
