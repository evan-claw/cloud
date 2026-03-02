// Tests for anonymousGateMiddleware — decides between authenticated user,
// anonymous free model access, and 401 rejection for paid models.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../../src/types/hono';
import { anonymousGateMiddleware } from '../../src/middleware/anonymous-gate';
import { parseBodyMiddleware } from '../../src/middleware/parse-body';
import { extractIpMiddleware } from '../../src/middleware/extract-ip';
import { resolveAutoModelMiddleware } from '../../src/middleware/resolve-auto-model';

function makeApp() {
  const app = new Hono<HonoContext>();
  app.post(
    '/test',
    parseBodyMiddleware,
    extractIpMiddleware,
    resolveAutoModelMiddleware,
    anonymousGateMiddleware,
    c => {
      const user = c.get('user');
      return c.json({ userId: user.id, isAnonymous: 'isAnonymous' in user });
    }
  );
  return app;
}

function post(app: ReturnType<typeof makeApp>, body: Record<string, unknown>) {
  return app.fetch(
    new Request('http://x/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.8.7.6' },
      body: JSON.stringify(body),
    })
  );
}

describe('anonymousGateMiddleware', () => {
  it('allows anonymous access for free models (ending in :free)', async () => {
    const app = makeApp();
    const res = await post(app, {
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.isAnonymous).toBe(true);
    expect(body.userId).toBe('anon:9.8.7.6');
  });

  it('allows anonymous access for Kilo free models', async () => {
    const app = makeApp();
    const res = await post(app, {
      model: 'corethink:free',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.isAnonymous).toBe(true);
  });

  it('returns 401 for paid models without auth', async () => {
    const app = makeApp();
    const res = await post(app, {
      model: 'anthropic/claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('PAID_MODEL_AUTH_REQUIRED');
    expect(body.error.message).toContain('sign in');
  });

  it('passes through when authUser is set', async () => {
    const app = new Hono<HonoContext>();
    app.post(
      '/test',
      parseBodyMiddleware,
      extractIpMiddleware,
      resolveAutoModelMiddleware,
      // Simulate auth middleware having set authUser
      async (c, next) => {
        c.set('authUser', {
          id: 'user-42',
          google_user_email: 'test@example.com',
        } as HonoContext['Variables']['authUser']);
        await next();
      },
      anonymousGateMiddleware,
      c => {
        const user = c.get('user');
        return c.json({ userId: user.id, isAnonymous: 'isAnonymous' in user });
      }
    );
    const res = await app.fetch(
      new Request('http://x/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.8.7.6' },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.userId).toBe('user-42');
    expect(body.isAnonymous).toBe(false);
  });
});
