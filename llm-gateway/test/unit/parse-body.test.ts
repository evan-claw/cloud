import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../../src/types/hono';
import { parseBodyMiddleware } from '../../src/middleware/parse-body';

function makeApp() {
  const app = new Hono<HonoContext>();
  app.post('/test', parseBodyMiddleware, c => {
    return c.json({
      model: c.get('requestBody').model,
      resolvedModel: c.get('resolvedModel'),
      feature: c.get('feature'),
      stream_options: c.get('requestBody').stream_options,
    });
  });
  return app;
}

async function post(app: ReturnType<typeof makeApp>, body: unknown, headers?: HeadersInit) {
  return app.fetch(
    new Request('http://x/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  );
}

describe('parseBodyMiddleware', () => {
  it('sets requestBody, resolvedModel, and stream_options', async () => {
    const app = makeApp();
    const res = await post(app, { model: 'anthropic/claude-3-5-sonnet', messages: [] });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.model).toBe('anthropic/claude-3-5-sonnet');
    expect(data.resolvedModel).toBe('anthropic/claude-3-5-sonnet');
    expect(data.stream_options).toEqual({ include_usage: true });
  });

  it('lowercases resolvedModel', async () => {
    const app = makeApp();
    const res = await post(app, { model: 'Anthropic/Claude-3-5-Sonnet', messages: [] });
    const data = await res.json();
    expect(data.resolvedModel).toBe('anthropic/claude-3-5-sonnet');
  });

  it('merges stream_options, preserving caller fields', async () => {
    const app = makeApp();
    const res = await post(app, {
      model: 'gpt-4',
      messages: [],
      stream_options: { include_usage: false },
    });
    const data = await res.json();
    expect(data.stream_options).toEqual({ include_usage: true });
  });

  it('returns 400 for missing model', async () => {
    const app = makeApp();
    const res = await post(app, { messages: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty model', async () => {
    const app = makeApp();
    const res = await post(app, { model: '  ', messages: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request('http://x/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
    );
    expect(res.status).toBe(400);
  });

  it('validates x-kilocode-feature header', async () => {
    const app = makeApp();
    const res = await post(
      app,
      { model: 'gpt-4', messages: [] },
      { 'x-kilocode-feature': 'vscode-extension' }
    );
    const data = await res.json();
    expect(data.feature).toBe('vscode-extension');
  });

  it('sets feature to null for unknown header value', async () => {
    const app = makeApp();
    const res = await post(
      app,
      { model: 'gpt-4', messages: [] },
      { 'x-kilocode-feature': 'unknown-tool' }
    );
    const data = await res.json();
    expect(data.feature).toBeNull();
  });
});
