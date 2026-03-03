import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../types/hono';
import { isAnonymousContext } from '../lib/anonymous';
import { checkPromotionLimit } from '../lib/rate-limit';

const PROMOTION_MODEL_LIMIT_REACHED = 'PROMOTION_MODEL_LIMIT_REACHED';

// Anonymous users are limited to PROMOTION_MAX_REQUESTS per 24h window.
// Authenticated users skip this check entirely.
export const promotionLimitMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const user = c.get('user');
  if (!isAnonymousContext(user)) {
    return next();
  }

  const result = await checkPromotionLimit(c.env, c.get('clientIp'));
  if (!result.allowed) {
    return c.json(
      {
        error: {
          code: PROMOTION_MODEL_LIMIT_REACHED,
          message:
            'Sign up for free to continue and explore 500 other models. ' +
            'Takes 2 minutes, no credit card required. Or come back later.',
        },
      },
      401
    );
  }

  return next();
});
