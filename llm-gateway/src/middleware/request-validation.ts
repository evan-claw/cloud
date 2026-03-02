// Request validation — checks max_tokens, dead free models, and rate-limited-to-death models.
// These checks happen after provider resolution but before balance/org checks.

import type { MiddlewareHandler } from 'hono';
import type { HonoContext } from '../types/hono';
import { isDeadFreeModel, isRateLimitedToDeath } from '../lib/models';

const MAX_TOKENS_LIMIT = 99_999_999_999;

export const requestValidationMiddleware: MiddlewareHandler<HonoContext> = async (c, next) => {
  const body = c.get('requestBody');
  const resolvedModel = c.get('resolvedModel');
  const user = c.get('user');

  if (body.max_tokens && body.max_tokens > MAX_TOKENS_LIMIT) {
    console.warn(`SECURITY: Max tokens limit exceeded: ${user.id}`, {
      maxTokens: body.max_tokens,
    });
    return c.json(
      {
        error: 'Service Unavailable',
        message: 'The service is temporarily unavailable. Please try again later.',
      },
      503
    );
  }

  if (isDeadFreeModel(resolvedModel)) {
    const error = 'The alpha period for this model has ended.';
    return c.json({ error, message: error }, 404);
  }

  if (isRateLimitedToDeath(resolvedModel)) {
    return c.json(
      {
        error: 'Model not found',
        message: 'The requested model could not be found.',
      },
      404
    );
  }

  await next();
};
