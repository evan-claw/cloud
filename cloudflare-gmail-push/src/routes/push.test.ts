import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../types';
import { pushRoute } from './push';

// Mock the OIDC module
vi.mock('../auth/oidc', () => ({
  validateOidcToken: vi.fn(),
}));

import { validateOidcToken } from '../auth/oidc';

const mockValidateOidc = vi.mocked(validateOidcToken);

function createApp() {
  const app = new Hono<HonoContext>();
  const mockKiloclaw = {
    fetch: vi.fn(),
  };

  app.use('*', async (c, next) => {
    c.env = {
      KILOCLAW: mockKiloclaw as unknown as Fetcher,
      OIDC_AUDIENCE: 'https://test-audience.example.com',
      INTERNAL_API_SECRET: 'test-internal-secret',
    };
    await next();
  });

  app.route('/push', pushRoute);
  return { app, mockKiloclaw };
}

describe('POST /push/user/:userId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects invalid OIDC token', async () => {
    mockValidateOidc.mockResolvedValue({ valid: false, error: 'bad token' });
    const { app } = createApp();

    const res = await app.request('/push/user/user123', {
      method: 'POST',
      headers: { authorization: 'Bearer bad-token' },
      body: JSON.stringify({ message: { data: 'dGVzdA==' } }),
    });

    expect(res.status).toBe(401);
  });

  it('returns 200 when machine is not running', async () => {
    mockValidateOidc.mockResolvedValue({
      valid: true,
      email: 'gmail-api-push@system.gserviceaccount.com',
    });
    const { app, mockKiloclaw } = createApp();

    mockKiloclaw.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          flyAppName: null,
          flyMachineId: null,
          sandboxId: 'sandbox-123',
          status: 'stopped',
        })
      )
    );

    const res = await app.request('/push/user/user123', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ message: { data: 'dGVzdA==' } }),
    });

    expect(res.status).toBe(200);
    const body: { skipped: string } = await res.json();
    expect(body.skipped).toBe('machine-not-running');
  });

  it('forwards push to controller and returns 200 on success', async () => {
    mockValidateOidc.mockResolvedValue({
      valid: true,
      email: 'gmail-api-push@system.gserviceaccount.com',
    });
    const { app, mockKiloclaw } = createApp();

    mockKiloclaw.fetch.mockImplementation((req: Request) => {
      const url = new URL(req.url);
      if (url.pathname.includes('status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              flyAppName: 'test-app',
              flyMachineId: 'machine-abc',
              sandboxId: 'sandbox-123',
              status: 'running',
            })
          )
        );
      }
      if (url.pathname.includes('gateway-token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              gatewayToken: 'gw-token-xyz',
            })
          )
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));

    try {
      const res = await app.request('/push/user/user123', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
        body: JSON.stringify({ message: { data: 'dGVzdA==', messageId: '123' } }),
      });

      expect(res.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const mockFetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const [url, fetchInit]: [unknown, RequestInit] = mockFetchCalls[0];
      expect(url).toContain('/_kilo/gmail-pubsub');
      const headers = fetchInit?.headers as Record<string, string>;
      expect(headers?.['fly-force-instance-id']).toBe('machine-abc');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
