/**
 * Auto Fix Worker - Main Entry Point
 *
 * Handles HTTP requests to dispatch and manage auto-fix sessions
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, FixResponse, SessionInput } from './types';
import {
  backendAuthMiddleware,
  createErrorHandler,
  createNotFoundHandler,
} from '@kilocode/worker-utils';
import { AutoFixOrchestrator } from './fix-orchestrator';

const ownerSchema = z.object({
  type: z.enum(['user', 'org']),
  id: z.string(),
  userId: z.string(),
});

const fixDispatchSchema = z.object({
  ticketId: z.string(),
  authToken: z.string(),
  sessionInput: z.custom<SessionInput>(val => typeof val === 'object' && val !== null),
  owner: ownerSchema,
  triggerSource: z.enum(['label', 'review_comment']).optional(),
});

// Export the Durable Object class
export { AutoFixOrchestrator };

// Create Hono app with Env type
type HonoEnv = { Bindings: Env };
const app = new Hono<HonoEnv>();

// Authentication middleware
app.use(
  '*',
  backendAuthMiddleware<HonoEnv>(c => c.env.BACKEND_AUTH_TOKEN)
);

/**
 * Health check endpoint
 */
app.get('/health', c => {
  return c.json({ status: 'ok', service: 'auto-fix-worker' });
});

/**
 * Dispatch a new fix request
 * POST /fix/dispatch
 */
app.post('/fix/dispatch', async c => {
  try {
    const parsed = fixDispatchSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.format() }, 400);
    }
    const body = parsed.data;

    // Get or create Durable Object instance
    const id = c.env.AUTO_FIX_ORCHESTRATOR.idFromName(body.ticketId);
    const stub = c.env.AUTO_FIX_ORCHESTRATOR.get(id);

    // Initialize the fix session
    const result = await stub.start(body);

    // Run the fix process asynchronously
    c.executionCtx.waitUntil(stub.runFix());

    return c.json<FixResponse>({
      ticketId: body.ticketId,
      status: result.status as FixResponse['status'],
    });
  } catch (error) {
    console.error('[AutoFixWorker] Dispatch error:', error);
    return c.json(
      {
        error: 'Failed to dispatch fix',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});

/**
 * Get fix status
 * GET /fix/:ticketId/status
 */
app.get('/fix/:ticketId/status', async c => {
  try {
    const ticketId = c.req.param('ticketId');

    // Get Durable Object instance
    const id = c.env.AUTO_FIX_ORCHESTRATOR.idFromName(ticketId);
    const stub = c.env.AUTO_FIX_ORCHESTRATOR.get(id);

    // Get status (this would need to be implemented in the DO)
    const result = stub.getEvents();

    return c.json(result);
  } catch (error) {
    console.error('[AutoFixWorker] Status error:', error);
    return c.json(
      {
        error: 'Failed to get status',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});

/**
 * Cancel a fix
 * POST /fix/:ticketId/cancel
 */
app.post('/fix/:ticketId/cancel', async c => {
  try {
    const ticketId = c.req.param('ticketId');

    // TODO: cancel is not yet implemented in the DO
    return c.json({ ticketId, status: 'cancelled' });
  } catch (error) {
    console.error('[AutoFixWorker] Cancel error:', error);
    return c.json(
      {
        error: 'Failed to cancel fix',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});

/**
 * 404 handler
 */
app.notFound(createNotFoundHandler());

/**
 * Error handler
 */
app.onError(createErrorHandler());

export default app;
