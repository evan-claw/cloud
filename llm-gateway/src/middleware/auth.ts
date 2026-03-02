import { createMiddleware } from 'hono/factory';
import { eq } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import type { HonoContext } from '../types/hono';
import { extractBearerToken, userExistsWithCache } from '@kilocode/worker-utils';
import { verifyGatewayJwt, isPepperValid } from '../lib/jwt';

const ORGANIZATION_ID_HEADER = 'x-kilocode-organizationid';

export const authMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const token = extractBearerToken(c.req.header('Authorization') ?? c.req.header('authorization'));

  if (!token) {
    // No token — let anonymous-gate decide
    return next();
  }

  const secret = await c.env.NEXTAUTH_SECRET_PROD.get();
  const verifyResult = await verifyGatewayJwt(token, secret);

  if (!verifyResult.ok) {
    // Invalid / expired / wrong version — let anonymous-gate decide
    return next();
  }

  const { payload } = verifyResult;
  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);

  const exists = await userExistsWithCache(c.env.USER_EXISTS_CACHE, db, payload.kiloUserId);
  if (!exists) {
    return next();
  }

  const rows = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, payload.kiloUserId))
    .limit(1);
  const user = rows[0];

  if (!user) {
    return next();
  }

  if (!isPepperValid(payload.apiTokenPepper, user.api_token_pepper)) {
    // Token has been revoked — treat as unauthenticated
    return next();
  }

  c.set('authUser', user);
  c.set('organizationId', c.req.header(ORGANIZATION_ID_HEADER) ?? undefined);
  c.set('botId', payload.botId);
  c.set('tokenSource', payload.tokenSource);

  return next();
});
