import { createMiddleware } from 'hono/factory';
import {
  verifyKiloToken,
  extractBearerToken,
  UserNotFoundError,
  TokenRevokedError,
  JwtVerificationError,
} from '@kilocode/worker-utils';
import { getWorkerDb } from '@kilocode/db/client';

import type { Env } from '../env';

export const kiloJwtAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: {
    user_id: string;
  };
}>(async (c, next) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json({ success: false, error: 'Missing or malformed Authorization header' }, 401);
  }

  const secret = await c.env.NEXTAUTH_SECRET_PROD.get();
  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);

  let kiloUserId: string;
  try {
    const payload = await verifyKiloToken(token, secret, db);
    kiloUserId = payload.kiloUserId;
  } catch (err) {
    if (err instanceof UserNotFoundError) {
      return c.json({ success: false, error: 'User account not found' }, 403);
    }
    if (err instanceof TokenRevokedError) {
      return c.json({ success: false, error: 'Token has been revoked' }, 401);
    }
    if (err instanceof JwtVerificationError) {
      return c.json({ success: false, error: 'Invalid or expired token' }, 401);
    }
    // DB connectivity errors — rethrow for Hono error handler → 500
    throw err;
  }

  c.set('user_id', kiloUserId);
  return next();
});
