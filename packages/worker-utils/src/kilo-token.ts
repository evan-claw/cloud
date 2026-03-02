import { jwtVerify } from 'jose';
import { z } from 'zod';

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
