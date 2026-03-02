import { jwtVerify } from 'jose';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { WorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';

/**
 * All known fields that can appear in a Kilo user JWT, sourced from
 * generateApiToken() / generateOrganizationApiToken() in src/lib/tokens.ts.
 * All optional fields beyond version+kiloUserId default to undefined when absent.
 */
export const kiloTokenPayload = z.object({
  // Core — always present
  version: z.literal(3),
  kiloUserId: z.string().min(1),
  // Present in generateApiToken / generateOrganizationApiToken, absent in generateInternalServiceToken
  apiTokenPepper: z.string().nullable().optional(),
  env: z.string().optional(),
  // Optional extras from JWTTokenExtraPayload
  botId: z.string().optional(),
  organizationId: z.string().optional(),
  organizationRole: z.enum(['owner', 'member', 'billing_manager']).optional(),
  internalApiUse: z.boolean().optional(),
  createdOnPlatform: z.string().optional(),
  tokenSource: z.string().optional(),
  deviceAuthRequestCode: z.string().optional(),
  // Standard JWT claims
  iat: z.number().optional(),
  exp: z.number().optional(),
});

export type KiloTokenPayload = z.infer<typeof kiloTokenPayload>;

export class UserNotFoundError extends Error {
  userId: string;
  constructor(userId: string) {
    super(`User not found: ${userId}`);
    this.userId = userId;
  }
}

export class TokenRevokedError extends Error {
  userId: string;
  constructor(userId: string) {
    super(`Token revoked for user: ${userId}`);
    this.userId = userId;
  }
}

/**
 * Wraps JWT signature/schema errors so callers can distinguish them from DB
 * connectivity errors (which propagate as-is).
 */
export class JwtVerificationError extends Error {
  cause: unknown;
  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.cause = cause;
  }
}

/**
 * Look up the api_token_pepper for a user. Exported as a standalone helper
 * so tests can spy on it without faking drizzle internals.
 *
 * @throws {UserNotFoundError} if no row exists for userId
 */
export async function lookupPepper(db: WorkerDb, userId: string): Promise<string | null> {
  const row = await db
    .select({ api_token_pepper: kilocode_users.api_token_pepper })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1)
    .then(rows => rows[0] ?? null);

  if (!row) {
    throw new UserNotFoundError(userId);
  }

  return row.api_token_pepper ?? null;
}

/**
 * Verify a Kilo user JWT (HS256, version 3) and validate the pepper against
 * the database.
 *
 * Checks: signature, expiration (built into jose), version === 3, and that
 * kiloUserId is a non-empty string. Then verifies apiTokenPepper matches the
 * DB value.
 *
 * @throws if the token is invalid, expired, or fails schema validation.
 * @throws {UserNotFoundError} if the user doesn't exist in the DB.
 * @throws {TokenRevokedError} if the pepper doesn't match.
 * DB connectivity errors propagate uncaught.
 */
export async function verifyKiloToken(
  token: string,
  secret: string,
  db: WorkerDb
): Promise<KiloTokenPayload> {
  let parsed: KiloTokenPayload;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    });
    parsed = kiloTokenPayload.parse(payload);
  } catch (err) {
    throw new JwtVerificationError(err);
  }

  const dbPepper = await lookupPepper(db, parsed.kiloUserId);
  const jwtPepper = parsed.apiTokenPepper ?? null;

  if (jwtPepper !== dbPepper) {
    throw new TokenRevokedError(parsed.kiloUserId);
  }

  return parsed;
}
