import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { registerConfigRoutes } from './config';

// Mock fs at the module level
vi.mock('node:fs', () => {
  return {
    default: {
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

// Import the mocked module
import fs from 'node:fs';

const readMock = vi.mocked(fs.readFileSync);
const writeMock = vi.mocked(fs.writeFileSync);

function authHeaders(token = 'test-token'): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('/_kilo/config routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enforces bearer auth', async () => {
    const app = new Hono();
    registerConfigRoutes(app, 'test-token');

    const noAuth = await app.request('/_kilo/config/patch', {
      method: 'POST',
      body: JSON.stringify({ foo: 'bar' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(noAuth.status).toBe(401);

    const wrongAuth = await app.request('/_kilo/config/patch', {
      method: 'POST',
      body: JSON.stringify({ foo: 'bar' }),
      headers: authHeaders('bad-token'),
    });
    expect(wrongAuth.status).toBe(401);
  });

  it('deep-merges patch into existing config', async () => {
    const app = new Hono();
    registerConfigRoutes(app, 'test-token');

    const existingConfig = {
      agents: { defaults: { model: { primary: 'kilocode/anthropic/claude-opus-4.6' } } },
      gateway: { port: 3001 },
    };
    readMock.mockReturnValue(JSON.stringify(existingConfig));

    const resp = await app.request('/_kilo/config/patch', {
      method: 'POST',
      body: JSON.stringify({
        agents: { defaults: { model: { primary: 'kilocode/anthropic/claude-sonnet-4.5' } } },
      }),
      headers: authHeaders(),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });

    expect(writeMock).toHaveBeenCalledOnce();
    const written = JSON.parse(writeMock.mock.calls[0][1] as string);
    expect(written.agents.defaults.model.primary).toBe('kilocode/anthropic/claude-sonnet-4.5');
    // Existing keys preserved
    expect(written.gateway.port).toBe(3001);
  });

  it('rejects non-object body', async () => {
    const app = new Hono();
    registerConfigRoutes(app, 'test-token');

    const resp = await app.request('/_kilo/config/patch', {
      method: 'POST',
      body: JSON.stringify([1, 2, 3]),
      headers: authHeaders(),
    });
    expect(resp.status).toBe(400);
  });

  it('rejects invalid JSON', async () => {
    const app = new Hono();
    registerConfigRoutes(app, 'test-token');

    const resp = await app.request('/_kilo/config/patch', {
      method: 'POST',
      body: 'not json',
      headers: authHeaders(),
    });
    expect(resp.status).toBe(400);
  });

  it('returns 500 when config file is missing', async () => {
    const app = new Hono();
    registerConfigRoutes(app, 'test-token');

    readMock.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });

    const resp = await app.request('/_kilo/config/patch', {
      method: 'POST',
      body: JSON.stringify({ agents: {} }),
      headers: authHeaders(),
    });
    expect(resp.status).toBe(500);
  });
});
