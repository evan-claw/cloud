import jwt from 'jsonwebtoken';

export const JWT_TOKEN_VERSION = 3;

// Full JWT payload shape — mirrors src/lib/tokens.ts JWTTokenPayload + JWTTokenExtraPayload.
export type JWTPayload = {
  kiloUserId: string;
  version: number;
  apiTokenPepper?: string;
  botId?: string;
  organizationId?: string;
  organizationRole?: string;
  internalApiUse?: boolean;
  createdOnPlatform?: string;
  tokenSource?: string;
};

function isJWTPayload(payload: unknown): payload is JWTPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.kiloUserId === 'string' && p.kiloUserId.length > 0 && p.version === JWT_TOKEN_VERSION
  );
}

export type JWTVerifyResult =
  | { ok: true; payload: JWTPayload }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'version' };

export function verifyKiloJwt(token: string, secret: string): JWTVerifyResult {
  try {
    const raw = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (!isJWTPayload(raw)) {
      return { ok: false, reason: 'version' };
    }
    return { ok: true, payload: raw };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  if (!authHeader.toLowerCase().startsWith('bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}
