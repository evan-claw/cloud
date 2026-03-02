import { createMiddleware } from 'hono/factory';
import type { Context, Next } from 'hono';
import type { HonoContext } from '../hono-context.js';
import { validateKiloToken } from '../auth.js';
import { logger } from '../logger.js';
import { buildTrpcErrorResponse } from '../trpc-error.js';
import { extractProcedureName } from '../balance-validation.js';
import { getWorkerDb } from '@kilocode/db/client';

export const authMiddleware = createMiddleware<HonoContext>(
  async (c: Context<HonoContext>, next: Next) => {
    if (!c.env.HYPERDRIVE?.connectionString) {
      logger.error('HYPERDRIVE not configured — cannot validate token pepper');
      return buildTrpcErrorResponse(500, 'Server configuration error');
    }

    const authHeader = c.req.header('authorization');
    const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);

    let result: Awaited<ReturnType<typeof validateKiloToken>>;
    try {
      result = await validateKiloToken(authHeader ?? null, c.env.NEXTAUTH_SECRET, db);
    } catch (err) {
      logger
        .withFields({ error: err instanceof Error ? err.message : String(err) })
        .error('Authentication service error');
      return buildTrpcErrorResponse(500, 'Authentication service unavailable');
    }

    if (!result.success) {
      logger.withFields({ error: result.error }).warn('Authentication failed');
      const procedureName = extractProcedureName(new URL(c.req.url).pathname) ?? undefined;
      return buildTrpcErrorResponse(401, result.error, procedureName);
    }

    c.set('userId', result.userId);
    c.set('authToken', result.token);
    if (result.botId) {
      c.set('botId', result.botId);
    }

    await next();
  }
);
