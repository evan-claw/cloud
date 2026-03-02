import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { UserNotFoundError, TokenRevokedError } from '@kilocode/worker-utils';
import type * as WorkerUtilsModule from '@kilocode/worker-utils';

import { kiloJwtAuthMiddleware } from './kilo-jwt-auth';

vi.mock('@kilocode/db/client', () => ({
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

type TestEnv = {
  NEXTAUTH_SECRET_PROD: {
    get: () => Promise<string>;
  };
  HYPERDRIVE: {
    connectionString: string;
  };
};

function makeEnv(secret: string): TestEnv {
  return {
    NEXTAUTH_SECRET_PROD: {
      get: async () => secret,
    },
    HYPERDRIVE: { connectionString: 'postgresql://fake' },
  };
}

async function sign(payload: Record<string, unknown>, secret: string): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
}

describe('kiloJwtAuthMiddleware', () => {
  it('rejects missing Authorization header', async () => {
    const app = new Hono<{ Bindings: TestEnv; Variables: { user_id: string } }>();
    app.use('/api/*', kiloJwtAuthMiddleware);
    app.get('/api/me', c => c.json({ user_id: c.get('user_id') }));

    const res = await app.fetch(new Request('http://local/api/me'), makeEnv('secret'));
    expect(res.status).toBe(401);
  });

  it('accepts valid v3 token when pepper matches', async () => {
    const secret = 'test-secret';
    const token = await sign({ kiloUserId: 'usr_123', version: 3 }, secret);
    vi.mocked(verifyKiloToken).mockResolvedValueOnce({
      version: 3,
      kiloUserId: 'usr_123',
    });

    const app = new Hono<{ Bindings: TestEnv; Variables: { user_id: string } }>();
    app.use('/api/*', kiloJwtAuthMiddleware);
    app.get('/api/me', c => c.json({ user_id: c.get('user_id') }));

    const res = await app.fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(secret)
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'usr_123' });
  });

  it('returns 403 when user not found (UserNotFoundError)', async () => {
    const secret = 'test-secret';
    const token = await sign({ kiloUserId: 'deleted_user', version: 3 }, secret);
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(new UserNotFoundError('deleted_user'));

    const app = new Hono<{ Bindings: TestEnv; Variables: { user_id: string } }>();
    app.use('/api/*', kiloJwtAuthMiddleware);
    app.get('/api/me', c => c.json({ user_id: c.get('user_id') }));

    const res = await app.fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(secret)
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: 'User account not found' });
  });

  it('returns 401 when token is revoked (TokenRevokedError)', async () => {
    const secret = 'test-secret';
    const token = await sign({ kiloUserId: 'usr_123', version: 3 }, secret);
    vi.mocked(verifyKiloToken).mockRejectedValueOnce(new TokenRevokedError('usr_123'));

    const app = new Hono<{ Bindings: TestEnv; Variables: { user_id: string } }>();
    app.use('/api/*', kiloJwtAuthMiddleware);
    app.get('/api/me', c => c.json({ user_id: c.get('user_id') }));

    const res = await app.fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(secret)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Invalid or expired token' });
  });
});
