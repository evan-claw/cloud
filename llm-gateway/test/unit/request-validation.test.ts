// Tests for requestValidationMiddleware — max_tokens, dead models, rate-limited-to-death models.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../../src/types/hono';
import { requestValidationMiddleware } from '../../src/middleware/request-validation';
import { parseBodyMiddleware } from '../../src/middleware/parse-body';
import { extractIpMiddleware } from '../../src/middleware/extract-ip';
import { resolveAutoModelMiddleware } from '../../src/middleware/resolve-auto-model';
import { anonymousGateMiddleware } from '../../src/middleware/anonymous-gate';

function makeApp() {
  const app = new Hono<HonoContext>();
  app.post(
    '/test',
    parseBodyMiddleware,
    extractIpMiddleware,
    resolveAutoModelMiddleware,
    anonymousGateMiddleware,
    requestValidationMiddleware,
    c => c.json({ ok: true })
  );
  return app;
}

function post(app: ReturnType<typeof makeApp>, body: Record<string, unknown>) {
  return app.fetch(
    new Request('http://x/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify(body),
    })
  );
}

describe('requestValidationMiddleware', () => {
  it('allows valid free model requests', async () => {
    const app = makeApp();
    const res = await post(app, {
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
  });

  it('returns 503 for absurdly large max_tokens', async () => {
    const app = makeApp();
    const res = await post(app, {
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100_000_000_000,
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Service Unavailable');
  });

  it('allows normal max_tokens values', async () => {
    const app = makeApp();
    const res = await post(app, {
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 4096,
    });
    expect(res.status).toBe(200);
  });

  it('returns 404 for dead free models', async () => {
    const app = makeApp();
    // x-ai/grok-code-fast-1:optimized:free is disabled in the models list
    const res = await post(app, {
      model: 'x-ai/grok-code-fast-1:optimized:free',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('alpha period');
  });

  it('returns 404 for rate-limited-to-death models', async () => {
    const app = makeApp();
    const res = await post(app, {
      model: 'deepseek/deepseek-r1-0528:free',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('not found');
  });
});
