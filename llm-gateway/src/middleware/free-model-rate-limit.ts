import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../types/hono';
import { isKiloFreeModel } from '../lib/models';
import { checkFreeModelRateLimit } from '../lib/rate-limit';

// Applies to ALL requests for Kilo-hosted free models (both anonymous and authenticated).
export const freeModelRateLimitMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  if (!isKiloFreeModel(c.get('resolvedModel'))) {
    return next();
  }

  const result = await checkFreeModelRateLimit(c.env, c.get('clientIp'));
  if (!result.allowed) {
    return c.json(
      {
        error: 'Rate limit exceeded',
        message:
          'Free model usage limit reached. Please try again later or upgrade to a paid model.',
      },
      429
    );
  }

  return next();
});
