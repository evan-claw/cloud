import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../types/hono';
import { isAnonymousContext } from '../lib/anonymous';
import { checkPromotionLimit } from '../lib/rate-limit';

const PROMOTION_LIMIT_EXCEEDED = 'PROMOTION_LIMIT_EXCEEDED';

// Anonymous users are limited to PROMOTION_MAX_REQUESTS per 24h window.
// Authenticated users skip this check entirely.
export const promotionLimitMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const user = c.get('user');
  if (!isAnonymousContext(user)) {
    return next();
  }

  const result = await checkPromotionLimit(c.env.RATE_LIMIT_KV, c.get('clientIp'));
  if (!result.allowed) {
    return c.json(
      {
        error: {
          code: PROMOTION_LIMIT_EXCEEDED,
          message: 'You have reached the free usage limit. Sign up for more.',
          requestCount: result.requestCount,
        },
      },
      401
    );
  }

  return next();
});
