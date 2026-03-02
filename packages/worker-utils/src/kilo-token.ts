import { jwtVerify } from 'jose';
import { z } from 'zod';
import type { MiddlewareHandler } from 'hono';
import { extractBearerToken } from './extract-bearer-token.js';

export const kiloTokenPayload = z
  .object({
    version: z.literal(3),
    kiloUserId: z.string().min(1),
  })
  .passthrough();

export type KiloTokenPayload = z.infer<typeof kiloTokenPayload>;

/**
 * Verify a Kilo user JWT (HS256, version 3).
 *
 * Checks: signature, expiration (built into jose), version === 3, and that
 * kiloUserId is a non-empty string. Uses .passthrough() so worker-specific
 * claims (e.g. apiTokenPepper, organizationId) are preserved in the result.
 *
 * @throws if the token is invalid, expired, or fails schema validation.
 */
export async function verifyKiloToken(token: string, secret: string): Promise<KiloTokenPayload> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
  });

  return kiloTokenPayload.parse(payload);
}

type KiloTokenEnv = {
  Bindings: Record<never, never>;
  Variables: { kiloUserId: string; kiloTokenPayload: KiloTokenPayload };
};

/**
 * Hono middleware that extracts + verifies a Kilo user token from the
 * `Authorization: Bearer` header and sets `kiloUserId` and `kiloTokenPayload`
 * on the Hono context.
 *
 * @param getSecret - Callback to retrieve the NEXTAUTH_SECRET from the context.
 */
export function kiloTokenAuthMiddleware(
  getSecret: (c: Parameters<MiddlewareHandler<KiloTokenEnv>>[0]) => string | Promise<string>
): MiddlewareHandler<KiloTokenEnv> {
  return async (c, next) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) {
      return c.json({ success: false, error: 'Missing or malformed Authorization header' }, 401);
    }

    const secret = await getSecret(c);

    let payload: KiloTokenPayload;
    try {
      payload = await verifyKiloToken(token, secret);
    } catch {
      return c.json({ success: false, error: 'Invalid or expired token' }, 401);
    }

    c.set('kiloUserId', payload.kiloUserId);
    c.set('kiloTokenPayload', payload);
    return next();
  };
}
