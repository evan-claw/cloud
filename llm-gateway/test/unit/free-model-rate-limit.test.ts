// Tests for freeModelRateLimitMiddleware — KV sliding window check for Kilo free models.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../../src/types/hono';
import { freeModelRateLimitMiddleware } from '../../src/middleware/free-model-rate-limit';
import { parseBodyMiddleware } from '../../src/middleware/parse-body';
import { extractIpMiddleware } from '../../src/middleware/extract-ip';
import { resolveAutoModelMiddleware } from '../../src/middleware/resolve-auto-model';

function makeKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
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

// Pass env as the second arg to app.fetch so c.env is populated.
function post(kv: KVNamespace, model: string, ip = '1.2.3.4') {
  const app = makeApp();
  const env = { RATE_LIMIT_KV: kv } as unknown as Cloudflare.Env;
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
    const kv = makeKv();
    const res = await post(kv, 'corethink:free');
    expect(res.status).toBe(200);
  });

  it('blocks Kilo free model at 200 requests/hour', async () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 200 }, (_, i) => now - i * 1000);
    const kv = makeKv({ 'rl:free:1.2.3.4': JSON.stringify(timestamps) });
    const res = await post(kv, 'corethink:free');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FREE_MODEL_RATE_LIMITED');
  });

  it('skips non-Kilo free models', async () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 200 }, (_, i) => now - i * 1000);
    const kv = makeKv({ 'rl:free:1.2.3.4': JSON.stringify(timestamps) });
    // This is a generic :free model (OpenRouter), not Kilo-hosted
    const res = await post(kv, 'meta-llama/llama-3.1-8b-instruct:free');
    expect(res.status).toBe(200);
  });

  it('rate limits per IP', async () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 200 }, (_, i) => now - i * 1000);
    const kv = makeKv({ 'rl:free:5.5.5.5': JSON.stringify(timestamps) });
    // Different IP should not be rate limited
    const res = await post(kv, 'corethink:free', '6.6.6.6');
    expect(res.status).toBe(200);
  });
});
