import { createMiddleware } from 'hono/factory';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';

import type { Env } from '../env';
import { getDb } from '../db/drizzle';

type TokenPayloadV3 = {
  kiloUserId: string;
  version: number;
};

function isTokenPayloadV3(payload: unknown): payload is TokenPayloadV3 {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const p = payload as Record<string, unknown>;
  return typeof p.kiloUserId === 'string' && p.kiloUserId.length > 0 && p.version === 3;
}

const USER_EXISTS_TTL_SECONDS = 24 * 60 * 60; // 24h
const USER_NOT_FOUND_TTL_SECONDS = 5 * 60; // 5m

/**
 * Check whether a user exists, using KV as a cache in front of Postgres.
 * Positive results are cached for 24h. Negative results are cached for 5m
 * to rate-limit DB hits from deleted/nonexistent users with valid tokens.
 */
async function userExists(env: Env, userId: string): Promise<boolean> {
  const cacheKey = `user-exists:${userId}`;

  const cached = await env.USER_EXISTS_CACHE.get(cacheKey);
  if (cached === '1') {
    return true;
  }
  if (cached === '0') {
    return false;
  }

  const db = getDb(env.HYPERDRIVE);
  const rows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  const row = rows[0];

  if (!row) {
    void env.USER_EXISTS_CACHE.put(cacheKey, '0', { expirationTtl: USER_NOT_FOUND_TTL_SECONDS });
    return false;
  }

  void env.USER_EXISTS_CACHE.put(cacheKey, '1', { expirationTtl: USER_EXISTS_TTL_SECONDS });
  return true;
}

export const kiloJwtAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: {
    user_id: string;
  };
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization') ?? c.req.header('authorization');
  if (!authHeader) {
    return c.json({ success: false, error: 'Missing Authorization header' }, 401);
  }

  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return c.json({ success: false, error: 'Invalid Authorization header format' }, 401);
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return c.json({ success: false, error: 'Missing token' }, 401);
  }

  const secret = await c.env.NEXTAUTH_SECRET_PROD.get();

  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (!isTokenPayloadV3(payload)) {
      return c.json({ success: false, error: 'Invalid token payload' }, 401);
    }

    const exists = await userExists(c.env, payload.kiloUserId);
    if (!exists) {
      return c.json({ success: false, error: 'User account not found' }, 403);
    }

    c.set('user_id', payload.kiloUserId);
    await next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return c.json({ success: false, error: 'Token expired' }, 401);
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return c.json({ success: false, error: 'Invalid token signature' }, 401);
    }
    return c.json({ success: false, error: 'Token validation failed' }, 401);
  }
});
