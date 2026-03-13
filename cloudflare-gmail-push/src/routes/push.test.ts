import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../types';
import { pushRoute } from './push';

vi.mock('../auth/oidc', () => ({
  validateOidcToken: vi.fn(),
}));

import { validateOidcToken } from '../auth/oidc';

const mockValidateOidc = vi.mocked(validateOidcToken);

const TEST_USER = 'user123';

function createApp() {
  const app = new Hono<HonoContext>();
  const mockQueue = {
    send: vi.fn(),
  };

  app.use('*', async (c, next) => {
    c.env = {
      KILOCLAW: {} as unknown as Fetcher,
      OIDC_AUDIENCE: 'https://test-audience.example.com',
      INTERNAL_API_SECRET: { get: () => Promise.resolve('test-internal-secret') },
      GMAIL_PUSH_QUEUE: mockQueue as unknown as Queue,
    };
    await next();
  });

  app.route('/push', pushRoute);
  return { app, mockQueue };
}

describe('POST /push/user/:userId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects request without authorization header', async () => {
    mockValidateOidc.mockResolvedValue({ valid: false, error: 'Missing authorization header' });
    const { app } = createApp();

    const res = await app.request(`/push/user/${TEST_USER}`, {
      method: 'POST',
      body: JSON.stringify({ message: { data: 'dGVzdA==' } }),
    });

    expect(res.status).toBe(401);
  });

  it('rejects invalid OIDC token', async () => {
    mockValidateOidc.mockResolvedValue({ valid: false, error: 'bad token' });
    const { app } = createApp();

    const res = await app.request(`/push/user/${TEST_USER}`, {
      method: 'POST',
      headers: { authorization: 'Bearer bad-token' },
      body: JSON.stringify({ message: { data: 'dGVzdA==' } }),
    });

    expect(res.status).toBe(401);
  });

  it('passes correct audience to OIDC validator (no email check)', async () => {
    mockValidateOidc.mockResolvedValue({
      valid: true,
      email: 'gmail-push@my-project.iam.gserviceaccount.com',
    });
    const { app } = createApp();

    await app.request(`/push/user/${TEST_USER}`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: JSON.stringify({ message: { data: 'dGVzdA==' } }),
    });

    expect(mockValidateOidc).toHaveBeenCalledWith(
      'Bearer valid-token',
      'https://test-audience.example.com'
    );
  });

  it('enqueues message and returns 200 for valid OIDC', async () => {
    mockValidateOidc.mockResolvedValue({
      valid: true,
      email: 'gmail-api-push@system.gserviceaccount.com',
    });
    const { app, mockQueue } = createApp();
    const pubSubBody = JSON.stringify({ message: { data: 'dGVzdA==', messageId: '123' } });

    const res = await app.request(`/push/user/${TEST_USER}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': 'application/json',
      },
      body: pubSubBody,
    });

    expect(res.status).toBe(200);
    expect(mockQueue.send).toHaveBeenCalledOnce();
    expect(mockQueue.send).toHaveBeenCalledWith({
      userId: TEST_USER,
      pubSubBody,
      messageId: '123',
    });
  });

  it('rejects oversized payload with 413', async () => {
    mockValidateOidc.mockResolvedValue({
      valid: true,
      email: 'gmail-api-push@system.gserviceaccount.com',
    });
    const { app, mockQueue } = createApp();

    const res = await app.request(`/push/user/${TEST_USER}`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: 'x'.repeat(65_537),
    });

    expect(res.status).toBe(413);
    expect(mockQueue.send).not.toHaveBeenCalled();
  });
});
