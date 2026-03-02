import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import type { AppEnv } from '../types';
import { authMiddleware, internalApiMiddleware } from './middleware';
import { KILO_TOKEN_VERSION, KILOCLAW_AUTH_COOKIE } from '../config';
import { UserNotFoundError, TokenRevokedError, JwtVerificationError } from '@kilocode/worker-utils';
import type * as WorkerUtilsModule from '@kilocode/worker-utils';

vi.mock('../db', () => ({
  getWorkerDb: vi.fn(() => ({})),
}));

vi.mock('@kilocode/worker-utils', async importOriginal => {
  const actual = await importOriginal<typeof WorkerUtilsModule>();
  return {
    ...actual,
    verifyKiloToken: vi.fn(),
  };
});

import { verifyKiloToken } from '@kilocode/worker-utils';

const TEST_SECRET = 'test-nextauth-secret';

async function signToken(payload: Record<string, unknown>, secret?: string) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret ?? TEST_SECRET));
}

function createTestApp() {
  const app = new Hono<AppEnv>();

  app.use('/protected/*', authMiddleware);
  app.get('/protected/whoami', c => {
    return c.json({ userId: c.get('userId'), authToken: c.get('authToken') });
  });

  app.use('/internal/*', internalApiMiddleware);
  app.get('/internal/status', c => {
    return c.json({ ok: true });
  });

  return app;
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return res.json();
}

const ENV_WITH_HYPERDRIVE = {
  NEXTAUTH_SECRET: TEST_SECRET,
  HYPERDRIVE: { connectionString: 'postgresql://fake' },
} as never;

describe('authMiddleware', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    app = createTestApp();
    vi.mocked(verifyKiloToken).mockReset();
  });

  it('rejects when no NEXTAUTH_SECRET is configured', async () => {
    const res = await app.request('/protected/whoami', {}, {} as never);
    expect(res.status).toBe(500);
    const body = await jsonBody(res);
    expect(body.error).toContain('configuration');
  });

  it('rejects when HYPERDRIVE is not configured', async () => {
    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: 'Bearer some-token' } },
      { NEXTAUTH_SECRET: TEST_SECRET } as never
    );
    expect(res.status).toBe(500);
    const body = await jsonBody(res);
    expect(body.error).toContain('configuration');
  });

  it('rejects when no token is provided', async () => {
    const res = await app.request('/protected/whoami', {}, ENV_WITH_HYPERDRIVE);
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.error).toContain('Authentication required');
  });

  it('authenticates via Bearer header', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: 'pepper_abc',
      version: KILO_TOKEN_VERSION,
    });
    vi.mocked(verifyKiloToken).mockResolvedValueOnce({
      version: 3,
      kiloUserId: 'user_123',
      apiTokenPepper: 'pepper_abc',
    });

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.userId).toBe('user_123');
    expect(body.authToken).toBe(token);
  });

  it('authenticates via cookie fallback', async () => {
    const token = await signToken({
      kiloUserId: 'user_cookie',
      version: KILO_TOKEN_VERSION,
    });
    vi.mocked(verifyKiloToken).mockResolvedValueOnce({
      version: 3,
      kiloUserId: 'user_cookie',
    });

    const res = await app.request(
      '/protected/whoami',
      { headers: { Cookie: `${KILOCLAW_AUTH_COOKIE}=${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.userId).toBe('user_cookie');
  });

  it('prefers Bearer header over cookie', async () => {
    const bearerToken = await signToken({ kiloUserId: 'user_bearer', version: KILO_TOKEN_VERSION });
    const cookieToken = await signToken({ kiloUserId: 'user_cookie', version: KILO_TOKEN_VERSION });
    vi.mocked(verifyKiloToken).mockResolvedValueOnce({
      version: 3,
      kiloUserId: 'user_bearer',
    });

    const res = await app.request(
      '/protected/whoami',
      {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Cookie: `${KILOCLAW_AUTH_COOKIE}=${cookieToken}`,
        },
      },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.userId).toBe('user_bearer');
  });

  it('rejects when pepper does not match (TokenRevokedError)', async () => {
    const token = await signToken({ kiloUserId: 'user_123', version: KILO_TOKEN_VERSION });
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(new TokenRevokedError('user_123'));

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.error).toBe('Authentication failed');
  });

  it('rejects when user not found (UserNotFoundError)', async () => {
    const token = await signToken({ kiloUserId: 'ghost', version: KILO_TOKEN_VERSION });
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(new UserNotFoundError('ghost'));

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.error).toBe('Authentication failed');
  });

  it('returns 500 on DB connectivity error', async () => {
    const token = await signToken({ kiloUserId: 'user_123', version: KILO_TOKEN_VERSION });
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(new Error('connection refused'));

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(500);
    const body = await jsonBody(res);
    expect(body.error).toContain('unavailable');
  });

  it('rejects invalid token', async () => {
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(
      new JwtVerificationError(new Error('JWT parse error'))
    );

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: 'Bearer not-a-jwt' } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(401);
  });

  it('rejects token with wrong version', async () => {
    const token = await signToken({ kiloUserId: 'user_123', version: KILO_TOKEN_VERSION - 1 });
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(
      new JwtVerificationError(new Error('invalid version'))
    );

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(401);
  });

  it('validates env match when WORKER_ENV is set', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      version: KILO_TOKEN_VERSION,
      env: 'production',
    });
    vi.mocked(verifyKiloToken).mockResolvedValueOnce({
      version: 3,
      kiloUserId: 'user_123',
      env: 'production',
    });

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      {
        NEXTAUTH_SECRET: TEST_SECRET,
        HYPERDRIVE: { connectionString: 'postgresql://fake' },
        WORKER_ENV: 'development',
      } as never
    );
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.error).toBe('Authentication failed');
  });
});

describe('internalApiMiddleware', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    app = createTestApp();
  });

  it('rejects when no INTERNAL_API_SECRET configured', async () => {
    const res = await app.request('/internal/status', {}, {} as never);
    expect(res.status).toBe(500);
  });

  it('rejects when no api key header provided', async () => {
    const res = await app.request('/internal/status', {}, {
      INTERNAL_API_SECRET: 'secret-123',
    } as never);
    expect(res.status).toBe(403);
  });

  it('rejects wrong api key', async () => {
    const res = await app.request(
      '/internal/status',
      { headers: { 'x-internal-api-key': 'wrong-key' } },
      { INTERNAL_API_SECRET: 'secret-123' } as never
    );
    expect(res.status).toBe(403);
  });

  it('allows correct api key', async () => {
    const res = await app.request(
      '/internal/status',
      { headers: { 'x-internal-api-key': 'secret-123' } },
      { INTERNAL_API_SECRET: 'secret-123' } as never
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
  });
});
