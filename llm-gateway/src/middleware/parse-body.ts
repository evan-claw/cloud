import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../types/hono';
import { validateFeatureHeader, FEATURE_HEADER } from '../lib/feature-detection';
import type { OpenRouterChatCompletionRequest } from '../types/request';

export const parseBodyMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  let body: OpenRouterChatCompletionRequest;
  try {
    body = await c.req.json<OpenRouterChatCompletionRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // OpenRouter-specific field that we do not support
  delete body.models;

  if (typeof body.model !== 'string' || body.model.trim().length === 0) {
    return c.json({ error: 'model is required' }, 400);
  }

  // Ensure usage is always returned so background accounting can parse it
  body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };

  const feature = validateFeatureHeader(c.req.header(FEATURE_HEADER) ?? null);
  const resolvedModel = body.model.trim().toLowerCase();

  c.set('requestBody', body);
  c.set('resolvedModel', resolvedModel);
  c.set('feature', feature);

  await next();
});
