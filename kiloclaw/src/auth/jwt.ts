import { SignJWT } from 'jose';
import {
  verifyKiloToken,
  UserNotFoundError,
  TokenRevokedError,
  JwtVerificationError,
} from '@kilocode/worker-utils';
import type { WorkerDb } from '@kilocode/db/client';
import { KILO_TOKEN_VERSION, KILOCLAW_AUTH_COOKIE_MAX_AGE } from '../config';

export type ValidateResult =
  | { success: true; userId: string; token: string }
  | { success: false; error: string };

/**
 * Verify a Kilo JWT using HS256 symmetric secret, checking pepper against DB.
 *
 * Checks: signature, expiration (built into jose), version === 3 (via shared schema),
 * optional env match against the worker's WORKER_ENV, and apiTokenPepper against DB.
 *
 * UserNotFoundError and TokenRevokedError are mapped to { success: false }.
 * DB connectivity errors propagate uncaught for 500 handling in middleware.
 */
export async function validateKiloToken(
  token: string,
  secret: string,
  expectedEnv: string | undefined,
  db: WorkerDb
): Promise<ValidateResult> {
  let payload: Awaited<ReturnType<typeof verifyKiloToken>>;
  try {
    payload = await verifyKiloToken(token, secret, db);
  } catch (err) {
    if (
      err instanceof JwtVerificationError ||
      err instanceof UserNotFoundError ||
      err instanceof TokenRevokedError
    ) {
      return { success: false, error: err.message };
    }
    // DB connectivity errors — rethrow for caller to handle as 500
    throw err;
  }

  if (expectedEnv && payload.env && payload.env !== expectedEnv) {
    return { success: false, error: 'Invalid token' };
  }

  return {
    success: true,
    userId: payload.kiloUserId,
    token,
  };
}

/**
 * Sign a 24-hour JWT for setting as a worker-domain cookie after access code redemption.
 * Same payload shape as the cloud-issued tokens so authMiddleware validates them identically.
 */
export async function signKiloToken(params: {
  userId: string;
  pepper: string | null;
  secret: string;
  env?: string;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    kiloUserId: params.userId,
    apiTokenPepper: params.pepper,
    version: KILO_TOKEN_VERSION,
  };
  if (params.env) {
    payload.env = params.env;
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(`${KILOCLAW_AUTH_COOKIE_MAX_AGE}s`)
    .setIssuedAt()
    .sign(new TextEncoder().encode(params.secret));
}
