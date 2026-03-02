import { TRPCError } from '@trpc/server';
import jwt from 'jsonwebtoken';
import {
  verifyKiloToken,
  extractBearerToken,
  UserNotFoundError,
  TokenRevokedError,
  JwtVerificationError,
} from '@kilocode/worker-utils';
import { getWorkerDb } from '@kilocode/db/client';
import type { WorkerDb } from '@kilocode/db/client';
import type { Env } from './types.js';
import { logger } from './logger.js';

/**
 * Get a WorkerDb from the HYPERDRIVE binding, failing fast with a clear error
 * if the binding is not configured.
 */
export function requireDb(env: Env): WorkerDb {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    throw new Error('HYPERDRIVE not configured — cannot validate token pepper');
  }
  return getWorkerDb(connectionString);
}

type StreamTicketPayload = {
  type: 'stream_ticket';
  userId?: string;
  kiloSessionId?: string;
  cloudAgentSessionId?: string;
  sessionId?: string;
  organizationId?: string;
  nonce?: string;
};

export async function validateKiloToken(
  authHeader: string | null,
  secret: string,
  db: WorkerDb
): Promise<
  | { success: true; userId: string; token: string; botId?: string }
  | { success: false; error: string }
> {
  const token = extractBearerToken(authHeader);
  if (!token) {
    return { success: false, error: 'Missing or malformed Authorization header' };
  }

  try {
    const payload = await verifyKiloToken(token, secret, db);
    return { success: true, userId: payload.kiloUserId, token, botId: payload.botId };
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
}

export function validateStreamTicket(
  ticket: string | null,
  secret: string
): { success: true; payload: StreamTicketPayload } | { success: false; error: string } {
  if (!ticket) {
    return { success: false, error: 'Missing stream ticket' };
  }

  try {
    const payload = jwt.verify(ticket, secret, {
      algorithms: ['HS256'],
    }) as StreamTicketPayload;

    if (payload.type !== 'stream_ticket') {
      return { success: false, error: 'Invalid ticket type' };
    }

    return { success: true, payload };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { success: false, error: 'Ticket expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return { success: false, error: 'Invalid ticket signature' };
    }
    return { success: false, error: 'Ticket validation failed' };
  }
}

type SafeValidateResult =
  | { success: true; userId: string; token: string; botId?: string }
  | { success: false; error: string; status: 401 }
  | { success: false; error: string; status: 500 };

/**
 * Combines requireDb + validateKiloToken with infrastructure error handling.
 * Returns a status field so callers can distinguish auth failures (401) from
 * server errors (500) without needing their own try/catch.
 */
export async function safeValidateKiloToken(
  authHeader: string | null,
  env: Env
): Promise<SafeValidateResult> {
  let db: WorkerDb;
  try {
    db = requireDb(env);
  } catch (err) {
    logger
      .withFields({ error: err instanceof Error ? err.message : String(err) })
      .error('HYPERDRIVE not configured');
    return { success: false, error: 'Authentication service unavailable', status: 500 };
  }
  try {
    const result = await validateKiloToken(authHeader, env.NEXTAUTH_SECRET, db);
    if (!result.success) {
      return { ...result, status: 401 };
    }
    return result;
  } catch (err) {
    logger
      .withFields({ error: err instanceof Error ? err.message : String(err) })
      .error('Authentication service error');
    return { success: false, error: 'Authentication service unavailable', status: 500 };
  }
}

/**
 * Validates JWT token and extracts user ID for tRPC context
 * @throws {TRPCError} If authentication fails
 */
export async function authenticate(
  request: Request,
  env: Env
): Promise<{ userId: string; token: string; botId?: string }> {
  const authHeader = request.headers.get('authorization');
  const db = requireDb(env);

  const result = await validateKiloToken(authHeader, env.NEXTAUTH_SECRET, db);

  if (!result.success) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: result.error,
    });
  }

  return { userId: result.userId, token: result.token, botId: result.botId };
}
