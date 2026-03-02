import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../types/hono';

export const requestTimingMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  c.set('requestStartedAt', performance.now());
  await next();
});
