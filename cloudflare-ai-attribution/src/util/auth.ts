import { createMiddleware } from 'hono/factory';
import {
  verifyKiloToken,
  extractBearerToken,
  UserNotFoundError,
  TokenRevokedError,
} from '@kilocode/worker-utils';
import { getWorkerDb } from '@kilocode/db/client';
import type { WorkerDb } from '@kilocode/db/client';
import { logger } from './logger';
import type { HonoContext } from '../ai-attribution.worker';
import { OrganizationJWTPayload } from '../schemas';

/**
 * Validates a Kilo API JWT token, asserting it carries organization claims.
 */
export async function validateKiloToken(
  authHeader: string | null,
  secret: string,
  db: WorkerDb
): Promise<
  | ({ success: true; token: string } & Pick<
      OrganizationJWTPayload,
      'organizationId' | 'organizationRole' | 'kiloUserId'
    >)
  | { success: false; error: string }
> {
  const token = extractBearerToken(authHeader);
  if (!token) {
    return { success: false, error: 'Missing or malformed Authorization header' };
  }

  try {
    const raw = await verifyKiloToken(token, secret, db);
    const payload = OrganizationJWTPayload.parse(raw);

    return {
      success: true,
      kiloUserId: payload.kiloUserId,
      token,
      organizationId: payload.organizationId,
      organizationRole: payload.organizationRole,
    };
  } catch (err) {
    if (err instanceof UserNotFoundError || err instanceof TokenRevokedError) {
      return { success: false, error: err.message };
    }
    return { success: false, error: 'Invalid or expired token' };
  }
}

/**
 * Hono middleware for authenticating requests with Kilo API tokens
 */
export const authMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const result = await validateKiloToken(
    c.req.header('Authorization') ?? null,
    await c.env.NEXTAUTH_SECRET.get(),
    db
  );

  if (!result.success) {
    logger.warn('Authentication failed', { error: result.error });
    return c.json({ success: false, error: result.error }, 401);
  }

  c.set('user_id', result.kiloUserId);
  c.set('token', result.token);
  c.set('organization_id', result.organizationId);
  c.set('organization_role', result.organizationRole);

  logger.info('Request authenticated', {
    userId: result.kiloUserId,
    organizationId: result.organizationId,
    organizationRole: result.organizationRole,
  });

  return next();
});
