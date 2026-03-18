/**
 * Auto Fix Worker - Main Entry Point
 *
 * Handles HTTP requests to dispatch and manage auto-fix sessions
 */

import { Hono } from 'hono';
import type { Env, FixRequest, FixResponse } from './types';
import {
  withDORetry,
  backendAuthMiddleware,
  createErrorHandler,
  createNotFoundHandler,
} from '@kilocode/worker-utils';
import { AutoFixOrchestrator } from './fix-orchestrator';

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
    const body = await c.req.json<FixRequest>();

    // Validate required fields
    if (!body.ticketId || !body.authToken || !body.sessionInput || !body.owner) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    // Get or create Durable Object instance
    const id = c.env.AUTO_FIX_ORCHESTRATOR.idFromName(body.ticketId);

    // Initialize the fix session
    const result = await withDORetry(
      () => c.env.AUTO_FIX_ORCHESTRATOR.get(id),
      stub => stub.start(body),
      'start'
    );

    // Run the fix process asynchronously (fire-and-forget)
    c.executionCtx.waitUntil(
      withDORetry(
        () => c.env.AUTO_FIX_ORCHESTRATOR.get(id),
        stub => stub.runFix(),
        'runFix'
      ).catch((error: Error) => {
        console.error('[AutoFixWorker] runFix failed:', {
          ticketId: body.ticketId,
          error: error.message,
        });
      })
    );

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

    // Get status via RPC with retry
    const result = await withDORetry(
      () => c.env.AUTO_FIX_ORCHESTRATOR.get(id),
      stub => stub.getEvents(),
      'getEvents'
    );

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
