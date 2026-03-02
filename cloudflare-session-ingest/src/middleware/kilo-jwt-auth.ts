import { createMiddleware } from 'hono/factory';
import { verifyKiloToken, extractBearerToken, userExistsWithCache } from '@kilocode/worker-utils';
import { getWorkerDb } from '@kilocode/db/client';

import type { Env } from '../env';

function userExists(env: Env, userId: string): Promise<boolean> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  return userExistsWithCache(env.USER_EXISTS_CACHE, db, userId);
}

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

  let kiloUserId: string;
  try {
    const payload = await verifyKiloToken(token, secret);
    kiloUserId = payload.kiloUserId;
  } catch {
    return c.json({ success: false, error: 'Invalid or expired token' }, 401);
  }

  const exists = await userExists(c.env, kiloUserId);
  if (!exists) {
    return c.json({ success: false, error: 'User account not found' }, 403);
  }

  c.set('user_id', kiloUserId);
  return next();
});
