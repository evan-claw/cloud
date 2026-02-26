import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { registerHealthRoute } from './health';
import type { Supervisor } from '../supervisor';

function createMockSupervisor(state: string): Supervisor {
  return {
    start: async () => true,
    stop: async () => true,
    restart: async () => true,
    shutdown: async () => undefined,
    getState: () => state as ReturnType<Supervisor['getState']>,
    getStats: () => ({
      state: state as ReturnType<Supervisor['getState']>,
      pid: 42,
      uptime: 123,
      restarts: 2,
      lastExit: null,
    }),
  };
}

describe('GET /_kilo/health', () => {
  it('returns 200 with status fields when gateway is running', async () => {
    const app = new Hono();
    registerHealthRoute(app, createMockSupervisor('running'));

    const resp = await app.request('/_kilo/health');
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      status: 'ok',
      gateway: 'running',
      uptime: 123,
      restarts: 2,
    });
  });

  it('returns 503 when gateway is not running', async () => {
    const app = new Hono();
    registerHealthRoute(app, createMockSupervisor('crashed'));

    const resp = await app.request('/_kilo/health');
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { status: string; gateway: string };
    expect(body.status).toBe('starting');
    expect(body.gateway).toBe('crashed');
  });

  it('returns 503 when gateway is starting', async () => {
    const app = new Hono();
    registerHealthRoute(app, createMockSupervisor('starting'));

    const resp = await app.request('/_kilo/health');
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { status: string; gateway: string };
    expect(body.status).toBe('starting');
    expect(body.gateway).toBe('starting');
  });
});

describe('GET /health (compatibility alias)', () => {
  it('returns 200 with status fields', async () => {
    const app = new Hono();
    registerHealthRoute(app, createMockSupervisor('running'));

    const resp = await app.request('/health');
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      status: 'ok',
      gateway: 'running',
      uptime: 123,
      restarts: 2,
    });
  });
});
