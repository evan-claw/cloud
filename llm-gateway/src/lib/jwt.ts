import { verifyKiloToken, extractBearerToken, type KiloTokenPayload } from '@kilocode/worker-utils';
import { timingSafeEqual } from '@kilocode/encryption';

export { extractBearerToken };
export type { KiloTokenPayload };

export type JWTVerifyResult =
  | { ok: true; payload: KiloTokenPayload }
  | { ok: false; reason: 'invalid' | 'expired' | 'version' };

export async function verifyGatewayJwt(token: string, secret: string): Promise<JWTVerifyResult> {
  try {
    const payload = await verifyKiloToken(token, secret);
    return { ok: true, payload };
  } catch (err) {
    if (err instanceof Error) {
      // jose uses error.code for JWT-specific errors
      if ((err as { code?: string }).code === 'ERR_JWT_EXPIRED') {
        return { ok: false, reason: 'expired' };
      }
      if (err.name === 'ZodError') return { ok: false, reason: 'version' };
    }
    return { ok: false, reason: 'invalid' };
  }
}

// Returns true when the JWT pepper matches the DB pepper.
// If the DB user has no pepper set, any token is accepted.
export function isPepperValid(
  jwtPepper: string | null | undefined,
  dbPepper: string | null
): boolean {
  if (!dbPepper) return true;
  if (!jwtPepper) return false;
  return timingSafeEqual(jwtPepper, dbPepper);
}
