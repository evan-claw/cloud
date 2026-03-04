import { createMiddleware } from 'hono/factory';
import { getWorkerDb } from '@kilocode/db/client';
import type { HonoContext } from '../types/hono';

// Creates the drizzle db instance once per request and stores it on context.
// Hyperdrive handles actual connection pooling — this avoids re-creating the
// pg.Pool + drizzle wrapper on every c.get('db') call.
export const dbMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  c.set('db', getWorkerDb(c.env.HYPERDRIVE.connectionString));
  return next();
});
