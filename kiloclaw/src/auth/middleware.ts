import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { timingSafeEqual } from '@kilocode/encryption';
import type { AppEnv } from '../types';
import { KILOCLAW_AUTH_COOKIE } from '../config';
import { validateKiloToken } from './jwt';
import { getWorkerDb } from '../db';

/**
 * Auth middleware for user-facing routes.
 *
 * 1. Extract JWT from Authorization: Bearer header
 * 2. Fallback: extract from kilo-worker-auth cookie
 * 3. Get Hyperdrive DB connection
 * 4. Verify HS256 with NEXTAUTH_SECRET; check version, env, and pepper via DB
 * 5. Set ctx.userId, ctx.authToken on context
 */
export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const secret = c.env.NEXTAUTH_SECRET;
  if (!secret) {
    console.error('[auth] NEXTAUTH_SECRET not configured');
    return c.json({ error: 'Server configuration error' }, 500);
  }

  if (!c.env.HYPERDRIVE?.connectionString) {
    console.error('[auth] HYPERDRIVE not configured -- cannot validate token pepper');
    return c.json({ error: 'Server configuration error' }, 500);
  }

  // Extract token: Bearer header first, then cookie fallback
  let token: string | undefined;
  const authHeader = c.req.header('authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    token = authHeader.substring(7);
  }
  if (!token) {
    token = getCookie(c, KILOCLAW_AUTH_COOKIE);
  }

  if (!token) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);

  let result: Awaited<ReturnType<typeof validateKiloToken>>;
  try {
    result = await validateKiloToken(token, secret, c.env.WORKER_ENV, db);
  } catch (err) {
    console.error('[auth] Authentication service error:', err);
    return c.json({ error: 'Authentication service unavailable' }, 500);
  }

  if (!result.success) {
    console.warn('[auth] Token validation failed:', result.error);
    return c.json({ error: 'Authentication failed' }, 401);
  }

  c.set('userId', result.userId);
  c.set('authToken', result.token);

  return next();
}

/**
 * Internal API middleware for backend-to-backend routes (platform API).
 *
 * 1. Check x-internal-api-key header against INTERNAL_API_SECRET
 * 2. Applied INSTEAD of authMiddleware (not stacked on top)
 * 3. userId comes from the request body, not from a JWT
 * 4. Users cannot call these routes even with a valid JWT
 */
export async function internalApiMiddleware(c: Context<AppEnv>, next: Next) {
  const secret = c.env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error('[auth] INTERNAL_API_SECRET not configured');
    return c.json({ error: 'Server configuration error' }, 500);
  }

  const apiKey = c.req.header('x-internal-api-key');
  if (!apiKey) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (!timingSafeEqual(apiKey, secret)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  return next();
}
