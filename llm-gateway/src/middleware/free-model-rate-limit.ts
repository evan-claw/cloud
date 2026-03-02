import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../types/hono';
import { isKiloFreeModel } from '../lib/models';
import { checkFreeModelRateLimit } from '../lib/rate-limit';

const RATE_LIMITED = 'FREE_MODEL_RATE_LIMITED';

// Applies to ALL requests for Kilo-hosted free models (both anonymous and authenticated).
export const freeModelRateLimitMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  if (!isKiloFreeModel(c.get('resolvedModel'))) {
    return next();
  }

  const result = await checkFreeModelRateLimit(c.env.RATE_LIMIT_KV, c.get('clientIp'));
  if (!result.allowed) {
    return c.json(
      {
        error: {
          code: RATE_LIMITED,
          message: 'Too many requests. Please try again later.',
          requestCount: result.requestCount,
        },
      },
      429
    );
  }

  return next();
});
